import { supabase, isConfigured, IMAGE_BUCKET } from './supabase.js';
import {
  parseIngredientText, parseIngredientLine, formatQuantity, ingredientToLine, ingredientParts,
} from './ingredients.js';
import { suggestRecipes, STAPLES } from './pantry.js';
import {
  additionsFromPlan, findConflict, mergeInto, removeRecipe, removePlanEntry, recipesOnList, plannedIds, formatItemQuantity,
} from './shopping.js';
import { PRODUCE, MONTHS, seasonOf, inSeason, seasonalRecipes } from './season.js';
import { CATEGORIES, guessCategory, categoryKey, categoryRank } from './categories.js';
import { DEFAULT_PLACES, guessPlaces } from './places.js';
import { linkify } from './links.js';
import {
  videoOf, videosOf, videoKey, embedUrl, seekTo, stepText, stepTime, stepVideo,
  dropMissingTimes, makeStep, formatTime,
} from './video.js';
import {
  pairOf, alternativeIds, alternativeGroup, suggestAlternatives,
} from './alternatives.js';
import {
  ingredientsFromStep, remainingIngredients, ingredientKey, mentionsIngredient,
  scaleIngredient, combinedTitle, stepsForCombine, combinedImages,
} from './combine.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const tabbar = document.getElementById('tabbar');

let session = null;
let recipes = null; // Cache aller eigenen Rezepte
let listQuery = '';
let categories = null; // eigene Zutaten-Kategorien: Map Schlüssel → Kategorie; null = noch nicht geladen
let categoriesSaved = true; // false, solange kategorien.sql nicht ausgeführt wurde
let places = null; // eigene Einkaufsorte [{ id, name }]; null = noch nicht geladen
let placesTable = true; // false, solange orte.sql nicht ausgeführt wurde
let placesSaved = true; // false, solange ingredient_categories keine Spalte places hat
let myName; // Benutzername: undefined = noch nicht geladen, null = fehlt noch, false = benutzername.sql nicht eingerichtet
let links = null; // Alternativ-Verknüpfungen [{ recipe_a, recipe_b }]; null = noch nicht geladen
let linksTable = true; // false, solange alternativen.sql nicht ausgeführt wurde
let pendingNew = null; // Vorbelegung für ein neues Rezept, z. B. aus dem Kombinieren
let activeTag = null;
let listSort = 'name';
let recoveringPassword = false;

const collator = new Intl.Collator('de', { sensitivity: 'base' });

// ---------- Hilfsfunktionen ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const $ = (sel, root = app) => root.querySelector(sel);

function imageUrl(path) {
  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

function formatMinutes(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} Min.`;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

async function loadRecipes(force = false) {
  if (recipes && !force) return recipes;
  const { data, error } = await supabase.from('recipes').select('*').eq('owner_id', session.user.id);
  if (error) throw error;
  recipes = data.sort((a, b) => collator.compare(a.title, b.title));
  return recipes;
}

// ---------- Zutaten-Kategorien und Einkaufsorte ----------

// Alle Alternativ-Verknüpfungen, die ich sehen darf (eigene und die freigegebener Kochbücher).
async function loadAlternatives(force = false) {
  if (links && !force) return links;
  const { data, error } = await supabase.from('recipe_alternatives').select('recipe_a, recipe_b');
  if (error) {
    // Die Tabelle gibt es erst nach alternativen.sql.
    linksTable = false;
    links = [];
    return links;
  }
  linksTable = true;
  links = data;
  return links;
}

async function loadCategories() {
  if (categories) return categories;
  let { data, error } = await supabase.from('ingredient_categories').select('key, category, places');
  placesSaved = !error;
  // Ohne orte.sql gibt es die Spalte places noch nicht.
  if (error) ({ data, error } = await supabase.from('ingredient_categories').select('key, category'));
  categoriesSaved = !error;
  categories = new Map((data ?? []).map((c) => [c.key, { category: c.category, places: c.places ?? null }]));
  await loadPlaces();
  return categories;
}

// Eigene Einkaufsorte; wer noch keine hat, bekommt die Standard-Orte.
async function loadPlaces() {
  if (places) return places;
  const { data, error } = await supabase.from('shopping_places').select('id, name, position').order('position');
  placesTable = !error;
  places = data?.length ? data.map(({ id, name }) => ({ id, name })) : DEFAULT_PLACES.map((p) => ({ ...p }));
  if (placesTable && !data.length) {
    const { error: e } = await supabase.from('shopping_places').insert(places.map((p, i) => ({ ...p, position: i })));
    if (e) console.warn(e);
  }
  return places;
}

const placeIds = () => (places ?? DEFAULT_PLACES).map((p) => p.id);
const placeName = (id) => (places ?? DEFAULT_PLACES).find((p) => p.id === id)?.name;

// Eigene Kategorie einer Zutat, sonst ein Vorschlag anhand des Namens.
function categoryOf(name) {
  return categories?.get(categoryKey(name))?.category ?? guessCategory(name);
}

// Eigene Orte einer Zutat (nur solche, die es noch gibt), sonst ein Vorschlag.
function placesOf(name) {
  const saved = categories?.get(categoryKey(name))?.places;
  const ids = placeIds();
  return saved ? saved.filter((id) => ids.includes(id)) : guessPlaces(name, categoryOf(name), ids);
}

// Merkt sich für Zutaten, die zum ersten Mal vorkommen, die vorgeschlagene Kategorie und die
// vorgeschlagenen Orte. Bereits vorhandene eigene Zuordnungen bleiben unverändert.
async function rememberCategories(names) {
  await loadCategories();
  const rows = new Map();
  const missingPlaces = new Map(); // schon bekannte Zutaten ohne Orte (von vor orte.sql)
  for (const name of names) {
    const key = categoryKey(name);
    if (!key || rows.has(key) || missingPlaces.has(key)) continue;
    const known = categories.get(key);
    if (!known) rows.set(key, { key, category: guessCategory(name), places: placesOf(name) });
    else if (!known.places && placesSaved) missingPlaces.set(key, { key, category: known.category, places: placesOf(name) });
  }
  [...rows.values(), ...missingPlaces.values()].forEach((row) => categories.set(row.key, { category: row.category, places: row.places }));
  if (!categoriesSaved) return;
  const strip = (list) => (placesSaved ? list : list.map(({ places: _, ...row }) => row));
  if (rows.size) {
    const { error } = await supabase.from('ingredient_categories')
      .upsert(strip([...rows.values()]), { onConflict: 'owner_id,key', ignoreDuplicates: true });
    if (error) console.warn(error);
  }
  if (missingPlaces.size) {
    const { error } = await supabase.from('ingredient_categories').upsert([...missingPlaces.values()], { onConflict: 'owner_id,key' });
    if (error) console.warn(error);
  }
}

// Speichert Kategorie und Orte einer Zutat; die Änderung gilt in allen Rezepten und Einkaufslisten.
async function saveIngredientInfo(name, { category = categoryOf(name), places: ids = placesOf(name) }) {
  const key = categoryKey(name);
  if (!key) return;
  await loadCategories();
  categories.set(key, { category, places: ids });
  if (!categoriesSaved) { toast('Kategorien werden erst gespeichert, wenn kategorien.sql ausgeführt ist.'); return; }
  const row = placesSaved ? { key, category, places: ids } : { key, category };
  const { error } = await supabase.from('ingredient_categories').upsert(row, { onConflict: 'owner_id,key' });
  if (error) toast(error.message);
}

const setCategory = (name, category) => saveIngredientInfo(name, { category });

async function setPlaces(name, ids) {
  await saveIngredientInfo(name, { places: ids });
  if (!placesSaved && categoriesSaved) toast('Orte werden erst gespeichert, wenn orte.sql ausgeführt ist.');
}

// Fragt in einem Fenster nach den Orten einer Zutat; liefert die Kennungen oder null bei Abbruch.
async function choosePlaces(name) {
  await loadCategories();
  const current = placesOf(name);
  const { value, form } = await openSheet(`<h2>${esc(name)}</h2>
    <fieldset class="place-checks"><legend>Wo bekommst du das?</legend>${placeChecks(current)}</fieldset>
    <div class="row"><button class="btn primary" value="ok">Speichern</button>
      <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
  if (value !== 'ok') return null;
  return checkedPlaces(form);
}

const placeChecks = (selected) => (places ?? DEFAULT_PLACES).map((p) => `<label class="check"><input type="checkbox" name="place" value="${esc(p.id)}"${selected.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('');
const checkedPlaces = (form) => [...form.querySelectorAll('[name=place]:checked')].map((c) => c.value);
const placeLabel = (ids) => ids.map(placeName).filter(Boolean).join(', ') || 'Kein Ort';

const categoryOptions = (selected) => CATEGORIES.map((c) => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');

// Name einer Zutat mit ihrer Anmerkung (aus den Klammern) dahinter.
function ingredientLabel(ing) {
  const { name, note } = ingredientParts(ing);
  return `${esc(name)}${note ? ` <small class="ing-note">${esc(note)}</small>` : ''}`;
}

// Verkleinert Fotos vor dem Hochladen, damit der kostenlose Speicher lange reicht.
async function compressImage(file, maxSize = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`Bild „${file.name}“ konnte nicht gelesen werden.`));
      i.src = url;
    });
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Routing ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  return hash.split('/').filter(Boolean).map(decodeURIComponent);
}

async function render() {
  if (!isConfigured) return renderSetup();
  if (recoveringPassword) return renderNewPassword();
  const [first, id, action, extra] = route();
  renderTabbar(first);
  leaveShoppingList();
  // Geteilte Einzelrezepte kann man auch ohne Konto ansehen.
  if (first === 'teilen' && id) {
    renderNav();
    return guarded(() => renderSharedLink(id));
  }
  if (!session) {
    return renderLogin({
      einladung: 'Melde dich an oder registriere dich, um das geteilte Kochbuch zu sehen.',
      liste: 'Melde dich an oder registriere dich, um die geteilte Einkaufsliste mitzubearbeiten.',
    }[first] ?? '');
  }
  renderNav();
  return guarded(async () => {
    if (myName === undefined) myName = await loadMyName();
    if (myName === null) { renderUsername(); return; }
    if (!first) await renderList();
    else if (first === 'geteilt') await renderSharing();
    else if (first === 'plan') await renderPlan();
    else if (first === 'einkauf') await renderShopping(id);
    else if (first === 'liste' && id) await acceptListInvite(id);
    else if (first === 'einladung' && id) await acceptInvite(id);
    else if (first === 'kochbuch' && id && action) await renderCookbookRecipe(id, action, extra);
    else if (first === 'kochbuch' && id) await renderCookbook(id);
    else if (first === 'kochen') await renderPantry();
    else if (first === 'saison') await renderSeason();
    else if (first === 'kombinieren') await renderCombine(id);
    else if (first === 'neu') await renderEditor(null);
    else if (first === 'r' && id && action === 'bearbeiten') await renderEditor(id);
    else if (first === 'r' && id && action === 'alt' && extra) await renderDetail(id, extra);
    else if (first === 'r' && id) await renderDetail(id);
    else location.hash = '#/';
  });
}

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="notice error"><p>Da ist etwas schiefgelaufen:</p><p>${esc(err.message)}</p>
      <p><a class="btn" href="#/">Zur Übersicht</a></p></div>`;
  }
}

function renderNav() {
  if (!session) {
    nav.innerHTML = '<button class="btn small" id="login">Anmelden</button>';
    $('#login', nav).onclick = () => renderLogin();
    return;
  }
  nav.innerHTML = `
    <a class="btn primary small" href="#/neu">+ Rezept</a>
    <button class="btn ghost small" id="logout" title="${esc(session.user.email)}">Abmelden</button>`;
  $('#logout', nav).onclick = async () => {
    await supabase.auth.signOut();
  };
}

// ---------- Benutzername ----------

const USERNAME_RE = /^[A-Za-z0-9ÄÖÜäöüß ._-]{3,30}$/;
const USERNAME_HINT = '3 bis 30 Zeichen: Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich.';

// Lädt den eigenen Benutzernamen. Wurde bei der Registrierung einer angegeben, wird er jetzt gespeichert.
async function loadMyName() {
  const { data, error } = await supabase.from('profiles').select('username').eq('user_id', session.user.id).maybeSingle();
  if (error) return false; // Tabelle fehlt noch: ohne Benutzernamen weitermachen
  if (data) return data.username;
  const wanted = String(session.user.user_metadata?.username ?? '').trim();
  if (USERNAME_RE.test(wanted)) {
    const { error: insertError } = await supabase.from('profiles').insert({ username: wanted });
    if (!insertError) return wanted;
  }
  return null;
}

async function saveMyName(name) {
  const username = name.trim().replace(/\s+/g, ' ');
  if (!USERNAME_RE.test(username)) return USERNAME_HINT;
  const { error } = await supabase.from('profiles').upsert({ user_id: session.user.id, username });
  if (error) return error.code === '23505' ? 'Dieser Benutzername ist schon vergeben.' : error.message;
  myName = username;
  return '';
}

// Ohne Benutzernamen geht es nicht weiter: andere sehen beim Teilen nur diesen Namen.
function renderUsername() {
  tabbar.hidden = true;
  app.innerHTML = `
    <form class="auth card-panel" id="username-form">
      <h1>Wähle einen Benutzernamen</h1>
      <p class="hint">Wenn du Rezepte, dein Kochbuch oder Einkaufslisten teilst, sehen andere nur diesen Namen, nicht deine E-Mail-Adresse.</p>
      <label>Benutzername <input name="username" required minlength="3" maxlength="30" autocomplete="username" autocapitalize="off"></label>
      <small class="hint">${USERNAME_HINT}</small>
      <button class="btn primary">Speichern</button>
      <p class="hint" id="msg" role="status"></p>
    </form>`;
  const form = $('#username-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const problem = await saveMyName(form.username.value);
    if (problem) { $('#msg').textContent = problem; return; }
    toast(`Hallo ${myName}!`);
    render();
  };
}

const ownerName = (o) => o.owner_name ?? o.owner_email;
const readerName = (p) => p.reader_name ?? p.reader_email;
const personName = (p) => p.name ?? p.email;

// ---------- Ansichten ----------

function renderSetup() {
  nav.innerHTML = '';
  app.innerHTML = `<div class="notice">
    <h1>Fast fertig</h1>
    <p>Die App ist noch nicht mit Supabase verbunden. Trage die Project URL und den
    Publishable Key in <code>js/config.js</code> ein (siehe README).</p></div>`;
}

function renderLogin(hint = '') {
  nav.innerHTML = '';
  tabbar.hidden = true;
  app.innerHTML = `
    <form class="auth card-panel" id="auth">
      <h1>Anmelden</h1>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
      <label>E-Mail <input type="email" name="email" autocomplete="email" required></label>
      <label>Passwort <input type="password" name="password" autocomplete="current-password" minlength="6" required></label>
      <label>Benutzername <small>(nur beim Registrieren)</small> <input name="username" maxlength="30" autocomplete="username" autocapitalize="off"></label>
      <div class="row">
        <button class="btn primary" name="mode" value="login">Anmelden</button>
        <button class="btn" name="mode" value="signup">Registrieren</button>
      </div>
      <button type="button" class="link" id="forgot">Passwort vergessen?</button>
      <p class="hint" id="msg"></p>
    </form>`;
  const form = $('#auth');
  const msg = $('#msg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const mode = e.submitter?.value || 'login';
    const email = form.email.value.trim();
    const password = form.password.value;
    msg.textContent = '';
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (mode === 'signup') {
        const username = form.username.value.trim().replace(/\s+/g, ' ');
        if (!USERNAME_RE.test(username)) throw new Error(`Bitte einen Benutzernamen angeben. ${USERNAME_HINT}`);
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname, data: { username } },
        });
        if (error) throw error;
        if (!data.session) msg.textContent = 'Fast geschafft: Bitte bestätige deine E-Mail-Adresse über den Link in der Mail und melde dich dann an.';
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.textContent = err.message === 'Invalid login credentials'
        ? 'E-Mail oder Passwort stimmt nicht.' : err.message;
    } finally {
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  $('#forgot').onclick = async () => {
    const email = form.email.value.trim();
    if (!email) { msg.textContent = 'Gib zuerst deine E-Mail-Adresse ein.'; return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    msg.textContent = error ? error.message : 'Wir haben dir eine Mail zum Zurücksetzen geschickt.';
  };
}

function renderNewPassword() {
  nav.innerHTML = '';
  app.innerHTML = `
    <form class="auth card-panel" id="pw">
      <h1>Neues Passwort</h1>
      <label>Neues Passwort <input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Speichern</button>
      <p class="hint" id="msg"></p>
    </form>`;
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password: e.target.password.value });
    if (error) { $('#msg').textContent = error.message; return; }
    recoveringPassword = false;
    toast('Passwort geändert');
    render();
  };
}

const ICONS = {
  list: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  pantry: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  plan: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  shop: '<path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  shared: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c.8-3 2.8-4.5 5-4.5s4.2 1.5 5 4.5M14 18.5c.5-2 1.7-3 3.2-3s2.7 1 3.3 3"/>',
};

const TABS = [
  ['list', '#/', 'Rezepte'],
  ['pantry', '#/kochen', 'Was kochen?'],
  ['plan', '#/plan', 'Plan'],
  ['shop', '#/einkauf', 'Einkauf'],
  ['shared', '#/geteilt', 'Geteilt'],
];

function renderTabbar(first) {
  if (!session) { tabbar.hidden = true; return; }
  const active = { '': 'list', r: 'list', neu: 'list', kombinieren: 'list', kochen: 'pantry', saison: 'pantry', plan: 'plan', einkauf: 'shop', geteilt: 'shared', kochbuch: 'shared', liste: 'shop' }[first || ''];
  tabbar.hidden = false;
  tabbar.innerHTML = TABS.map(([key, href, label]) => `<a href="${href}" class="${key === active ? 'active' : ''}"${key === active ? ' aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg><span>${label}</span></a>`).join('');
}

// Die eingegebenen Zutaten bleiben auf dem Gerät gespeichert, damit man sie nicht jedes Mal neu tippt.
function loadPantry() {
  try {
    const saved = JSON.parse(localStorage.getItem('kochbuch.pantry') || '{}');
    return { items: Array.isArray(saved.items) ? saved.items : [], useStaples: saved.useStaples !== false };
  } catch {
    return { items: [], useStaples: true };
  }
}

function savePantry(state) {
  try { localStorage.setItem('kochbuch.pantry', JSON.stringify(state)); } catch { /* privater Modus */ }
}

// Auf Wunsch auch Rezepte aus Kochbüchern, die andere mit mir teilen (Einstellung bleibt auf dem Gerät).
function includeShared() {
  try { return localStorage.getItem('kochbuch.includeShared') === '1'; } catch { return false; }
}

function setIncludeShared(on) {
  try { localStorage.setItem('kochbuch.includeShared', on ? '1' : '0'); } catch { /* privater Modus */ }
}

// Eigene Rezepte, plus die aus geteilten Kochbüchern, wenn gewünscht. sharedBooks: Anzahl geteilter Kochbücher.
async function searchableRecipes() {
  const [own, people] = await Promise.all([loadRecipes(), loadPeople().catch(() => ({ owners: [] })), loadAlternatives()]);
  if (!people.owners.length || !includeShared()) return { all: own, sharedBooks: people.owners.length };
  const books = await Promise.all(people.owners.map((o) => loadCookbook(o.owner_id)));
  const shared = books.filter(Boolean).flatMap((b) => b.recipes.map((r) => ({ ...r, from: b.email })));
  return { all: [...own, ...shared], sharedBooks: people.owners.length };
}

const recipeHref = (r) => (r.from ? `#/kochbuch/${r.owner_id}/${r.id}` : `#/r/${r.id}`);

function sharedToggle(sharedBooks) {
  return sharedBooks ? `<label class="check"><input type="checkbox" id="include-shared" ${includeShared() ? 'checked' : ''}>
    Auch Rezepte aus Kochbüchern, die mit mir geteilt wurden</label>` : '';
}

function bindSharedToggle(rerender) {
  const box = $('#include-shared');
  if (box) box.onchange = () => { setIncludeShared(box.checked); rerender(); };
}

const pantryTags = new Set();

async function renderPantry() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const { all, sharedBooks } = await searchableRecipes();
  const state = loadPantry();
  const known = [...new Set(all.flatMap((r) => r.ingredients.map((i) => ingredientParts(i).name.split(',')[0].trim())).filter(Boolean))]
    .sort(collator.compare);

  app.innerHTML = `
    ${pantryTabs('kochen')}
    <div class="pantry card-panel">
      <label for="have">Welche Zutaten hast du?</label>
      <div class="import-row">
        <input id="have" list="known-ingredients" placeholder="z. B. Tomaten" autocomplete="off" enterkeyhint="done">
        <button type="button" class="btn" id="add-have">Hinzufügen</button>
      </div>
      <datalist id="known-ingredients">${known.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
      <div class="chips static" id="have-chips"></div>
      <label class="check"><input type="checkbox" id="staples" ${state.useStaples ? 'checked' : ''}>
        Grundzutaten sind immer da (${STAPLES.join(', ')})</label>
      ${sharedToggle(sharedBooks)}
    </div>
    <div id="pantry-tags"></div>
    <div id="suggestions"></div>`;

  const byId = new Map(all.map((r) => [r.id, r]));
  const input = $('#have');
  const draw = () => {
    savePantry(state);
    $('#have-chips').innerHTML = state.items.map((item, i) => (
      `<button type="button" class="chip active" data-i="${i}" aria-label="${esc(item)} entfernen">${esc(item)} ×</button>`
    )).join('') + (state.items.length > 1 ? '<button type="button" class="chip" id="clear-have">Alle entfernen</button>' : '');
    app.querySelectorAll('#have-chips [data-i]').forEach((chip) => {
      chip.onclick = () => { state.items.splice(Number(chip.dataset.i), 1); draw(); };
    });
    const clear = $('#clear-have');
    if (clear) clear.onclick = () => { state.items = []; draw(); };

    const out = $('#suggestions');
    if (!state.items.length) {
      $('#pantry-tags').innerHTML = '';
      out.innerHTML = '<p class="hint">Gib ein, was du im Kühlschrank und Vorrat hast. Dann zeige ich dir, welche Rezepte du damit kochen kannst.</p>';
      return;
    }
    const found = suggestRecipes(all, state.items, { useStaples: state.useStaples });
    const hits = tagFilter($('#pantry-tags'), found.map((h) => h.recipe), pantryTags, draw)(found);
    if (!hits.length) {
      out.innerHTML = '<p class="hint">Kein Rezept passt dazu. Füge weitere Zutaten hinzu.</p>';
      return;
    }
    const complete = hits.filter((h) => !h.missing.length);
    const almost = hits.filter((h) => h.missing.length && h.missing.length <= 3);
    const more = hits.filter((h) => h.missing.length > 3);
    const missingText = (m) => (m.length <= 3
      ? `Es fehlt: ${m.map(esc).join(', ')}`
      : `Es fehlen ${m.length} Zutaten: ${m.slice(0, 3).map(esc).join(', ')} …`);
    const card = (h) => `<a class="suggestion${altStack(h.recipe)}" href="${recipeHref(h.recipe)}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
      <div><h3>${esc(h.recipe.title)}${altMark(h.recipe, byId)}</h3>${fromLine(h.recipe)}
      <p class="${h.missing.length ? 'missing' : 'ok'}">${h.missing.length ? missingText(h.missing) : `Alle ${h.total} Zutaten da`}</p></div>
    </a>`;
    const section = (title, list) => (list.length ? `<h2>${title}</h2><div class="suggestions">${list.map(card).join('')}</div>` : '');
    out.innerHTML = section('Kannst du sofort kochen', complete)
      + section('Fast alles da', almost)
      + section('Weitere Rezepte mit deinen Zutaten', more);
  };

  const add = () => {
    const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (!state.items.some((x) => x.toLowerCase() === p.toLowerCase())) state.items.push(p);
    }
    input.value = '';
    draw();
  };
  $('#add-have').onclick = () => { add(); input.focus(); };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  // Auswahl aus der Vorschlagsliste direkt übernehmen.
  input.oninput = (e) => { if (!e.inputType || e.inputType === 'insertReplacementText') { if (known.includes(input.value)) add(); } };
  $('#staples').onchange = (e) => { state.useStaples = e.target.checked; draw(); };
  bindSharedToggle(renderPantry);
  draw();
}

// Tag-Filter für Trefferlisten: angeboten werden nur Tags, die in den Treffern vorkommen
// (plus bereits gewählte, damit man sie wieder abwählen kann). Mehrere Tags: einer davon reicht.
function tagFilter(container, recipes, selected, onChange) {
  const tags = [...new Set([...recipes.flatMap((r) => r.tags), ...selected])].sort(collator.compare);
  const useful = selected.size || tags.length > 1 || (tags.length === 1 && !recipes.every((r) => r.tags.includes(tags[0])));
  container.innerHTML = useful
    ? `<div class="chips static tag-filter">${tags.map((t) => `<button type="button" class="chip${selected.has(t) ? ' active' : ''}" data-tag="${esc(t)}" aria-pressed="${selected.has(t)}">${esc(t)}</button>`).join('')}</div>` : '';
  container.querySelectorAll('[data-tag]').forEach((chip) => {
    chip.onclick = () => {
      const t = chip.dataset.tag;
      if (selected.has(t)) selected.delete(t); else selected.add(t);
      onChange();
    };
  });
  return (list) => (selected.size ? list.filter((h) => h.recipe.tags.some((t) => selected.has(t))) : list);
}

const fromLine = (r) => (r.from ? `<p class="from-book">aus dem Kochbuch von ${esc(r.from)}</p>` : '');

function pantryTabs(active) {
  return `<nav class="segmented" aria-label="Was kochen?">
    <a href="#/kochen" class="${active === 'kochen' ? 'active' : ''}">Meine Zutaten</a>
    <a href="#/saison" class="${active === 'saison' ? 'active' : ''}">Saison</a></nav>`;
}

// Saisonkalender: Auswahl bleibt erhalten, solange die App offen ist.
const seasonState = { month: new Date().getMonth() + 1, storage: false, focus: new Set(), tags: new Set() };

async function renderSeason() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const { all, sharedBooks } = await searchableRecipes();
  const st = seasonState;
  const byId = new Map(all.map((r) => [r.id, r]));

  app.innerHTML = `
    ${pantryTabs('saison')}
    <div class="month-nav">
      <button class="icon-btn" id="prev-month" aria-label="Voriger Monat">‹</button>
      <h1 id="month-name"></h1>
      <button class="icon-btn" id="next-month" aria-label="Nächster Monat">›</button>
    </div>
    <label class="check"><input type="checkbox" id="storage" ${st.storage ? 'checked' : ''}> Lagerware einbeziehen (z. B. Äpfel und Kartoffeln aus dem Lager)</label>
    <div id="produce"></div>
    <section class="season-recipes">
      <h2>Passende Rezepte</h2>
      ${sharedToggle(sharedBooks)}
      <div id="season-tags"></div>
      <div id="season-results"></div>
    </section>
    <details class="year card-panel">
      <summary>Ganzes Jahr ansehen</summary>
      <div class="year-scroll"><table class="year-table">
        <thead><tr><th></th>${MONTHS.map((m) => `<th scope="col" title="${m}">${m[0]}</th>`).join('')}</tr></thead>
        ${['Gemüse', 'Obst'].map((kind) => `<tbody><tr><th colspan="13" class="kind">${kind}</th></tr>
          ${PRODUCE.filter((p) => p.kind === kind).map((p) => `<tr><th scope="row">${esc(p.name)}</th>${MONTHS.map((m, i) => {
    const s = seasonOf(p, i + 1);
    return `<td class="${s ?? ''}" title="${esc(p.name)} im ${m}: ${s === 'fresh' ? 'frisch' : s === 'store' ? 'Lagerware' : 'keine Saison'}"></td>`;
  }).join('')}</tr>`).join('')}</tbody>`).join('')}
      </table></div>
      <p class="hint"><span class="legend fresh"></span> frisch aus Deutschland <span class="legend store"></span> Lagerware</p>
    </details>`;

  const draw = () => {
    $('#month-name').textContent = MONTHS[st.month - 1];
    app.querySelectorAll('.year-table thead th').forEach((th, i) => th.classList.toggle('now', i === st.month));
    const current = inSeason(st.month, { storage: st.storage });
    for (const name of st.focus) if (!current.some((p) => p.name === name)) st.focus.delete(name);
    $('#produce').innerHTML = ['Gemüse', 'Obst'].map((kind) => {
      const items = current.filter((p) => p.kind === kind);
      return `<h2>${kind}</h2>${items.length ? `<div class="chips static">${items.map((p) => `<button type="button"
        class="chip produce${st.focus.has(p.name) ? ' active' : ''}${seasonOf(p, st.month) === 'store' ? ' store' : ''}"
        data-produce="${esc(p.name)}" aria-pressed="${st.focus.has(p.name)}">${esc(p.name)}</button>`).join('')}</div>`
        : '<p class="hint">Gerade nichts frisch aus Deutschland.</p>'}`;
    }).join('') + `<p class="hint">${st.focus.size ? 'Es werden nur Rezepte mit der Auswahl gesucht. Tippe erneut, um sie aufzuheben.' : 'Tippe auf Obst oder Gemüse, um nur danach zu suchen.'}</p>`;
    app.querySelectorAll('[data-produce]').forEach((b) => {
      b.onclick = () => {
        const name = b.dataset.produce;
        if (st.focus.has(name)) st.focus.delete(name); else st.focus.add(name);
        draw();
      };
    });

    const produce = st.focus.size ? current.filter((p) => st.focus.has(p.name)) : current;
    const found = seasonalRecipes(all, produce);
    const hits = tagFilter($('#season-tags'), found.map((h) => h.recipe), st.tags, draw)(found);
    $('#season-results').innerHTML = hits.length ? `<div class="suggestions">${hits.map((h) => `<a class="suggestion${altStack(h.recipe)}" href="${recipeHref(h.recipe)}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
      <div><h3>${esc(h.recipe.title)}${altMark(h.recipe, byId)}</h3>${fromLine(h.recipe)}<p class="ok">Saison: ${h.matches.map((p) => esc(p.name)).join(', ')}</p></div></a>`).join('')}</div>`
      : `<p class="hint">${all.length ? 'Keines deiner Rezepte passt dazu.' : 'Du hast noch keine Rezepte.'}</p>`;
  };

  const step = (d) => { st.month = ((st.month - 1 + d + 12) % 12) + 1; draw(); };
  $('#prev-month').onclick = () => step(-1);
  $('#next-month').onclick = () => step(1);
  $('#storage').onchange = (e) => { st.storage = e.target.checked; draw(); };
  bindSharedToggle(renderSeason);
  draw();
}

async function renderList() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const [all] = await Promise.all([loadRecipes(), loadAlternatives()]);
  if (!all.length) {
    app.innerHTML = `<div class="empty">
      <h1>Noch keine Rezepte</h1>
      <p>Lege dein erstes Rezept an.</p>
      <a class="btn primary" href="#/neu">+ Neues Rezept</a></div>`;
    return;
  }
  const tags = [...new Set(all.flatMap((r) => r.tags))].sort(collator.compare);
  if (activeTag && !tags.includes(activeTag)) activeTag = null;
  app.innerHTML = `
    
    <div class="search">
      <input type="search" id="q" placeholder="Titel, Beschreibung oder Tag suchen" value="${esc(listQuery)}" aria-label="Rezepte durchsuchen">
      <select id="sort" aria-label="Sortierung">
        <option value="name"${listSort === 'name' ? ' selected' : ''}>A–Z</option>
        <option value="rating"${listSort === 'rating' ? ' selected' : ''}>Beste zuerst</option>
      </select>
    </div>
    ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip${t === activeTag ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div id="results" class="grid"></div>`;

  const byId = new Map(all.map((r) => [r.id, r]));
  const results = $('#results');
  const draw = () => {
    const q = listQuery.trim().toLowerCase();
    const shown = all.filter((r) => (!activeTag || r.tags.includes(activeTag))
      && (!q || [r.title, r.description, ...r.tags].some((s) => s.toLowerCase().includes(q))));
    if (listSort === 'rating') shown.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || collator.compare(a.title, b.title));
    results.innerHTML = shown.length ? shown.map((r) => `<div class="swipe" data-id="${r.id}">
        <div class="swipe-actions start"><button type="button" class="swipe-btn danger" data-act="delete">Löschen</button></div>
        <div class="swipe-actions end"><button type="button" class="swipe-btn" data-act="plan">Einplanen</button><button type="button" class="swipe-btn accent" data-act="share">Teilen</button></div>
        ${recipeCard(r, `#/r/${r.id}`, byId)}</div>`).join('')
      : '<p class="hint">Keine passenden Rezepte gefunden.</p>';
    results.querySelectorAll('.swipe').forEach((el) => enableSwipe(el, el.querySelector('.card')));
  };
  // Wischen nach links: Einplanen und Teilen; nach rechts: Löschen.
  results.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const el = btn.closest('.swipe');
    const r = all.find((x) => x.id === el.dataset.id);
    closeSwipes();
    if (btn.dataset.act === 'plan') await planRecipe(r);
    if (btn.dataset.act === 'share') await shareRecipe(r);
    if (btn.dataset.act === 'delete' && await deleteRecipe(r)) {
      all.splice(all.indexOf(r), 1);
      if (all.length) draw(); else renderList();
    }
  };
  $('#q').oninput = (e) => { listQuery = e.target.value; draw(); };
  $('#sort').onchange = (e) => { listSort = e.target.value; draw(); };
  app.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
      app.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.tag === activeTag));
      draw();
    };
  });
  draw();
}

// Macht ein Element seitlich wischbar. Hinter ihm liegen .swipe-actions.start (links,
// sichtbar beim Wischen nach rechts) und/oder .swipe-actions.end (rechts, beim Wischen nach links).
let openSwipe = null;

function closeSwipes() {
  if (openSwipe) { openSwipe.close(); openSwipe = null; }
}

document.addEventListener('pointerdown', (e) => {
  if (openSwipe && !openSwipe.el.contains(e.target)) closeSwipes();
});

function enableSwipe(el, front) {
  const start = el.querySelector('.swipe-actions.start');
  const end = el.querySelector('.swipe-actions.end');
  let x0 = 0, y0 = 0, dx = 0, base = 0, active = false, decided = false, moved = false;
  const set = (x, animate) => {
    front.style.transition = animate ? 'transform 0.2s ease' : 'none';
    front.style.transform = x ? `translateX(${x}px)` : '';
    el.classList.toggle('show-start', x > 0);
    el.classList.toggle('show-end', x < 0);
  };
  const self = { el, close: () => { base = 0; set(0, true); } };
  front.addEventListener('dragstart', (e) => e.preventDefault()); // Links und Bilder nicht herausziehen
  front.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; active = true; decided = false; moved = false;
  });
  front.addEventListener('pointermove', (e) => {
    if (!active) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx)) { active = false; return; } // senkrecht: normal scrollen
      moved = true;
      front.setPointerCapture(e.pointerId);
      if (openSwipe && openSwipe !== self) closeSwipes();
    }
    let x = base + mx;
    if (x > 0 && !start) x = 0;
    if (x < 0 && !end) x = 0;
    const limit = (x > 0 ? start : end)?.offsetWidth ?? 0;
    if (Math.abs(x) > limit) x = Math.sign(x) * (limit + (Math.abs(x) - limit) * 0.3);
    dx = x;
    set(x, false);
  });
  const finish = () => {
    if (!active) return;
    active = false;
    if (!moved) return;
    const panel = dx > 0 ? start : dx < 0 ? end : null;
    if (panel && Math.abs(dx) > 50) {
      base = Math.sign(dx) * panel.offsetWidth;
      set(base, true);
      openSwipe = self;
    } else {
      self.close();
      if (openSwipe === self) openSwipe = null;
    }
  };
  front.addEventListener('pointerup', finish);
  front.addEventListener('pointercancel', finish);
  // Nach dem Wischen keinen Klick auslösen (sonst öffnet sich das Rezept).
  front.addEventListener('click', (e) => {
    if (!moved && !base) return;
    e.preventDefault();
    e.stopPropagation();
    moved = false;
    if (base) { self.close(); openSwipe = null; } // Tipp auf ein geöffnetes Element schließt es wieder
  }, true);
}

// Wischen über ein ganzes Rezept: nach links zum nächsten, nach rechts zum vorherigen.
// Auf Galerie und Video fängt die Geste nicht, die scrollen bzw. steuern selbst.
function enableRecipeSwipe(el, go) {
  if (!el) return;
  let x0 = 0, y0 = 0, active = false, decided = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.media, .gallery, .video, button, a, input, select, textarea')) return;
    x0 = e.clientX; y0 = e.clientY; active = true; decided = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || decided) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (Math.abs(mx) < 60 && Math.abs(my) < 60) return;
    decided = true;
    active = false;
    if (Math.abs(my) > Math.abs(mx)) return; // senkrecht: normal scrollen
    go(mx < 0 ? 1 : -1);
  });
  const stop = () => { active = false; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

// Einmaliger Hinweis, dass zwischen den Alternativen gewischt werden kann. Er geht weg,
// sobald einmal gewechselt wurde.
const ALT_HINT = 'altHintSeen';
function showAltHint() {
  try { if (localStorage.getItem(ALT_HINT)) return; } catch { return; }
  const nav = $('.alts');
  if (!nav) return;
  nav.insertAdjacentHTML('afterend', `<p class="swipe-hint" id="alt-hint">← Wisch über das Rezept oder tippe oben auf einen Titel, um die Alternativen zu sehen. →</p>`);
  $('#alt-hint').onclick = seenAltHint;
}
function seenAltHint() {
  try { localStorage.setItem(ALT_HINT, '1'); } catch { /* ohne Speicher eben jedes Mal */ }
  $('#alt-hint')?.remove();
}

// Kennzeichnung für Rezepte mit Alternativen: „+2“ auf der Karte. byId: Rezepte für die
// Titel im Tooltip, soweit vorhanden.
function altMark(r, byId = null) {
  const ids = links ? alternativeIds(links, r.id) : [];
  if (!ids.length) return '';
  const titles = ids.map((x) => byId?.get(x)?.title).filter(Boolean);
  const label = `${ids.length === 1 ? 'Eine Alternative' : `${ids.length} Alternativen`}${titles.length ? `: ${titles.join(', ')}` : ''}`;
  return `<span class="alt-badge" title="${esc(label)}" aria-label="${esc(label)}">+${ids.length}</span>`;
}

// Hat ein Rezept Alternativen, liegt die Karte wie ein kleiner Stapel.
const altStack = (r) => (links && alternativeIds(links, r.id).length ? ' stacked' : '');

function recipeCard(r, href = `#/r/${r.id}`, byId = null) {
  const img = r.images[0]
    ? `<img src="${esc(imageUrl(r.images[0]))}" alt="" loading="lazy">`
    : '<div class="placeholder" aria-hidden="true">🍲</div>';
  const meta = [r.rating ? '★'.repeat(r.rating) : '', r.total_minutes != null ? `⏱ ${formatMinutes(r.total_minutes)}` : '', ...r.tags.slice(0, 3)]
    .filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  return `<a class="card${altStack(r)}" href="${href}">
    ${img}
    <div class="card-body"><h2>${esc(r.title)}${altMark(r, byId)}</h2><div class="meta">${meta}</div></div>
  </a>`;
}

// Zeigt ein eigenes Rezept. altId: die gerade angezeigte Alternative des Rezepts id.
async function renderDetail(id, altId = null) {
  const [own] = await Promise.all([loadRecipes(), loadAlternatives()]);
  const main = own.find((x) => x.id === id);
  if (!main) {
    app.innerHTML = '<div class="notice"><p>Dieses Rezept gibt es nicht (mehr).</p><a class="btn" href="#/">Zur Übersicht</a></div>';
    return;
  }
  // Gewischt wird zwischen dem aufgerufenen Rezept und seinen Alternativen.
  const group = alternativeGroup(main, links, own, collator.compare);
  const index = altId ? group.findIndex((x) => x.id === altId) : 0;
  if (index < 0) { location.hash = `#/r/${id}`; return; }
  showRecipe(group[index], {
    own: true,
    back: '#/',
    backLabel: 'Alle Rezepte',
    group,
    index,
    hrefOf: (i) => (i === 0 ? `#/r/${id}` : `#/r/${id}/alt/${group[i].id}`),
  });
}

// Zeigt ein Rezept an. Eigene Rezepte kann man bearbeiten, teilen und löschen,
// fremde (aus einem Teilen-Link oder einem freigegebenen Kochbuch) ins eigene Kochbuch übernehmen.
function showRecipe(r, { own, back, backLabel, from = '', group = [], index = 0, hrefOf = null }) {
  window.scrollTo(0, 0);
  let servings = r.servings;
  const sources = r.sources.map((u) => [u, safeUrl(u)]).filter(([, href]) => href);
  const videos = videosOf(r.sources);
  const videoLabel = (v) => (v.provider === 'youtube' ? 'YouTube' : 'TikTok');
  // Oben steht immer genau eines: ein Video oder die Bilder. Die Leiste darüber schaltet um;
  // beim Öffnen läuft das erste Video, die Bilder liegen in ihrem eigenen Reiter.
  const tabs = [
    ...videos.map((v, i) => ({
      key: v.key, video: v,
      label: videos.length > 1 ? `Video ${i + 1} · ${videoLabel(v)}` : `Video · ${videoLabel(v)}`,
    })),
    ...(r.images.length ? [{ key: 'bilder', label: r.images.length > 1 ? `Bilder (${r.images.length})` : 'Bild' }] : []),
  ];
  let shown = tabs[0] ?? null;
  const galleryHtml = () => `<div class="gallery" id="gallery">${r.images.map((p) => `<img src="${esc(imageUrl(p))}" alt="">`).join('')}</div>
    ${r.images.length > 1 ? `<div class="gallery-nav">
      <button type="button" class="icon-btn" data-img="-1" aria-label="Vorheriges Bild">‹</button>
      <span id="gallery-at" aria-live="polite">1 / ${r.images.length}</span>
      <button type="button" class="icon-btn" data-img="1" aria-label="Nächstes Bild">›</button></div>` : ''}`;
  const videoHtml = (v, start = null) => `<div class="video${v.vertical ? ' vertical' : ''}">
    <iframe id="video" src="${esc(embedUrl(v, location.origin, start))}" title="Video zum Rezept"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  const mediaHtml = (t, start = null) => (t.video ? videoHtml(t.video, start) : galleryHtml());

  app.innerHTML = `
    <article class="recipe">
      ${back ? `<a class="back" href="${back}">← ${esc(backLabel)}</a>` : ''}
      ${from ? `<p class="hint from">${esc(from)}</p>` : ''}
      ${shown ? `${tabs.length > 1 ? `<div class="media-tabs" id="media-tabs" role="tablist">${tabs.map((t, i) => `<button type="button" class="chip${i === 0 ? ' active' : ''}"
        data-media="${esc(t.key)}" role="tab" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      <div class="media" id="media-box">${mediaHtml(shown)}</div>` : ''}
      ${group.length > 1 ? `<nav class="alts" aria-label="Alternativrezepte">
        <p class="alt-title">${group.length - 1 === 1 ? 'Dieses Rezept hat eine Alternative' : `Dieses Rezept hat ${group.length - 1} Alternativen`}</p>
        <div class="alt-row">
          <button type="button" class="alt-nav" data-step="-1" aria-label="Vorheriges Rezept"${index === 0 ? ' disabled' : ''}>‹</button>
          <div class="alt-tabs" role="tablist">${group.map((x, i) => `<button type="button" class="chip${i === index ? ' active' : ''}"
            data-alt="${i}" role="tab" aria-selected="${i === index}">${esc(x.title)}${i === 0 ? ' <small>Haupt</small>' : ''}</button>`).join('')}</div>
          <button type="button" class="alt-nav" data-step="1" aria-label="Nächstes Rezept"${index === group.length - 1 ? ' disabled' : ''}>›</button>
        </div>
        <small>${index === 0 ? 'Hauptrezept' : `Alternative ${index} von ${group.length - 1}`} · antippen oder wischen zum Wechseln</small>
      </nav>` : ''}
      <h1>${esc(r.title)}</h1>
      ${own ? `<div class="stars" role="group" aria-label="Bewertung">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${(r.rating ?? 0) >= n ? 'on' : ''}" aria-label="${n} von 5 Sternen" aria-pressed="${r.rating === n}">★</button>`).join('')}</div>`
    : r.rating ? `<div class="stars readonly" aria-label="${r.rating} von 5 Sternen">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>` : ''}
      ${own ? '<div id="planned"></div>' : ''}
      ${r.description ? `<p class="lead">${esc(r.description)}</p>` : ''}
      ${r.tags.length ? `<div class="chips static">${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${r.total_minutes != null || r.cook_minutes != null ? `<dl class="times">
        ${r.total_minutes != null ? `<div><dt>Gesamtzeit</dt><dd>${formatMinutes(r.total_minutes)}</dd></div>` : ''}
        ${r.cook_minutes != null ? `<div><dt>Koch-/Backzeit</dt><dd>${formatMinutes(r.cook_minutes)}</dd></div>` : ''}
      </dl>` : ''}

      ${r.ingredients.length ? `<section>
        <div class="section-head">
          <h2>Zutaten</h2>
          <div class="stepper" role="group" aria-label="Personenzahl">
            <button class="btn small" data-d="-1" aria-label="Weniger Personen">−</button>
            <span id="srv" aria-live="polite"></span>
            <button class="btn small" data-d="1" aria-label="Mehr Personen">+</button>
          </div>
        </div>
        <ul class="ingredients" id="ing"></ul>
      </section>` : ''}

      ${r.steps.length ? `<section><h2>Zubereitung</h2>
        <ol class="steps">${r.steps.map((s) => {
    const v = stepVideo(s, videos);
    const t = v ? stepTime(s) : null;
    // Bei mehreren Videos steht am Zeitstempel, in welchem er liegt.
    const n = videos.length > 1 ? `${videos.indexOf(v) + 1} · ` : '';
    return `<li>${t != null ? `<button type="button" class="seek" data-t="${t}" data-video="${esc(v.key)}"
      aria-label="Video ${videos.length > 1 ? `${videos.indexOf(v) + 1} ` : ''}ab ${formatTime(t)} abspielen">▶ ${n}${formatTime(t)}</button> ` : ''}${esc(stepText(s))}</li>`;
  }).join('')}</ol></section>` : ''}

      ${hasNutrition(r.nutrition) ? `<section><h2>Nährwerte <small class="hint">${r.nutrition.per === '100 g' ? 'pro 100 g' : 'pro Portion'}</small></h2>
        <dl class="nutrition">${NUTRIENTS.filter(([k]) => r.nutrition[k] != null).map(([k, label, unit]) => `<div><dt>${label}</dt><dd>${formatNutrient(r.nutrition[k])} ${unit}</dd></div>`).join('')}</dl></section>` : ''}

      ${r.notes ? `<section><h2>Notizen</h2><p class="notes">${linkify(r.notes)}</p></section>` : ''}

      ${sources.length ? `<section><h2>Quellen</h2><ul class="sources">
        ${sources.map(([u, href]) => `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u))}</a></li>`).join('')}
      </ul></section>` : ''}

      <div class="actions">${own ? `
        <button class="btn primary" id="plan-btn">Einplanen</button>
        <a class="btn" href="#/r/${r.id}/bearbeiten">Bearbeiten</a>
        <button class="btn" id="share">Teilen</button>
        ${r.share_token ? '<button class="btn ghost" id="unshare">Teilen beenden</button>' : ''}
        <button class="btn danger" id="del">Löschen</button>` : session
    ? '<button class="btn primary" id="copy">In mein Kochbuch übernehmen</button>'
    : '<button class="btn primary" id="login-copy">Anmelden, um das Rezept zu übernehmen</button>'}
      </div>
    </article>`;

  // Links/rechts wischen wechselt zwischen Hauptrezept und Alternativen.
  if (group.length > 1 && hrefOf) {
    const go = (step) => {
      const next = index + step;
      if (next < 0 || next >= group.length) return;
      location.hash = hrefOf(next);
    };
    app.querySelectorAll('.alt-nav').forEach((b) => { b.onclick = () => go(Number(b.dataset.step)); });
    app.querySelectorAll('.alt-tabs [data-alt]').forEach((b) => {
      b.onclick = () => { seenAltHint(); location.hash = hrefOf(Number(b.dataset.alt)); };
    });
    // Der aktive Reiter soll zu sehen sein, auch wenn die Leiste seitlich scrollt.
    app.querySelector('.alt-tabs .chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    enableRecipeSwipe($('.recipe'), (step) => { seenAltHint(); go(step); });
    showAltHint();
  }

  const ingList = $('#ing');
  const drawIngredients = () => {
    if (!ingList) return;
    $('#srv').textContent = `${servings} ${servings === 1 ? 'Person' : 'Personen'}`;
    const factor = servings / r.servings;
    ingList.innerHTML = r.ingredients.map((i) => `<li><span class="qty">${esc(formatQuantity(i, factor))}</span><span>${ingredientLabel(i)}</span></li>`).join('');
  };
  app.querySelectorAll('.stepper button').forEach((b) => {
    b.onclick = () => {
      servings = Math.max(1, Math.min(100, servings + Number(b.dataset.d)));
      drawIngredients();
    };
  });
  drawIngredients();

  // Bilder: waagerecht durchwischen, Zähler und Pfeile für Rechner.
  const bindGallery = () => {
    const strip = $('#gallery');
    if (!strip) return;
    const at = $('#gallery-at');
    if (at) {
      strip.onscroll = () => {
        at.textContent = `${Math.min(r.images.length, Math.round(strip.scrollLeft / strip.clientWidth) + 1)} / ${r.images.length}`;
      };
    }
    app.querySelectorAll('[data-img]').forEach((b) => {
      b.onclick = () => strip.scrollBy({ left: Number(b.dataset.img) * strip.clientWidth, behavior: 'smooth' });
    });
  };
  bindGallery();

  // Zeigt ein Video oder die Bilder. Läuft das Video schon, springt der Player selbst;
  // sonst wird es neu geladen und springt, sobald es bereit ist.
  const showMedia = (key, seconds = null) => {
    const box = $('#media-box');
    const next = tabs.find((t) => t.key === key);
    if (!box || !next) return;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (next.key === shown.key) {
      if (next.video && seconds != null) seekTo($('#video'), next.video, seconds);
      return;
    }
    shown = next;
    box.innerHTML = mediaHtml(next, seconds);
    // TikTok kennt keine Startzeit in der Adresse, springt also erst nach dem Laden.
    if (next.video && seconds != null && next.video.provider !== 'youtube') {
      const frame = $('#video');
      frame.addEventListener('load', () => seekTo(frame, next.video, seconds), { once: true });
    }
    if (!next.video) bindGallery();
    app.querySelectorAll('#media-tabs [data-media]').forEach((t) => {
      const on = t.dataset.media === next.key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
  };

  app.querySelectorAll('#media-tabs [data-media]').forEach((t) => {
    t.onclick = () => showMedia(t.dataset.media);
  });

  // Zeitstempel bei den Schritten: zum passenden Video und dort an die Stelle springen.
  app.querySelectorAll('.seek').forEach((b) => {
    b.onclick = () => showMedia(b.dataset.video, Number(b.dataset.t));
  });

  if (!own) {
    if (session) $('#copy').onclick = (e) => copyRecipe(r, e.target);
    else $('#login-copy').onclick = () => renderLogin('Melde dich an oder registriere dich. Danach kannst du das Rezept übernehmen.');
    return;
  }

  app.querySelectorAll('.stars button').forEach((b) => {
    b.onclick = async () => {
      const n = Number(b.dataset.star);
      const rating = r.rating === n ? null : n; // gleicher Stern nochmal = Bewertung löschen
      const { error } = await supabase.from('recipes').update({ rating }).eq('id', r.id);
      if (error) { toast(error.message); return; }
      r.rating = rating;
      app.querySelectorAll('.stars button').forEach((x) => {
        x.classList.toggle('on', (rating ?? 0) >= Number(x.dataset.star));
        x.setAttribute('aria-pressed', String(rating === Number(x.dataset.star)));
      });
    };
  });

  setupPlanning(r, () => servings);

  $('#share').onclick = async () => {
    const hadToken = Boolean(r.share_token);
    if (await shareRecipe(r) && !hadToken) showRecipe(r, { own, back, backLabel });
  };
  const unshare = $('#unshare');
  if (unshare) {
    unshare.onclick = async () => {
      if (!confirm('Der bisherige Link funktioniert danach nicht mehr. Teilen beenden?')) return;
      const { error } = await supabase.from('recipes').update({ share_token: null }).eq('id', r.id);
      if (error) { toast(error.message); return; }
      r.share_token = null;
      toast('Link deaktiviert');
      showRecipe(r, { own, back, backLabel });
    };
  }

  $('#del').onclick = async () => {
    if (await deleteRecipe(r)) location.hash = '#/';
  };
}

const NUTRIENTS = [
  ['kcal', 'Kalorien', 'kcal'], ['protein', 'Eiweiß', 'g'], ['fat', 'Fett', 'g'], ['carbs', 'Kohlenhydrate', 'g'],
  ['sugar', 'davon Zucker', 'g'], ['fiber', 'Ballaststoffe', 'g'], ['salt', 'Salz', 'g'],
];
const hasNutrition = (n) => Boolean(n) && NUTRIENTS.some(([k]) => n[k] != null);
const formatNutrient = (v) => String(v).replace('.', ',');

// Erzeugt bei Bedarf einen Teilen-Link und öffnet das Teilen-Menü. Liefert true bei Erfolg.
async function shareRecipe(r) {
  try {
    if (!r.share_token) {
      const token = crypto.randomUUID();
      const { error } = await supabase.from('recipes').update({ share_token: token }).eq('id', r.id);
      if (error) throw error;
      r.share_token = token;
    }
    await shareLink(appUrl(`teilen/${r.share_token}`), r.title);
    return true;
  } catch (err) {
    toast(`Teilen fehlgeschlagen: ${err.message}`);
    return false;
  }
}

// Fragt nach und löscht ein eigenes Rezept samt Bildern. Liefert true, wenn gelöscht wurde.
async function deleteRecipe(r) {
  const { value } = await openSheet(`<h2>„${esc(r.title)}“ löschen?</h2>
    <p>Das Rezept und seine Bilder werden endgültig gelöscht.</p>
    <div class="row"><button class="btn danger" value="delete">Löschen</button>
      <button class="btn ghost" value="cancel">Abbrechen</button></div>`);
  if (value !== 'delete') return false;
  const { error } = await supabase.from('recipes').delete().eq('id', r.id);
  if (error) { toast(error.message); return false; }
  if (r.images.length) await supabase.storage.from(IMAGE_BUCKET).remove(r.images);
  recipes = recipes.filter((x) => x.id !== r.id);
  if (links) links = links.filter((l) => l.recipe_a !== r.id && l.recipe_b !== r.id); // per Cascade auch in der Datenbank weg
  toast('Rezept gelöscht');
  return true;
}

// Schreibt die Verknüpfungen eines Rezepts: neue anlegen, gelöste entfernen.
async function saveAlternatives(recipeId, wanted) {
  const before = alternativeIds(links ?? [], recipeId);
  const added = wanted.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !wanted.includes(x));
  if (added.length) {
    const { error } = await supabase.from('recipe_alternatives')
      .upsert(added.map((x) => pairOf(recipeId, x)), { onConflict: 'recipe_a,recipe_b' });
    if (error) throw error;
  }
  for (const x of removed) {
    const { recipe_a: a, recipe_b: b } = pairOf(recipeId, x);
    const { error } = await supabase.from('recipe_alternatives').delete().eq('recipe_a', a).eq('recipe_b', b);
    if (error) throw error;
  }
  if (added.length || removed.length) await loadAlternatives(true);
}

// ---------- Rezepte kombinieren ----------

// Stellt aus den Schritten mehrerer Rezepte ein neues zusammen. mainId: das Hauptrezept,
// aus dem Zutaten und Personenzahl zunächst übernommen werden.
async function renderCombine(mainId) {
  const { all } = await searchableRecipes();
  const main = all.find((x) => x.id === mainId) ?? all[0];
  if (!main) {
    app.innerHTML = '<div class="notice"><p>Dafür braucht es mindestens ein Rezept.</p><a class="btn" href="#/">Zur Übersicht</a></div>';
    return;
  }
  window.scrollTo(0, 0);
  const servings = main.servings;
  let chosen = [main];
  let active = main.id;
  let picked = []; // gewählte Schritte in ihrer Reihenfolge: { rid, i, text, t, v }
  // Zutaten des neuen Rezepts. via: Schritte, über die sie dazugekommen sind; manual: von Hand.
  let ings = main.ingredients.map((i) => ({ ing: { ...i }, from: main.id, via: new Set(), manual: true }));
  let hints = [];

  const byId = (id) => chosen.find((x) => x.id === id);
  const stepKey = (rid, i) => `${rid}:${i}`;
  const stepsOf = stepsForCombine;
  const haveIngredients = () => ings.map((x) => x.ing);

  app.innerHTML = `
    <div class="combine">
      <a class="back" href="#/r/${esc(main.id)}">← ${esc(main.title)}</a>
      <h1>Rezepte kombinieren</h1>
      <p class="hint">Hauptrezept ist <strong>${esc(main.title)}</strong>: seine Zutaten und ${servings} ${servings === 1 ? 'Person' : 'Personen'} stehen schon im neuen Rezept.
        Tippe die Schritte in der Reihenfolge an, in der du kochen willst.</p>
      <div class="chips static" id="combine-recipes"></div>
      <button type="button" class="btn small" id="combine-add">+ Rezept</button>

      <section class="card-panel" id="combine-new"></section>

      <div class="chips" id="combine-tabs"></div>
      <ol class="combine-steps" id="combine-source"></ol>

      <div class="actions">
        <button type="button" class="btn primary" id="combine-next">Weiter</button>
      </div>
    </div>`;

  const drawRecipes = () => {
    $('#combine-recipes').innerHTML = chosen.map((r) => `<span class="chip">${esc(r.title)}${r.id === main.id ? ' (Haupt)' : ''}
      ${r.id === main.id ? '' : `<button type="button" data-drop="${esc(r.id)}" aria-label="${esc(r.title)} entfernen">×</button>`}</span>`).join('');
    $('#combine-recipes').querySelectorAll('[data-drop]').forEach((b) => {
      b.onclick = () => {
        const rid = b.dataset.drop;
        chosen = chosen.filter((x) => x.id !== rid);
        picked.filter((p) => p.rid === rid).forEach((p) => dropIngredientsOf(p));
        picked = picked.filter((p) => p.rid !== rid);
        if (active === rid) active = main.id;
        drawAll();
      };
    });
  };

  // Zutaten entfernen, die nur über diesen Schritt dazugekommen sind.
  const dropIngredientsOf = (p) => {
    const key = stepKey(p.rid, p.i);
    ings = ings.filter((x) => {
      x.via.delete(key);
      return x.manual || x.via.size > 0;
    });
  };

  const addStep = (rid, i) => {
    const r = byId(rid);
    const st = stepsOf(r)[i];
    if (!st) return;
    picked.push({ rid, i, text: st.text, t: st.t, v: st.v });
    const key = stepKey(rid, i);
    // Zutaten, die dieser Schritt nennt und die noch fehlen, kommen dazu.
    for (const ing of ingredientsFromStep(st.text, r, haveIngredients(), servings)) {
      ings.push({ ing, from: rid, via: new Set([key]), manual: false });
    }
    // Steht die Zutat schon mit anderer Menge im Rezept, bleibt die des Hauptrezepts.
    const factor = servings / (r.servings || servings);
    for (const i2 of r.ingredients) {
      if (!i2.name || !mentionsIngredient(st.text, i2.name)) continue;
      const mine = ings.find((x) => ingredientKey(x.ing) === ingredientKey(i2));
      if (!mine || mine.from === rid) continue;
      const scaled = scaleIngredient(i2, factor);
      const a = formatQuantity(mine.ing);
      const b = formatQuantity(scaled);
      if (a !== b) hints.push(`${r.title} nennt ${b || 'ohne Menge'} ${i2.name} (hier stehen ${a || 'keine Menge'}).`);
    }
  };

  const removeStep = (n) => {
    const [p] = picked.splice(n, 1);
    if (p) dropIngredientsOf(p);
    hints = [];
  };

  const moveStep = (n, d) => {
    const to = n + d;
    if (to < 0 || to >= picked.length) return;
    [picked[n], picked[to]] = [picked[to], picked[n]];
  };

  const drawNew = () => {
    const box = $('#combine-new');
    const rest = chosen
      .filter((r) => r.id !== main.id)
      .map((r) => [r, remainingIngredients(r, haveIngredients(), servings)])
      .filter(([, list]) => list.length);
    box.innerHTML = `<h2>Neues Rezept</h2>
      ${picked.length ? `<ol class="step-order">${picked.map((p, n) => `<li>
          <span>${esc(p.text)}<small>${esc(byId(p.rid)?.title ?? '')}${p.t != null ? ` · ▶ ${formatTime(p.t)}` : ''}</small></span>
          <span class="row">
            <button type="button" class="btn small" data-up="${n}" aria-label="Nach oben"${n === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="btn small" data-down="${n}" aria-label="Nach unten"${n === picked.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="link danger-link" data-off="${n}">Raus</button>
          </span></li>`).join('')}</ol>`
    : '<p class="hint">Noch kein Schritt gewählt. Tippe unten auf die Schritte.</p>'}

      <h3>Zutaten</h3>
      <ul class="ingredients">${ings.map((x, n) => `<li><span class="qty">${esc(formatQuantity(x.ing))}</span>
        <span>${ingredientLabel(x.ing)}${x.from === main.id ? '' : ` <small>aus ${esc(byId(x.from)?.title ?? '')}</small>`}</span>
        <button type="button" class="link danger-link" data-noing="${n}" aria-label="${esc(x.ing.name)} entfernen">×</button></li>`).join('')}</ul>
      ${hints.length ? `<ul class="hint">${[...new Set(hints)].map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}

      ${rest.map(([r, list]) => `<details><summary>Weitere Zutaten aus ${esc(r.title)}</summary>
        <div class="chips static">${list.map((i) => `<button type="button" class="chip add" data-addfrom="${esc(r.id)}" data-name="${esc(i.name)}">+ ${esc(ingredientToLine(i))}</button>`).join('')}</div>
      </details>`).join('')}`;

    box.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => { moveStep(Number(b.dataset.up), -1); drawAll(); }; });
    box.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => { moveStep(Number(b.dataset.down), 1); drawAll(); }; });
    box.querySelectorAll('[data-off]').forEach((b) => { b.onclick = () => { removeStep(Number(b.dataset.off)); drawAll(); }; });
    box.querySelectorAll('[data-noing]').forEach((b) => {
      b.onclick = () => { ings.splice(Number(b.dataset.noing), 1); drawAll(); };
    });
    box.querySelectorAll('[data-addfrom]').forEach((b) => {
      b.onclick = () => {
        const r = byId(b.dataset.addfrom);
        const found = remainingIngredients(r, haveIngredients(), servings).find((i) => i.name === b.dataset.name);
        if (found) ings.push({ ing: found, from: r.id, via: new Set(), manual: true });
        drawAll();
      };
    });
  };

  const drawSource = () => {
    $('#combine-tabs').innerHTML = chosen.map((r) => `<button type="button" class="chip${r.id === active ? ' active' : ''}" data-tab="${esc(r.id)}">${esc(r.title)}</button>`).join('');
    $('#combine-tabs').querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { active = b.dataset.tab; drawAll(); };
    });
    const r = byId(active);
    const list = stepsOf(r);
    $('#combine-source').innerHTML = list.length ? list.map((st) => {
      const at = picked.findIndex((p) => p.rid === r.id && p.i === st.i);
      return `<li><button type="button" class="combine-step${at >= 0 ? ' on' : ''}" data-pick="${st.i}"
        aria-pressed="${at >= 0}">${at >= 0 ? `<span class="num">${at + 1}</span>` : '<span class="num">+</span>'}
        <span>${esc(st.text)}${st.t != null ? ` <small>▶ ${formatTime(st.t)}</small>` : ''}</span></button></li>`;
    }).join('') : '<li class="hint">Dieses Rezept hat keine Schritte.</li>';
    $('#combine-source').querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.pick);
        const at = picked.findIndex((p) => p.rid === r.id && p.i === i);
        if (at >= 0) removeStep(at);
        else addStep(r.id, i);
        drawAll();
      };
    });
  };

  const drawAll = () => { drawRecipes(); drawNew(); drawSource(); };
  drawAll();

  $('#combine-add').onclick = async () => {
    const taken = new Set(chosen.map((x) => x.id));
    const picked2 = await chooseRecipeSheet(all.filter((x) => !taken.has(x.id)), new Map());
    if (!picked2) return;
    const r = all.find((x) => x.id === picked2.id);
    if (r) { chosen.push(r); active = r.id; }
    drawAll();
  };

  $('#combine-next').onclick = () => {
    if (!picked.length) { toast('Wähle zuerst Schritte aus.'); return; }
    if (chosen.length < 2) { toast('Füge mindestens ein zweites Rezept hinzu.'); return; }
    // Das neue Rezept wird im Formular geöffnet; gespeichert wird dort wie gewohnt.
    pendingNew = {
      title: combinedTitle(chosen.map((r) => r.title)),
      description: main.description,
      tags: [...new Set(chosen.flatMap((r) => r.tags))],
      servings,
      total_minutes: main.total_minutes,
      cook_minutes: main.cook_minutes,
      ingredients: haveIngredients(),
      steps: picked.map((p) => makeStep(p.text, p.t, p.v)),
      sources: [...new Set(chosen.flatMap((r) => r.sources))],
      notes: [main.notes, `Kombiniert aus ${chosen.map((r) => r.title).join(' und ')}.`].filter(Boolean).join('\n\n'),
      images: [],
      imagePaths: combinedImages(chosen), // Bilder aller beteiligten Rezepte werden kopiert
      combinedFrom: chosen.filter((r) => !r.from).map((r) => r.id),
    };
    location.hash = '#/neu';
  };
}

// Fragt nach dem Speichern, ob die Ausgangsrezepte gelöscht werden sollen.
async function askDeleteSources(sources) {
  const own = sources.filter(Boolean);
  if (!own.length) return;
  let busy = new Set();
  try {
    const [plan, items] = await Promise.all([
      loadPlan().catch(() => []),
      supabase.from('shopping_items').select('sources').then(({ data }) => data ?? []).catch(() => []),
    ]);
    busy = new Set([...plan.map((p) => p.recipe_id), ...recipesOnList(items).map((x) => x.recipe_id)]);
  } catch { /* Hinweis ist nur nett, nicht nötig */ }
  const warn = own.filter((r) => busy.has(r.id));
  const { value } = await openSheet(`<h2>${own.length === 1 ? 'Ausgangsrezept' : 'Ausgangsrezepte'} löschen?</h2>
    <p>Das kombinierte Rezept ist gespeichert und mit ${own.length === 1 ? 'dem Ausgangsrezept' : 'den Ausgangsrezepten'} als Alternative verknüpft.</p>
    <ul class="hint">${own.map((r) => `<li>${esc(r.title)}</li>`).join('')}</ul>
    ${warn.length ? `<p class="hint">${warn.map((r) => esc(r.title)).join(', ')} ${warn.length === 1 ? 'steht' : 'stehen'} noch im Essensplan oder auf einer Einkaufsliste.</p>` : ''}
    <p class="hint">Beim Löschen gehen auch die Bilder und die Verknüpfungen der Ausgangsrezepte weg.</p>
    <div class="row"><button class="btn ghost" value="keep">Behalten</button>
      <button class="btn danger" value="delete">Löschen</button></div>`);
  if (value !== 'delete') return;
  for (const r of own) {
    const { error } = await supabase.from('recipes').delete().eq('id', r.id);
    if (error) { toast(error.message); return; }
    if (r.images.length) await supabase.storage.from(IMAGE_BUCKET).remove(r.images);
    if (recipes) recipes = recipes.filter((x) => x.id !== r.id);
    if (links) links = links.filter((l) => l.recipe_a !== r.id && l.recipe_b !== r.id);
  }
  toast(own.length === 1 ? 'Ausgangsrezept gelöscht' : 'Ausgangsrezepte gelöscht');
}

// Rezept-Auswahl mit Suchfeld. Liefert { id, withGroup } oder null. withGroup = true,
// wenn auch alle Alternativen des gewählten Rezepts übernommen werden sollen.
function chooseRecipeSheet(candidates, altCount) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.innerHTML = `<form method="dialog" class="sheet-form">
      <h2>Rezept als Alternative</h2>
      <input id="alt-q" type="search" placeholder="Titel oder Tag" autocomplete="off" enterkeyhint="search">
      <div class="choices alt-hits" id="alt-hits"></div>
      <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>
    </form>`;
    document.body.append(dialog);
    const input = dialog.querySelector('#alt-q');
    const hits = dialog.querySelector('#alt-hits');
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const found = candidates
        .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)))
        .slice(0, 20);
      hits.innerHTML = found.length ? found.map((r) => {
        const n = altCount.get(r.id) ?? 0;
        return `<div class="alt-hit"><button type="button" class="btn ghost" data-pick="${esc(r.id)}">${esc(r.title)}</button>
          ${n ? `<button type="button" class="link" data-group="${esc(r.id)}">+ alle ${n} ${n === 1 ? 'Alternative' : 'Alternativen'} von „${esc(r.title)}“ übernehmen</button>` : ''}</div>`;
      }).join('') : '<p class="hint">Kein Rezept gefunden.</p>';
      hits.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => { done({ id: b.dataset.pick, withGroup: false }); };
      });
      hits.querySelectorAll('[data-group]').forEach((b) => {
        b.onclick = () => { done({ id: b.dataset.group, withGroup: true }); };
      });
    };
    let result = null;
    const done = (r) => { result = r; dialog.close(); };
    input.oninput = draw;
    draw();
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    dialog.showModal();
  });
}

async function renderEditor(id) {
  const [own] = await Promise.all([loadRecipes(), loadCategories(), loadAlternatives()]);
  const existing = id ? own.find((x) => x.id === id) : null;
  if (id && !existing) { location.hash = '#/'; return; }
  window.scrollTo(0, 0);
  // Aus dem Kombinieren kommt ein vorbelegtes Rezept; es gilt nur für dieses eine Formular.
  const combined = existing ? null : pendingNew;
  pendingNew = null;
  const r = existing || combined || {
    title: '', description: '', tags: [], servings: 2, total_minutes: null, cook_minutes: null,
    ingredients: [], steps: [], sources: [], notes: '', images: [],
  };
  let keptImages = [...r.images];
  let tags = [...r.tags];
  const toEdit = (s) => ({ text: stepText(s), t: stepTime(s), v: (typeof s === 'object' && s?.v) || null });
  let steps = r.steps.length ? r.steps.map(toEdit) : [toEdit('')];
  const knownTags = [...new Set((recipes || []).flatMap((x) => x.tags))].sort(collator.compare);
  let altIds = existing ? alternativeIds(links, existing.id) : [];
  let newFiles = [];

  app.innerHTML = `
    <form class="editor" id="editor">
      <a class="back" href="${existing ? `#/r/${existing.id}` : '#/'}">← Abbrechen</a>
      <h1>${existing ? 'Rezept bearbeiten' : combined ? 'Kombiniertes Rezept' : 'Neues Rezept'}</h1>

      ${existing || combined ? '' : `<div class="import card-panel">
        <label>Aus Link importieren
          <div class="import-row">
            <input type="url" id="import-url" inputmode="url" placeholder="https://www.chefkoch.de/rezepte/…" autocomplete="off">
            <button type="button" class="btn primary" id="import-btn">Importieren</button>
          </div>
          <small>Liest Titel, Zutaten, Zubereitung, Zeiten, Nährwerte und Bild aus, auch aus Videos von YouTube und TikTok. Danach kannst du alles anpassen.</small>
        </label>
        <div class="import-more">
          <div class="import-buttons">
            <label class="btn" id="import-photo-btn">📷 Aus Fotos<input type="file" id="import-photos" accept="image/*" multiple hidden></label>
            <label class="btn" id="import-video-btn">🎬 Aus Video<input type="file" id="import-video" accept="video/*" hidden></label>
            <button type="button" class="btn" id="import-text-btn">📝 Text einfügen</button>
          </div>
          <small><b>Fotos:</b> Kochbuchseite oder Rezeptkarte, gedruckt oder handschriftlich (bis zu 6).
            <b>Video:</b> ein gespeichertes TikTok oder Reel, wenn das Rezept nur im Video gesprochen oder eingeblendet wird (bis 50 MB).
            <b>Text:</b> z. B. ein Kommentar mit dem Rezept.</small>
        </div>
        <p class="hint" id="import-msg" role="status"></p>
      </div>`}

      <label>Titel <input name="title" required maxlength="200" value="${esc(r.title)}"></label>
      <label>Kurze Beschreibung <textarea name="description" rows="2">${esc(r.description)}</textarea></label>
      <fieldset>
        <legend>Tags</legend>
        <div class="chips static" id="tag-chips"></div>
        <div class="import-row">
          <input id="tag-input" list="known-tags" placeholder="Neuer Tag, z. B. vegetarisch" autocomplete="off" enterkeyhint="done">
          <button type="button" class="btn" id="tag-add">Hinzufügen</button>
        </div>
        <datalist id="known-tags">${knownTags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      </fieldset>

      <div class="cols">
        <label>Personen <input name="servings" type="number" min="1" max="100" required value="${r.servings}"></label>
        <label>Gesamtzeit (Min.) <input name="total_minutes" type="number" min="0" inputmode="numeric" value="${r.total_minutes ?? ''}"></label>
        <label>Koch-/Backzeit (Min.) <input name="cook_minutes" type="number" min="0" inputmode="numeric" value="${r.cook_minutes ?? ''}"></label>
      </div>

      <details class="nutrition-edit"${hasNutrition(r.nutrition) ? ' open' : ''}>
        <summary>Nährwerte</summary>
        <label class="nutrition-per">Angaben <select name="nutrition_per">
          <option value="Portion"${r.nutrition?.per !== '100 g' ? ' selected' : ''}>pro Portion</option>
          <option value="100 g"${r.nutrition?.per === '100 g' ? ' selected' : ''}>pro 100 g</option></select></label>
        <div class="nutrition-grid">${NUTRIENTS.map(([k, label, unit]) => `<label>${label} (${unit})
          <input name="n_${k}" type="number" min="0" step="any" inputmode="decimal" value="${r.nutrition?.[k] ?? ''}"></label>`).join('')}</div>
      </details>

      <label>Zutaten <textarea name="ingredients" rows="8" placeholder="200 g Mehl&#10;2 Eier&#10;1 Prise Salz">${esc(r.ingredients.map(ingredientToLine).join('\n'))}</textarea>
        <small>Eine Zutat pro Zeile, Menge zuerst. Die Menge bezieht sich auf die Personenzahl oben.</small></label>
      <ul class="parse-preview" id="preview"></ul>

      <fieldset>
        <legend>Zubereitung</legend>
        <ol class="step-edit" id="steps"></ol>
        <button type="button" class="btn small" id="step-add">+ Schritt hinzufügen</button>
        <div class="step-videos" id="step-videos"></div>
      </fieldset>
      <label>Notizen <textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
      <label>Quellen <textarea name="sources" rows="2" placeholder="https://… (ein Link pro Zeile)">${esc(r.sources.join('\n'))}</textarea></label>

      <fieldset id="alt-box">
        <legend>Alternativen</legend>
        ${linksTable ? `<div class="chips static" id="alt-chips"></div>
        <button type="button" class="btn small" id="alt-add">+ Alternative</button>
        <div id="alt-suggest"></div>
        <small>Verknüpfte Rezepte gelten in beide Richtungen. In der Rezeptansicht wechselst du mit Wischen zwischen ihnen.</small>`
    : '<p class="hint">Dafür fehlt noch der Schritt in der Datenbank: <code>supabase/alternativen.sql</code> im SQL-Editor ausführen (siehe README).</p>'}
      </fieldset>

      <fieldset>
        <legend>Bilder</legend>
        <div class="thumbs" id="thumbs"></div>
        <label class="btn file">Bilder hinzufügen<input type="file" accept="image/*" multiple id="files" hidden></label>
      </fieldset>

      <div class="actions">
        <button class="btn primary" id="save">Speichern</button>
        ${existing ? `<a class="btn" id="combine-link" href="#/kombinieren/${existing.id}">Mit anderem Rezept kombinieren</a>` : ''}
      </div>
    </form>`;

  const form = $('#editor');
  const preview = $('#preview');
  const drawPreview = () => {
    const items = parseIngredientText(form.ingredients.value);
    // Je Zutat Kategorie und Einkaufsorte; eine Änderung gilt für diese Zutat in allen Rezepten und Einkaufslisten.
    preview.innerHTML = items.map((i, n) => `<li><span class="qty">${esc(formatQuantity(i)) || '–'}</span><span>${ingredientLabel(i)}
      ${i.name ? `<button type="button" class="link place-link" data-place="${n}" aria-label="Orte von ${esc(i.name)} ändern">📍&nbsp;${esc(placeLabel(placesOf(i.name)))}</button>` : ''}</span>
      ${i.name ? `<select class="cat-select" data-cat="${n}" aria-label="Kategorie von ${esc(i.name)}">${categoryOptions(categoryOf(i.name))}</select>` : ''}</li>`).join('');
    preview.querySelectorAll('[data-cat]').forEach((sel) => {
      sel.onchange = () => setCategory(items[Number(sel.dataset.cat)].name, sel.value);
    });
    preview.querySelectorAll('[data-place]').forEach((b) => {
      b.onclick = async () => {
        const { name } = items[Number(b.dataset.place)];
        const ids = await choosePlaces(name);
        if (ids) { await setPlaces(name, ids); drawPreview(); }
      };
    });
  };
  form.ingredients.oninput = drawPreview;
  drawPreview();

  const thumbs = $('#thumbs');
  const drawThumbs = () => {
    thumbs.innerHTML = [
      ...keptImages.map((p, i) => `<div class="thumb"><img src="${esc(imageUrl(p))}" alt=""><button type="button" data-kept="${i}" aria-label="Bild entfernen">×</button></div>`),
      ...newFiles.map((f, i) => `<div class="thumb"><img src="${f.preview}" alt=""><button type="button" data-new="${i}" aria-label="Bild entfernen">×</button></div>`),
    ].join('');
    thumbs.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.kept != null) keptImages.splice(Number(b.dataset.kept), 1);
        else URL.revokeObjectURL(newFiles.splice(Number(b.dataset.new), 1)[0].preview);
        drawThumbs();
      };
    });
  };
  $('#files').onchange = (e) => {
    newFiles.push(...[...e.target.files].map((file) => ({ file, preview: URL.createObjectURL(file) })));
    e.target.value = '';
    drawThumbs();
  };
  drawThumbs();

  // Tags: einzeln hinzufügen, entfernen nur über das × am jeweiligen Tag.
  const tagInput = $('#tag-input');
  const drawTags = () => {
    $('#tag-chips').innerHTML = tags.length
      ? tags.map((t, i) => `<span class="chip tag-chip">${esc(t)}<button type="button" data-i="${i}" aria-label="Tag ${esc(t)} entfernen">×</button></span>`).join('')
      : '<span class="hint">Noch keine Tags</span>';
    app.querySelectorAll('#tag-chips button').forEach((b) => {
      b.onclick = () => { tags.splice(Number(b.dataset.i), 1); drawTags(); };
    });
  };
  const setTags = (list) => { tags = [...new Set(list.map((t) => t.trim()).filter(Boolean))]; drawTags(); };
  const addTag = () => {
    const parts = tagInput.value.split(',').map((t) => t.trim()).filter(Boolean);
    setTags([...tags, ...parts.filter((p) => !tags.some((t) => t.toLowerCase() === p.toLowerCase()))]);
    tagInput.value = '';
  };
  $('#tag-add').onclick = () => { addTag(); tagInput.focus(); };
  tagInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
  drawTags();

  // Schritte: jeder Schritt hat sein eigenes, nummeriertes Feld.
  const stepList = $('#steps');
  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  const drawSteps = () => {
    // Zeitstempel-Felder nur, wenn unter Quellen ein Video steht; die Auswahl des Videos
    // erst, wenn es mehrere sind.
    const videos = videosOf(form.sources.value.split('\n'));
    // Was in der Auswahl steht, gilt auch gespeichert: ohne Angabe ist es das erste Video.
    // Zeigt die Angabe auf ein Video, das es nicht mehr gibt, bleibt sie stehen; beim
    // Speichern verliert der Schritt dann seinen Zeitstempel.
    steps.forEach((st) => { if (st.t != null && !st.v && videos.length) st.v = videos[0].key; });
    stepList.innerHTML = steps.map((st, i) => `<li>
      <div class="step-head"><span>Schritt ${i + 1}</span>
        ${steps.length > 1 ? `<button type="button" class="link danger-link" data-remove="${i}">Entfernen</button>` : ''}</div>
      <textarea data-step="${i}" rows="2" aria-label="Schritt ${i + 1}">${esc(st.text)}</textarea>
      ${videos.length ? `<div class="step-time" data-time="${i}"><span>Stelle im Video</span>
        <input type="number" name="min" min="0" max="600" inputmode="numeric" placeholder="0" value="${st.t == null ? '' : Math.floor(st.t / 60)}" aria-label="Minuten für Schritt ${i + 1}"> Min.
        <input type="number" name="sec" min="0" max="59" inputmode="numeric" placeholder="0" value="${st.t == null ? '' : st.t % 60}" aria-label="Sekunden für Schritt ${i + 1}"> Sek.
        ${videos.length > 1 ? `<select name="video" aria-label="Video für Schritt ${i + 1}">${videos.map((v, n) => `<option value="${esc(v.key)}"${v.key === (st.v ?? videos[0].key) ? ' selected' : ''}>Video ${n + 1}</option>`).join('')}</select>` : ''}</div>` : ''}
    </li>`).join('');
    stepList.querySelectorAll('textarea').forEach((ta) => {
      grow(ta);
      ta.oninput = () => { steps[Number(ta.dataset.step)].text = ta.value; grow(ta); };
    });
    stepList.querySelectorAll('[data-time]').forEach((box) => {
      const [min, sec] = box.querySelectorAll('input');
      const pick = box.querySelector('select');
      box.oninput = () => {
        const m = Math.max(0, Math.floor(Number(min.value) || 0));
        const s = Math.max(0, Math.floor(Number(sec.value) || 0));
        const st = steps[Number(box.dataset.time)];
        st.t = min.value === '' && sec.value === '' ? null : m * 60 + s;
        if (st.t != null) st.v = pick ? pick.value : (videos[0]?.key ?? null);
      };
    });
    stepList.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = () => { steps.splice(Number(b.dataset.remove), 1); drawSteps(); };
    });
    // Nach dem Kombinieren hängen die Zeitstempel oft am falschen Video; damit setzt man
    // sie alle auf einmal um.
    const bar = $('#step-videos');
    const times = steps.filter((st) => st.t != null).length;
    bar.innerHTML = videos.length > 1 && times
      ? `<span class="hint">${times === 1 ? 'Zeitstempel' : `Alle ${times} Zeitstempel`} zuordnen:</span>
         ${videos.map((v, n) => `<button type="button" class="btn small" data-allvideo="${esc(v.key)}">Video ${n + 1}</button>`).join('')}`
      : '';
    bar.querySelectorAll('[data-allvideo]').forEach((b) => {
      b.onclick = () => {
        steps.forEach((st) => { if (st.t != null) st.v = b.dataset.allvideo; });
        drawSteps();
        toast('Zeitstempel zugeordnet. Noch speichern.');
      };
    });
  };
  // key: Video, zu dem die Zeitstempel importierter Schritte gehören.
  const setSteps = (list, key = null) => {
    steps = (list.length ? list : ['']).map(toEdit).map((st) => (st.t != null && key ? { ...st, v: key } : st));
    drawSteps();
  };
  form.sources.onchange = drawSteps;
  $('#step-add').onclick = () => {
    steps.push(toEdit(''));
    drawSteps();
    stepList.querySelector('li:last-child textarea').focus();
  };
  drawSteps();

  // Alternativen verwalten: Chips mit × zum Lösen, Suche und Vorschläge anhand gemeinsamer Tags.
  const altChips = $('#alt-chips');
  const drawAlts = () => {
    if (!altChips) return;
    const byId = new Map(own.map((x) => [x.id, x]));
    altChips.innerHTML = altIds.length
      ? altIds.map((x) => `<span class="chip">${esc(byId.get(x)?.title ?? 'Rezept')}
          <button type="button" data-unlink="${esc(x)}" aria-label="Verknüpfung lösen">×</button></span>`).join('')
      : '<span class="hint">Noch keine Alternative verknüpft.</span>';
    altChips.querySelectorAll('[data-unlink]').forEach((b) => {
      b.onclick = () => { altIds = altIds.filter((x) => x !== b.dataset.unlink); drawAlts(); };
    });
    const box = $('#alt-suggest');
    // Vorschläge: Rezepte mit gemeinsamen Tags, die noch nicht verknüpft sind.
    const base = { id: existing?.id ?? '', tags };
    const hidden = new Set(altIds);
    const suggestions = suggestAlternatives(base, own.filter((x) => !hidden.has(x.id)), [], { compare: collator.compare });
    box.innerHTML = suggestions.length ? `<p class="hint">Vorschläge nach gemeinsamen Tags:</p>
      <div class="chips static">${suggestions.map((x) => `<button type="button" class="chip add" data-link="${esc(x.id)}">+ ${esc(x.title)}</button>`).join('')}</div>` : '';
    box.querySelectorAll('[data-link]').forEach((b) => {
      b.onclick = () => { altIds = [...altIds, b.dataset.link]; drawAlts(); };
    });
  };
  drawAlts();
  const altAdd = $('#alt-add');
  if (altAdd) {
    altAdd.onclick = async () => {
      const hidden = new Set([existing?.id, ...altIds]);
      const candidates = own.filter((x) => !hidden.has(x.id));
      const altCount = new Map(candidates.map((x) => [x.id, alternativeIds(links, x.id).filter((o) => !hidden.has(o) && o !== existing?.id).length]));
      const picked = await chooseRecipeSheet(candidates, altCount);
      if (!picked) return;
      const add = [picked.id, ...(picked.withGroup ? alternativeIds(links, picked.id) : [])];
      altIds = [...new Set([...altIds, ...add])].filter((x) => x !== existing?.id);
      drawAlts();
    };
  }

  const setNutrition = (n) => {
    form.nutrition_per.value = n.per === '100 g' ? '100 g' : 'Portion';
    NUTRIENTS.forEach(([k]) => { form[`n_${k}`].value = n[k] ?? ''; });
    $('.nutrition-edit').open = true;
  };
  // Die Bilder der Ausgangsrezepte werden kopiert, damit sie auch bleiben, wenn die Rezepte
  // nach dem Kombinieren gelöscht werden.
  if (combined?.imagePaths?.length) {
    (async () => {
      for (const path of combined.imagePaths) {
        try {
          const res = await fetch(imageUrl(path));
          if (!res.ok) continue;
          const blob = await res.blob();
          const file = new File([blob], 'bild.jpg', { type: blob.type || 'image/jpeg' });
          newFiles.push({ file, preview: URL.createObjectURL(file) });
        } catch { /* ein fehlendes Bild hält das Speichern nicht auf */ }
      }
      drawThumbs();
    })();
  }

  // Kombinieren verlässt das Formular; ungespeicherte Änderungen wären sonst still weg.
  let dirty = false;
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  const combineLink = $('#combine-link');
  if (combineLink) {
    combineLink.onclick = async (e) => {
      if (!dirty) return;
      e.preventDefault();
      const { value } = await openSheet(`<h2>Änderungen verwerfen?</h2>
        <p>Beim Kombinieren entsteht ein neues Rezept. Was du hier gerade geändert hast, wird nicht gespeichert.</p>
        <div class="row"><button class="btn primary" value="go">Verwerfen und kombinieren</button>
          <button class="btn ghost" value="stay" formnovalidate>Hierbleiben</button></div>`);
      if (value === 'go') location.hash = `#/kombinieren/${existing.id}`;
    };
  }

  if (!existing && !combined) setupImport(form, { setTags, setSteps, addImage: (file) => { newFiles.push({ file, preview: URL.createObjectURL(file) }); drawThumbs(); }, drawPreview, setNutrition });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const save = $('#save');
    save.disabled = true;
    save.textContent = 'Speichere …';
    const recipeId = existing?.id || crypto.randomUUID();
    const uploaded = [];
    try {
      for (const { file } of newFiles) {
        const blob = await compressImage(file);
        const path = `${session.user.id}/${recipeId}/${crypto.randomUUID()}.jpg`;
        const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        uploaded.push(path);
      }
      if (tagInput.value.trim()) addTag();
      const num = (v) => (v === '' ? null : Math.max(0, Math.round(Number(v))));
      const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
      const sourceLines = lines(form.sources.value);
      // Wurde ein Video-Link aus den Quellen gelöscht, verlieren seine Schritte den Zeitstempel.
      const dropped = dropMissingTimes(
        steps.map((st) => makeStep(st.text.trim(), st.t, st.v)).filter((st) => stepText(st)),
        videosOf(sourceLines),
      );
      const row = {
        id: recipeId,
        title: form.title.value.trim(),
        description: form.description.value.trim(),
        tags,
        servings: Math.max(1, num(form.servings.value) || 1),
        total_minutes: num(form.total_minutes.value),
        cook_minutes: num(form.cook_minutes.value),
        ingredients: lines(form.ingredients.value).map(parseIngredientLine),
        steps: dropped.steps,
        sources: sourceLines,
        notes: form.notes.value.trim(),
        images: [...keptImages, ...uploaded],
      };
      const nutrition = { per: form.nutrition_per.value };
      NUTRIENTS.forEach(([k]) => {
        const v = form[`n_${k}`].value;
        if (v !== '' && Number(v) >= 0) nutrition[k] = Number(v);
      });
      // Die Spalte gibt es erst nach naehrwerte.sql; ohne Nährwerte wird sie deshalb nicht mitgeschickt.
      if (hasNutrition(nutrition)) row.nutrition = nutrition;
      else if (existing?.nutrition) row.nutrition = null;
      const { data, error } = await supabase.from('recipes').upsert(row).select().single();
      if (error) throw error;
      await rememberCategories(row.ingredients.map((i) => i.name));
      // Ein kombiniertes Rezept wird mit allen Ausgangsrezepten verknüpft.
      const wanted = [...new Set([...altIds, ...(combined?.combinedFrom ?? [])])].filter((x) => x !== data.id);
      if (linksTable) await saveAlternatives(data.id, wanted);

      const removed = existing ? existing.images.filter((p) => !keptImages.includes(p)) : [];
      if (removed.length) await supabase.storage.from(IMAGE_BUCKET).remove(removed);
      newFiles.forEach((f) => URL.revokeObjectURL(f.preview));

      if (recipes) {
        recipes = [...recipes.filter((x) => x.id !== data.id), data].sort((a, b) => collator.compare(a.title, b.title));
      }
      toast(dropped.dropped
        ? `Gespeichert. ${dropped.dropped} ${dropped.dropped === 1 ? 'Zeitstempel' : 'Zeitstempel'} ohne Video entfernt.`
        : 'Gespeichert');
      if (combined?.combinedFrom?.length) {
        await askDeleteSources(combined.combinedFrom.map((id) => own.find((x) => x.id === id)).filter(Boolean));
      }
      location.hash = `#/r/${data.id}`;
    } catch (err) {
      if (uploaded.length) await supabase.storage.from(IMAGE_BUCKET).remove(uploaded);
      toast(`Speichern fehlgeschlagen: ${err.message}`);
      save.disabled = false;
      save.textContent = 'Speichern';
    }
  };
}

// ---------- Planen ----------

const today = () => new Date().toLocaleDateString('sv-SE'); // JJJJ-MM-TT in Ortszeit

function formatDay(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const diff = Math.round((d - new Date(`${today()}T12:00:00`)) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long' });
}

// Kommende Einträge; vergangene werden dabei aufgeräumt.
async function loadPlan() {
  await supabase.from('meal_plan').delete().eq('owner_id', session.user.id).lt('planned_for', today());
  const { data, error } = await supabase.from('meal_plan').select('*')
    .eq('owner_id', session.user.id).gte('planned_for', today()).order('planned_for');
  if (error) throw error;
  return data;
}

function setupPlanning(r, currentServings) {
  const box = $('#planned');
  const drawPlanned = async () => {
    const { data } = await supabase.from('meal_plan').select('*')
      .eq('recipe_id', r.id).gte('planned_for', today()).order('planned_for');
    box.innerHTML = data?.length ? `<p class="planned-info">Eingeplant: ${data.map((p) => `<span class="chip">${esc(formatDay(p.planned_for))} · ${p.servings} P.</span>`).join(' ')}</p>` : '';
  };
  drawPlanned();

  $('#plan-btn').onclick = async () => { if (await planRecipe(r, currentServings())) drawPlanned(); };
}

// Dialog zum Einplanen; setzt die Zutaten auf Wunsch gleich auf die Einkaufsliste.
// Liefert true, wenn eingeplant wurde.
async function planRecipe(r, servings = r.servings) {
  const { value, form } = await openSheet(`<h2>„${esc(r.title)}“ einplanen</h2>
    <label>Datum <input type="date" name="date" required min="${today()}" value="${today()}"></label>
    <label>Personen <input type="number" name="servings" min="1" max="100" required value="${servings}"></label>
    ${r.ingredients.length ? '<label class="check"><input type="checkbox" name="shop" checked> Zutaten auf die Einkaufsliste setzen</label>' : ''}
    <div class="row">
      <button class="btn primary" value="ok">Einplanen</button>
      <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button>
    </div>`);
  if (value !== 'ok') return false;
  const count = Math.max(1, Math.min(100, Number(form.servings.value) || r.servings));
  const { data, error } = await supabase.from('meal_plan').insert({
    recipe_id: r.id, planned_for: form.date.value, servings: count,
  }).select().single();
  if (error) { toast(error.message); return false; }
  toast(`Eingeplant für ${formatDay(form.date.value)}`);
  if (form.shop?.checked) await addPlanToList([{ plan_id: data.id, recipe: r, servings: count }]);
  return true;
}

async function renderPlan() {
  app.innerHTML = '<p class="loading">Lade Plan …</p>';
  const [plan, own, onLists] = await Promise.all([loadPlan(), loadRecipes(), loadPlannedOnLists(), loadAlternatives()]);
  const byId = new Map(own.map((r) => [r.id, r]));
  const entries = plan.filter((p) => byId.has(p.recipe_id));
  if (!entries.length) {
    app.innerHTML = `<div class="empty"><h1>Noch nichts eingeplant</h1>
      <p>Öffne ein Rezept und tippe auf „Einplanen“, um es für einen Tag vorzumerken.</p>
      <a class="btn" href="#/">Zu den Rezepten</a></div>`;
    return;
  }
  const open = entries.filter((p) => !onLists.has(p.id));
  const days = [...new Set(entries.map((p) => p.planned_for))];
  app.innerHTML = `<h1>Plan</h1>
    <div id="plan-actions" class="plan-actions">${open.length
    ? `<button class="btn primary" id="shop-all">${open.length === entries.length ? 'Alle' : `Alle übrigen (${open.length})`} auf die Einkaufsliste</button>` : ''}</div>
    ${days.map((day) => `<section class="plan-day">
      <h2>${esc(formatDay(day))}</h2>
      <div class="suggestions">${entries.filter((p) => p.planned_for === day).map((p) => {
    const r = byId.get(p.recipe_id);
    return `<div class="suggestion plan-entry${altStack(r)}" data-id="${p.id}">
          ${r.images[0] ? `<img src="${esc(imageUrl(r.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
          <div><h3><a href="#/r/${r.id}">${esc(r.title)}</a>${altMark(r, byId)}</h3>
            <p class="missing">${p.servings} ${p.servings === 1 ? 'Person' : 'Personen'}${onLists.has(p.id) ? ' · <span class="on-list">✓ auf der Einkaufsliste</span>' : ''}</p>
            <div class="entry-actions">
              ${onLists.has(p.id) ? '' : `<button class="link" data-shop="${p.id}">Auf die Einkaufsliste</button>`}
              <button class="link danger-link" data-remove="${p.id}">Entfernen</button>
            </div></div>
        </div>`;
  }).join('')}</div>
    </section>`).join('')}`;

  const toShop = (list) => list.map((p) => ({ plan_id: p.id, recipe: byId.get(p.recipe_id), servings: p.servings }));
  app.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.remove;
      if (onLists.has(id)) {
        const title = byId.get(entries.find((p) => p.id === id).recipe_id).title;
        const { value } = await openSheet(`<h2>„${esc(title)}“ steht auf der Einkaufsliste</h2>
          <p>Sollen die Zutaten dafür auch von der Einkaufsliste genommen werden?</p>
          <div class="row"><button class="btn primary" value="both">Auch von der Liste nehmen</button>
            <button class="btn" value="plan">Nur aus dem Plan</button>
            <button class="btn ghost" value="cancel">Abbrechen</button></div>`);
        if (value !== 'both' && value !== 'plan') return;
        if (value === 'both' && !(await removePlanFromLists(id))) return;
      }
      const { error } = await supabase.from('meal_plan').delete().eq('id', id);
      if (error) toast(error.message); else renderPlan();
    };
  });
  app.querySelectorAll('[data-shop]').forEach((b) => {
    b.onclick = async () => {
      if (await addPlanToList(toShop(entries.filter((p) => p.id === b.dataset.shop)))) renderPlan();
    };
  });
  const all = $('#shop-all');
  if (all) all.onclick = async () => { if (await addPlanToList(toShop(open))) renderPlan(); };
}

// ---------- Einkaufen ----------

let listChannel = null;
let onListVisible = null;

function leaveShoppingList() {
  if (listChannel) { supabase.removeChannel(listChannel); listChannel = null; }
  if (onListVisible) { document.removeEventListener('visibilitychange', onListVisible); onListVisible = null; }
}

function rememberList(id) {
  try { localStorage.setItem('kochbuch.list', id); } catch { /* privater Modus */ }
}

function rememberedList() {
  try { return localStorage.getItem('kochbuch.list'); } catch { return null; }
}

// Alle Listen, die man sehen darf. Wer noch keine eigene hat, bekommt eine.
async function loadLists() {
  const { data, error } = await supabase.from('shopping_lists').select('*').order('created_at');
  if (error) throw error;
  if (data.some((l) => l.owner_id === session.user.id)) return data;
  const created = await supabase.from('shopping_lists').insert({ name: 'Einkaufsliste' }).select().single();
  if (created.error) throw created.error;
  return [created.data, ...data];
}

async function loadItems(listId) {
  const { data, error } = await supabase.from('shopping_items').select('*').eq('list_id', listId).order('created_at');
  if (error) throw error;
  return data;
}

// Nimmt die Zutaten eines Plan-Eintrags von allen Listen. Liefert false bei einem Fehler.
async function removePlanFromLists(planId) {
  const { data, error } = await supabase.from('shopping_items').select('*');
  if (error) { toast(error.message); return false; }
  const { updates, deletes } = removePlanEntry(data, planId);
  const results = await Promise.all([
    ...updates.map(({ id, ...patch }) => supabase.from('shopping_items').update(patch).eq('id', id)),
    deletes.length ? supabase.from('shopping_items').delete().in('id', deletes) : null,
  ].filter(Boolean));
  const failed = results.find((r) => r.error);
  if (failed) { toast(failed.error.message); return false; }
  return true;
}

// Welche Plan-Einträge schon auf irgendeiner Liste stehen.
async function loadPlannedOnLists() {
  const { data, error } = await supabase.from('shopping_items').select('sources');
  if (error) return new Set(); // z. B. wenn einkauf.sql noch nicht ausgeführt wurde
  return plannedIds(data);
}

// Einfacher Dialog von unten. Liefert den Wert des gedrückten Knopfs und das Formular.
function openSheet(html) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.innerHTML = `<form method="dialog" class="sheet-form">${html}</form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      resolve({ value: dialog.returnValue, form: dialog.querySelector('form') });
      dialog.remove();
    });
    dialog.showModal();
  });
}

const listLabel = (l) => (l.owner_id === session.user.id ? l.name : `${l.name} (geteilt)`);

async function chooseList(lists) {
  if (lists.length === 1) return lists[0];
  const current = rememberedList();
  const { value, form } = await openSheet(`<h2>Auf welche Liste?</h2>
    <div class="choices">${lists.map((l, i) => `<label class="check"><input type="radio" name="list" value="${l.id}"
      ${l.id === current || (!lists.some((x) => x.id === current) && i === 0) ? 'checked' : ''}> ${esc(listLabel(l))}</label>`).join('')}</div>
    <div class="row"><button class="btn primary" value="ok">Weiter</button>
      <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
  if (value !== 'ok') return null;
  return lists.find((l) => l.id === form.list.value) ?? null;
}

function sourceTitles(sources) {
  return [...new Set((sources ?? []).map((s) => s.title))].join(', ');
}

async function askMerge(item, addition, more) {
  const merged = mergeInto(item, addition);
  const { value, form } = await openSheet(`<h2>${esc(item.name)} steht schon auf der Liste</h2>
    <p>Auf der Liste: <strong>${esc(formatItemQuantity(item) || 'ohne Menge')}</strong>${item.sources?.length ? ` (${esc(sourceTitles(item.sources))})` : ''}<br>
      Dazu kommen: <strong>${esc(formatItemQuantity(addition) || 'ohne Menge')}</strong> (${esc(sourceTitles(addition.sources))})</p>
    ${more ? '<label class="check"><input type="checkbox" name="all"> Für alle weiteren doppelten Zutaten genauso</label>' : ''}
    <div class="row"><button class="btn primary" value="merge">Zusammenrechnen${merged.amount != null ? ` (${esc(formatItemQuantity({ ...item, amount: merged.amount }))})` : ''}</button>
      <button class="btn" value="new">Neuer Eintrag</button></div>`);
  return { choice: value === 'new' ? 'new' : 'merge', forAll: Boolean(form.all?.checked) };
}

// Setzt die Zutaten eingeplanter Rezepte auf eine Liste. Liefert true, wenn etwas passiert ist.
async function addPlanToList(entries) {
  try {
    const list = await chooseList(await loadLists());
    if (!list) return false;
    const items = await loadItems(list.id);
    const additions = additionsFromPlan(entries);
    await rememberCategories(additions.map((a) => a.name));
    const conflicts = additions.filter((a) => findConflict(a, items)).length;
    let asked = 0;
    let fixed = null;
    const inserts = [];
    for (const addition of additions) {
      const item = findConflict(addition, items);
      let choice = 'new';
      if (item) {
        asked += 1;
        if (fixed) choice = fixed;
        else {
          const answer = await askMerge(item, addition, conflicts - asked);
          choice = answer.choice;
          if (answer.forAll) fixed = choice;
        }
      }
      if (item && choice === 'merge') {
        const patch = mergeInto(item, addition);
        const { error } = await supabase.from('shopping_items').update(patch).eq('id', item.id);
        if (error) throw error;
        Object.assign(item, patch);
      } else {
        inserts.push({ list_id: list.id, name: addition.name, amount: addition.amount, unit: addition.unit, sources: addition.sources });
      }
    }
    if (inserts.length) {
      const { error } = await supabase.from('shopping_items').insert(inserts);
      if (error) throw error;
    }
    rememberList(list.id);
    toast(`${additions.length} ${additions.length === 1 ? 'Zutat' : 'Zutaten'} auf „${list.name}“`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

async function renderShopping(listId) {
  app.innerHTML = '<p class="loading">Lade Einkaufsliste …</p>';
  const [lists] = await Promise.all([loadLists(), loadCategories()]);
  const me = session.user.id;
  const list = lists.find((l) => l.id === listId)
    ?? lists.find((l) => l.id === rememberedList())
    ?? lists.find((l) => l.owner_id === me);
  if (listId && list.id !== listId) toast('Diese Liste gibt es nicht mehr.');
  rememberList(list.id);
  const isOwner = list.owner_id === me;
  const ownCount = lists.filter((l) => l.owner_id === me).length;
  let items = await loadItems(list.id);
  const people = await supabase.rpc('list_people', { p_list: list.id });
  const members = (people.data ?? []).filter((p) => !p.is_owner);
  const owner = (people.data ?? []).find((p) => p.is_owner);

  app.innerHTML = `
    <div class="list-head">
      <select id="list-select" aria-label="Einkaufsliste wählen">
        ${lists.map((l) => `<option value="${l.id}"${l.id === list.id ? ' selected' : ''}>${esc(listLabel(l))}</option>`).join('')}
        <option value="new">+ Neue Liste …</option>
      </select>
      <button class="btn small" id="manage" aria-expanded="false" aria-controls="list-settings">Verwalten</button>
      <select id="place-filter" aria-label="Nach Ort filtern">
        <option value="">Alle Orte</option>
        ${places.map((p) => `<option value="${esc(p.id)}"${placeFilter() === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <select id="item-sort" aria-label="Sortierung">
        ${[['added', 'Hinzugefügt'], ['name', 'A–Z'], ['category', 'Nach Kategorie'], ['recipe', 'Nach Rezept']].map(([v, l]) => `<option value="${v}"${shoppingSort() === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <section class="card-panel share-section list-settings" id="list-settings" hidden>
      <h2>${isOwner ? 'Liste verwalten' : 'Geteilte Liste'}</h2>
      ${isOwner ? `
        <div class="row">
          <button class="btn" id="rename">Umbenennen</button>
          ${ownCount > 1 ? '<button class="btn danger" id="delete-list">Liste löschen</button>' : ''}
        </div>
        ${ownCount > 1 ? '' : '<p class="hint">Deine einzige Liste kann nicht gelöscht werden.</p>'}
        <h3>Gemeinsam bearbeiten</h3>
        <p class="hint">Wer den Einladungslink öffnet und ein Konto hat, kann diese Liste mitbearbeiten.</p>
        <div class="row">
          <button class="btn primary" id="list-invite">${list.invite_token ? 'Einladungslink teilen' : 'Einladungslink erstellen'}</button>
          ${list.invite_token ? '<button class="btn ghost" id="list-invite-reset">Neuen Link erzeugen</button>' : ''}
        </div>
        ${members.length ? `<ul class="people">${members.map((p) => `<li><span>${esc(personName(p))}</span>
          <button class="link danger-link" data-member="${p.user_id}">Entfernen</button></li>`).join('')}</ul>` : ''}`
    : `<p class="hint">Geteilt von ${esc(owner ? personName(owner) : 'jemand anderem')}${members.length > 1 ? ` mit ${members.filter((p) => p.user_id !== me).map((p) => esc(personName(p))).join(', ')}` : ''}.</p>
        <div class="row"><button class="btn danger" id="leave-list">Austreten</button></div>`}
      <h3>Meine Einkaufsorte</h3>
      <p class="hint">Gelten für alle deine Listen. Welche Orte eine Zutat hat, änderst du, indem du den Eintrag nach rechts wischst.</p>
      <ul class="people" id="place-list"></ul>
      <form class="import-row" id="add-place">
        <input name="place" placeholder="Neuer Ort, z. B. Bäcker" maxlength="40" autocomplete="off" enterkeyhint="done" aria-label="Neuer Ort">
        <button class="btn">Hinzufügen</button>
      </form>
    </section>
    <form class="import-row add-item" id="add-item">
      <input name="item" placeholder="z. B. 1 l Milch" autocomplete="off" enterkeyhint="done" aria-label="Eintrag hinzufügen">
      <button class="btn">Hinzufügen</button>
    </form>
    <div id="list-recipes"></div>
    <ul class="shop-items" id="open-items"></ul>
    <div id="done-items"></div>`;

  const draw = () => {
    const sort = shoppingSort();
    const filter = placeIds().includes(placeFilter()) ? placeFilter() : '';
    const sorted = sortItems(items, sort).filter((i) => !filter || placesOf(i.name).includes(filter));
    const open = sorted.filter((i) => !i.checked);
    const done = sorted.filter((i) => i.checked);
    // Abhaken nur über die Checkbox; nach rechts wischen zeigt „Ändern“ (Menge und Kategorie).
    const row = (i) => `<li class="swipe${i.checked ? ' done' : ''}" data-item="${i.id}">
      <div class="swipe-actions start"><button type="button" class="swipe-btn accent" data-amount="${i.id}">Ändern</button></div>
      <div class="shop-row">
        <div class="shop-check"><input type="checkbox" data-check="${i.id}" ${i.checked ? 'checked' : ''} aria-label="${esc(i.name)} abhaken">
          <span><span class="qty">${esc(formatItemQuantity(i))}</span> ${esc(i.name)}
          ${i.sources?.length ? `<small>${esc(sourceTitles(i.sources))}${i.manual ? ' + von Hand' : ''}</small>` : ''}</span></div>
        <button class="icon-btn" data-del="${i.id}" aria-label="${esc(i.name)} löschen">×</button>
      </div></li>`;
    // Nach Rezept: Zwischenüberschriften, sobald ein neues Rezept beginnt.
    const rows = (list) => list.map((item, i) => {
      const groupBy = sort === 'category' ? (x) => categoryOf(x.name) : groupOf;
      const group = groupBy(item);
      const head = (sort === 'recipe' || sort === 'category') && (i === 0 || groupBy(list[i - 1]) !== group) ? `<li class="group-head">${esc(group)}</li>` : '';
      return head + row(item);
    }).join('');
    $('#open-items').innerHTML = open.length ? rows(open)
      : `<li class="hint empty-list">${done.length ? 'Alles erledigt.' : filter ? `Für ${esc(placeName(filter))} steht nichts auf der Liste.` : 'Die Liste ist leer. Füge oben etwas hinzu oder setze im Plan Rezepte auf die Liste.'}</li>`;
    $('#done-items').innerHTML = done.length ? `<div class="section-head done-head"><h2>Erledigt (${done.length})</h2>
      <button class="link danger-link" id="clear-done">Erledigte löschen</button></div>
      <ul class="shop-items">${rows(done)}</ul>` : '';
    const recs = recipesOnList(items);
    $('#list-recipes').innerHTML = recs.length ? `<p class="hint">Aus Rezepten:</p><div class="chips static">${recs.map((r) => `<span class="chip tag-chip">${esc(r.title)}
      <button type="button" data-recipe="${esc(r.recipe_id)}" aria-label="${esc(r.title)} von der Liste nehmen">×</button></span>`).join('')}</div>` : '';

    app.querySelectorAll('.shop-items .swipe').forEach((el) => enableSwipe(el, el.querySelector('.shop-row')));
    app.querySelectorAll('[data-amount]').forEach((b) => {
      b.onclick = async () => {
        closeSwipes();
        const item = items.find((i) => i.id === b.dataset.amount);
        const category = categoryOf(item.name);
        const itemPlaces = placesOf(item.name);
        const { value, form } = await openSheet(`<h2>${esc(item.name)}</h2>
          <label>Menge <input name="qty" value="${esc(formatItemQuantity(item))}" placeholder="z. B. 500 g oder 3" autocomplete="off" enterkeyhint="done"></label>
          <p class="hint">Leer lassen für „ohne Menge“.</p>
          <label>Kategorie <select name="category">${categoryOptions(category)}</select></label>
          <fieldset class="place-checks"><legend>Orte</legend>${placeChecks(itemPlaces)}</fieldset>
          <div class="row"><button class="btn primary" value="ok">Speichern</button>
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
        if (value !== 'ok') return;
        const newPlaces = checkedPlaces(form);
        const placesChanged = newPlaces.join() !== itemPlaces.join();
        if (form.category.value !== category || placesChanged) {
          await saveIngredientInfo(item.name, { category: form.category.value, places: newPlaces });
          if (placesChanged && !placesSaved && categoriesSaved) toast('Orte werden erst gespeichert, wenn orte.sql ausgeführt ist.');
          draw();
        }
        const text = form.qty.value.trim();
        if (text === formatItemQuantity(item)) return;
        const parsed = text ? parseIngredientLine(`${text} ${item.name}`) : { amount: null, unit: null };
        if (text && parsed.amount == null) { toast('Die Menge wurde nicht erkannt, z. B. „500 g“ oder „3“.'); return; }
        // Von Hand geänderte Mengen bleiben stehen, wenn das Rezept später von der Liste genommen wird.
        const patch = { amount: parsed.amountMax ?? parsed.amount, unit: parsed.unit, manual: true };
        Object.assign(item, patch);
        draw();
        const { error } = await supabase.from('shopping_items').update(patch).eq('id', item.id);
        if (error) toast(error.message);
      };
    });
    app.querySelectorAll('[data-check]').forEach((box) => {
      box.onchange = async () => {
        const item = items.find((i) => i.id === box.dataset.check);
        item.checked = box.checked;
        draw();
        const { error } = await supabase.from('shopping_items').update({ checked: item.checked }).eq('id', item.id);
        if (error) toast(error.message);
      };
    });
    app.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        items = items.filter((i) => i.id !== b.dataset.del);
        draw();
        const { error } = await supabase.from('shopping_items').delete().eq('id', b.dataset.del);
        if (error) toast(error.message);
      };
    });
    app.querySelectorAll('[data-recipe]').forEach((b) => {
      b.onclick = async () => {
        const rec = recs.find((r) => r.recipe_id === b.dataset.recipe);
        if (!confirm(`Alle Zutaten von „${rec.title}“ von der Liste nehmen?`)) return;
        const { updates, deletes } = removeRecipe(items, rec.recipe_id);
        const results = await Promise.all([
          ...updates.map(({ id, ...patch }) => supabase.from('shopping_items').update(patch).eq('id', id)),
          deletes.length ? supabase.from('shopping_items').delete().in('id', deletes) : null,
        ].filter(Boolean));
        const failed = results.find((r) => r.error);
        if (failed) toast(failed.error.message); else toast(`„${rec.title}“ von der Liste genommen`);
        await reload();
      };
    });
    const clear = $('#clear-done');
    if (clear) {
      clear.onclick = async () => {
        const ids = done.map((i) => i.id);
        items = items.filter((i) => !i.checked);
        draw();
        const { error } = await supabase.from('shopping_items').delete().in('id', ids);
        if (error) toast(error.message);
      };
    }
  };

  let reloading = null;
  const reload = async () => {
    if (reloading) return reloading;
    reloading = loadItems(list.id).then((fresh) => { items = fresh; draw(); })
      .catch(() => {}).finally(() => { reloading = null; });
    return reloading;
  };

  $('#item-sort').onchange = (e) => {
    try { localStorage.setItem('kochbuch.listSort', e.target.value); } catch { /* privater Modus */ }
    draw();
  };

  const drawPlaceFilter = () => {
    $('#place-filter').innerHTML = `<option value="">Alle Orte</option>${places.map((p) => `<option value="${esc(p.id)}"${placeFilter() === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  };
  $('#place-filter').onchange = (e) => {
    try { localStorage.setItem('kochbuch.listPlace', e.target.value); } catch { /* privater Modus */ }
    draw();
  };

  // Eigene Einkaufsorte anlegen, umbenennen und löschen.
  const needPlacesTable = () => {
    if (placesTable) return false;
    toast('Eigene Orte gibt es, sobald orte.sql ausgeführt ist.');
    return true;
  };
  const placesChanged = () => { drawPlaces(); drawPlaceFilter(); draw(); };
  const drawPlaces = () => {
    $('#place-list').innerHTML = places.map((p) => `<li><span>${esc(p.name)}</span><span class="row">
      <button type="button" class="link" data-rename-place="${esc(p.id)}">Umbenennen</button>
      ${places.length > 1 ? `<button type="button" class="link danger-link" data-delete-place="${esc(p.id)}">Löschen</button>` : ''}</span></li>`).join('');
    app.querySelectorAll('[data-rename-place]').forEach((b) => {
      b.onclick = async () => {
        if (needPlacesTable()) return;
        const place = places.find((p) => p.id === b.dataset.renamePlace);
        const name = prompt('Neuer Name des Orts:', place.name)?.trim().slice(0, 40);
        if (!name || name === place.name) return;
        if (places.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast('Diesen Ort gibt es schon.'); return; }
        const { error } = await supabase.from('shopping_places').update({ name }).eq('id', place.id);
        if (error) { toast(error.message); return; }
        place.name = name;
        placesChanged();
      };
    });
    app.querySelectorAll('[data-delete-place]').forEach((b) => {
      b.onclick = async () => {
        if (needPlacesTable()) return;
        const place = places.find((p) => p.id === b.dataset.deletePlace);
        const { value } = await openSheet(`<h2>„${esc(place.name)}“ löschen?</h2>
          <p class="hint">Der Ort verschwindet bei allen Zutaten.</p>
          <div class="row"><button class="btn danger" value="ok">Löschen</button>
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
        if (value !== 'ok') return;
        const { error } = await supabase.from('shopping_places').delete().eq('id', place.id);
        if (error) { toast(error.message); return; }
        places = places.filter((p) => p !== place);
        placesChanged();
      };
    });
  };
  drawPlaces();
  $('#add-place').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.place;
    const name = input.value.trim().slice(0, 40);
    if (!name || needPlacesTable()) return;
    if (places.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast('Diesen Ort gibt es schon.'); return; }
    const place = { id: crypto.randomUUID(), name };
    const { error } = await supabase.from('shopping_places').insert({ ...place, position: places.length });
    if (error) { toast(error.message); return; }
    places.push(place);
    input.value = '';
    placesChanged();
  };

  $('#list-select').onchange = async (e) => {
    if (e.target.value !== 'new') { location.hash = `#/einkauf/${e.target.value}`; return; }
    e.target.value = list.id;
    const name = prompt('Name der neuen Liste:', 'Wocheneinkauf')?.trim();
    if (!name) return;
    const { data, error } = await supabase.from('shopping_lists').insert({ name: name.slice(0, 80) }).select().single();
    if (error) { toast(error.message); return; }
    location.hash = `#/einkauf/${data.id}`;
  };

  const input = $('#add-item').item;
  $('#add-item').onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const parsed = parseIngredientLine(text);
    input.value = '';
    const { data, error } = await supabase.from('shopping_items').insert({
      list_id: list.id,
      name: (parsed.name || text).slice(0, 200),
      amount: parsed.amountMax ?? parsed.amount,
      unit: parsed.unit,
      manual: true,
    }).select().single();
    if (error) { toast(error.message); input.value = text; return; }
    if (!items.some((i) => i.id === data.id)) items.push(data);
    rememberCategories([data.name]);
    draw();
    input.focus();
  };

  const byId = (sel) => app.querySelector(sel);
  byId('#manage').onclick = (e) => {
    const box = byId('#list-settings');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
  };
  if (byId('#rename')) {
    byId('#rename').onclick = async () => {
      const name = prompt('Neuer Name:', list.name)?.trim();
      if (!name || name === list.name) return;
      const { error } = await supabase.from('shopping_lists').update({ name: name.slice(0, 80) }).eq('id', list.id);
      if (error) toast(error.message); else renderShopping(list.id);
    };
  }
  if (byId('#delete-list')) {
    byId('#delete-list').onclick = async () => {
      if (!confirm(`„${list.name}“ mit allen Einträgen löschen?${members.length ? ' Auch für alle, mit denen du sie teilst.' : ''}`)) return;
      const { error } = await supabase.from('shopping_lists').delete().eq('id', list.id);
      if (error) { toast(error.message); return; }
      rememberList('');
      location.hash = '#/einkauf';
    };
  }
  const invite = async (reset) => {
    const before = list.invite_token;
    let token = before;
    if (!token || reset) {
      const { data, error } = await supabase.from('shopping_lists').update({ invite_token: crypto.randomUUID() })
        .eq('id', list.id).select('invite_token').single();
      if (error) { toast(error.message); return; }
      token = data.invite_token;
    }
    await shareLink(appUrl(`liste/${token}`), list.name);
    if (token !== before) renderShopping(list.id);
  };
  if (byId('#list-invite')) byId('#list-invite').onclick = () => invite(false);
  if (byId('#list-invite-reset')) {
    byId('#list-invite-reset').onclick = () => {
      if (confirm('Der bisherige Einladungslink funktioniert danach nicht mehr. Wer schon mitmacht, bleibt dabei. Fortfahren?')) invite(true);
    };
  }
  app.querySelectorAll('[data-member]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Diese Person von der Liste entfernen?')) return;
      const { error } = await supabase.from('shopping_list_members').delete().eq('list_id', list.id).eq('user_id', b.dataset.member);
      if (error) toast(error.message); else renderShopping(list.id);
    };
  });
  if (byId('#leave-list')) {
    byId('#leave-list').onclick = async () => {
      if (!confirm(`Aus „${list.name}“ austreten? Die Liste verschwindet dann bei dir. Um wieder mitzumachen, brauchst du einen neuen Einladungslink.`)) return;
      const { error } = await supabase.from('shopping_list_members').delete().eq('list_id', list.id).eq('user_id', me);
      if (error) { toast(error.message); return; }
      rememberList('');
      location.hash = '#/einkauf';
    };
  }

  draw();

  // Änderungen der anderen live übernehmen. Löschungen kommen ohne list_id an, deshalb dann immer neu laden.
  leaveShoppingList();
  listChannel = supabase.channel(`liste-${list.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shopping_items' }, (payload) => {
      if (payload.eventType === 'DELETE' || payload.new?.list_id === list.id) reload();
    })
    .subscribe();
  onListVisible = () => { if (document.visibilityState === 'visible') reload(); };
  document.addEventListener('visibilitychange', onListVisible);
}

function placeFilter() {
  try { return localStorage.getItem('kochbuch.listPlace') || ''; } catch { return ''; }
}

function shoppingSort() {
  try { return localStorage.getItem('kochbuch.listSort') || 'added'; } catch { return 'added'; }
}

const groupOf = (item) => item.sources?.[0]?.title ?? 'Von Hand';

function sortItems(items, sort) {
  const list = [...items];
  if (sort === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
  if (sort === 'category') {
    list.sort((a, b) => categoryRank(categoryOf(a.name)) - categoryRank(categoryOf(b.name)) || collator.compare(a.name, b.name));
  }
  if (sort === 'recipe') {
    list.sort((a, b) => (!a.sources?.length - !b.sources?.length)
      || collator.compare(groupOf(a), groupOf(b)) || collator.compare(a.name, b.name));
  }
  return list;
}

async function acceptListInvite(token) {
  app.innerHTML = '<p class="loading">Nehme Einladung an …</p>';
  const { data: listId, error } = await supabase.rpc('accept_list_invite', { p_token: token });
  if (error) {
    app.innerHTML = `<div class="notice"><p>${esc(error.message)}</p><a class="btn" href="#/einkauf">Zu meinen Einkaufslisten</a></div>`;
    return;
  }
  toast('Du kannst die Liste jetzt mitbearbeiten');
  location.replace(`#/einkauf/${listId}`);
}

// ---------- Teilen ----------

function appUrl(path) {
  return `${location.origin}${location.pathname}#/${path}`;
}

// Öffnet auf dem iPhone das Teilen-Menü (WhatsApp, Nachrichten …), sonst wird der Link kopiert.
async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link kopiert');
  } catch {
    prompt('Link zum Kopieren:', url);
  }
}

// Kopiert ein fremdes Rezept samt Bildern ins eigene Kochbuch.
async function copyRecipe(r, button) {
  button.disabled = true;
  button.textContent = 'Übernehme …';
  const id = crypto.randomUUID();
  const uploaded = [];
  try {
    for (const p of r.images) {
      const res = await fetch(imageUrl(p));
      if (!res.ok) continue;
      const blob = await res.blob();
      const path = `${session.user.id}/${id}/${crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg' });
      if (error) throw error;
      uploaded.push(path);
    }
    const row = {
      id,
      title: r.title,
      description: r.description,
      tags: r.tags,
      servings: r.servings,
      total_minutes: r.total_minutes,
      cook_minutes: r.cook_minutes,
      ingredients: r.ingredients,
      steps: r.steps,
      sources: r.sources,
      notes: r.notes,
      images: uploaded,
      ...(hasNutrition(r.nutrition) ? { nutrition: r.nutrition } : {}),
    };
    const { data, error } = await supabase.from('recipes').insert(row).select().single();
    if (error) throw error;
    // Eigene Kategorien gelten automatisch; neue Zutaten bekommen einen Vorschlag.
    await rememberCategories(r.ingredients.map((i) => i.name));
    if (recipes) recipes = [...recipes, data].sort((a, b) => collator.compare(a.title, b.title));
    toast('In dein Kochbuch übernommen');
    location.hash = `#/r/${data.id}`;
  } catch (err) {
    if (uploaded.length) await supabase.storage.from(IMAGE_BUCKET).remove(uploaded);
    toast(`Übernehmen fehlgeschlagen: ${err.message}`);
    button.disabled = false;
    button.textContent = 'In mein Kochbuch übernehmen';
  }
}

async function renderSharedLink(token) {
  app.innerHTML = '<p class="loading">Lade Rezept …</p>';
  const { data, error } = await supabase.rpc('get_shared_recipe', { p_token: token });
  if (error) throw error;
  const r = data?.[0];
  if (!r) {
    app.innerHTML = `<div class="notice"><p>Dieses Rezept wird nicht mehr geteilt.</p>
      ${session ? '<a class="btn" href="#/">Zu meinen Rezepten</a>' : ''}</div>`;
    return;
  }
  if (session && r.owner_id === session.user.id) {
    showRecipe(r, { own: false, back: `#/r/${r.id}`, backLabel: 'Zu deinem Rezept', from: 'So sehen andere dein geteiltes Rezept.' });
    $('.actions').innerHTML = '';
    return;
  }
  showRecipe(r, { own: false, back: session ? '#/' : '', backLabel: 'Meine Rezepte', from: 'Geteiltes Rezept' });
}

async function loadPeople() {
  const { data, error } = await supabase.rpc('cookbook_people');
  if (error) throw error;
  const me = session.user.id;
  return {
    readers: data.filter((p) => p.owner_id === me),
    owners: data.filter((p) => p.reader_id === me),
  };
}

async function renderSharing() {
  app.innerHTML = `<p class="loading">Lade …</p>`;
  const [own, people, invite] = await Promise.all([
    loadRecipes(),
    loadPeople(),
    supabase.from('cookbook_invites').select('token').maybeSingle(),
  ]);
  if (invite.error) throw invite.error;
  const token = invite.data?.token;
  const sharedRecipes = own.filter((r) => r.share_token);
  const { readers, owners } = people;

  app.innerHTML = `
    ${myName ? `<section class="card-panel share-section">
      <h2>Dein Benutzername</h2>
      <div class="row"><strong>${esc(myName)}</strong><button class="btn small" id="rename-me">Ändern</button></div>
      <p class="hint">Diesen Namen sehen andere, wenn du etwas mit ihnen teilst.</p>
    </section>` : ''}
    <section class="card-panel share-section">
      <h2>Mit mir geteilte Kochbücher</h2>
      ${owners.length ? `<ul class="people">${owners.map((o) => `<li>
          <a href="#/kochbuch/${o.owner_id}">Kochbuch von ${esc(ownerName(o))}</a>
          <button class="link danger-link" data-leave="${o.owner_id}">Verlassen</button>
        </li>`).join('')}</ul>`
        : '<p class="hint">Noch keine. Wenn dir jemand einen Einladungslink schickt, erscheint sein Kochbuch hier.</p>'}
    </section>

    <section class="card-panel share-section">
      <h2>Mein Kochbuch freigeben</h2>
      <p class="hint">Wer den Einladungslink öffnet und ein Konto hat, kann alle deine Rezepte ansehen und übernehmen, aber nichts ändern.</p>
      ${token ? `<div class="row">
          <button class="btn primary" id="invite-share">Einladungslink teilen</button>
          <button class="btn ghost" id="invite-reset">Neuen Link erzeugen</button>
        </div>
        <p class="hint">Ein neuer Link macht den alten ungültig. Wer schon Zugriff hat, behält ihn.</p>`
        : '<button class="btn primary" id="invite-create">Einladungslink erstellen</button>'}
      <h3>Lesezugriff haben</h3>
      ${readers.length ? `<ul class="people">${readers.map((p) => `<li>
          <span>${esc(readerName(p))}</span>
          <button class="link danger-link" data-remove="${p.reader_id}">Entfernen</button>
        </li>`).join('')}</ul>` : '<p class="hint">Noch niemand.</p>'}
    </section>

    <section class="card-panel share-section">
      <h2>Einzeln geteilte Rezepte</h2>
      ${sharedRecipes.length ? `<ul class="people">${sharedRecipes.map((r) => `<li>
          <a href="#/r/${r.id}">${esc(r.title)}</a>
          <button class="link" data-share="${r.id}">Link teilen</button>
        </li>`).join('')}</ul>`
        : '<p class="hint">Öffne ein Rezept und tippe auf „Teilen“, um es per Link zu verschicken.</p>'}
    </section>`;

  const createInvite = async (reset) => {
    const query = reset
      ? supabase.from('cookbook_invites').update({ token: crypto.randomUUID() }).eq('owner_id', session.user.id).select('token').single()
      : supabase.from('cookbook_invites').insert({}).select('token').single();
    const { data, error } = await query;
    if (error) { toast(error.message); return; }
    await shareLink(appUrl(`einladung/${data.token}`), 'Mein Kochbuch');
    renderSharing();
  };
  const byId = (id) => app.querySelector(id);
  if (byId('#rename-me')) {
    byId('#rename-me').onclick = async () => {
      let problem = '';
      for (;;) {
        const { value, form } = await openSheet(`<h2>Benutzername ändern</h2>
          <label>Benutzername <input name="username" required minlength="3" maxlength="30" value="${esc(myName)}" autocapitalize="off"></label>
          <p class="hint">${esc(problem || USERNAME_HINT)}</p>
          <div class="row"><button class="btn primary" value="ok">Speichern</button>
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
        if (value !== 'ok') return;
        problem = await saveMyName(form.username.value);
        if (!problem) break;
      }
      toast('Benutzername gespeichert');
      renderSharing();
    };
  }
  if (byId('#invite-create')) byId('#invite-create').onclick = () => createInvite(false);
  if (byId('#invite-share')) byId('#invite-share').onclick = () => shareLink(appUrl(`einladung/${token}`), 'Mein Kochbuch');
  if (byId('#invite-reset')) {
    byId('#invite-reset').onclick = () => {
      if (confirm('Der bisherige Einladungslink funktioniert danach nicht mehr. Fortfahren?')) createInvite(true);
    };
  }
  app.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Lesezugriff entfernen?')) return;
      const { error } = await supabase.from('cookbook_readers').delete()
        .eq('owner_id', session.user.id).eq('reader_id', b.dataset.remove);
      if (error) toast(error.message); else renderSharing();
    };
  });
  app.querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Dieses Kochbuch verlassen? Du brauchst dann einen neuen Einladungslink.')) return;
      const { error } = await supabase.from('cookbook_readers').delete()
        .eq('owner_id', b.dataset.leave).eq('reader_id', session.user.id);
      if (error) toast(error.message); else renderSharing();
    };
  });
  app.querySelectorAll('[data-share]').forEach((b) => {
    const r = own.find((x) => x.id === b.dataset.share);
    b.onclick = () => shareLink(appUrl(`teilen/${r.share_token}`), r.title);
  });
}

async function acceptInvite(token) {
  app.innerHTML = '<p class="loading">Nehme Einladung an …</p>';
  const { data: owner, error } = await supabase.rpc('accept_cookbook_invite', { p_token: token });
  if (error) {
    app.innerHTML = `<div class="notice"><p>${esc(error.message)}</p><a class="btn" href="#/">Zu meinen Rezepten</a></div>`;
    return;
  }
  if (owner === session.user.id) {
    toast('Das ist dein eigener Einladungslink');
    location.replace('#/geteilt');
    return;
  }
  toast('Einladung angenommen');
  location.replace(`#/kochbuch/${owner}`);
}

const cookbookCache = new Map();

async function loadCookbook(ownerId) {
  if (cookbookCache.has(ownerId)) return cookbookCache.get(ownerId);
  const [{ data, error }, people] = await Promise.all([
    supabase.from('recipes').select('*').eq('owner_id', ownerId),
    loadPeople(),
  ]);
  if (error) throw error;
  const owner = people.owners.find((o) => o.owner_id === ownerId);
  if (!owner) return null;
  const book = { email: ownerName(owner), recipes: data.sort((a, b) => collator.compare(a.title, b.title)) };
  cookbookCache.set(ownerId, book);
  return book;
}

async function renderCookbook(ownerId) {
  app.innerHTML = '<p class="loading">Lade Kochbuch …</p>';
  cookbookCache.delete(ownerId);
  const [book] = await Promise.all([loadCookbook(ownerId), loadAlternatives()]);
  if (!book) {
    app.innerHTML = '<div class="notice"><p>Du hast keinen Zugriff (mehr) auf dieses Kochbuch.</p><a class="btn" href="#/geteilt">Zurück</a></div>';
    return;
  }
  app.innerHTML = `
    <a class="back" href="#/geteilt">← Geteilt</a>
    <h1>Kochbuch von ${esc(book.email)}</h1>
    <div class="search"><input type="search" id="q" placeholder="Rezepte durchsuchen" aria-label="Rezepte durchsuchen"></div>
    <div id="results" class="grid"></div>`;
  const byId = new Map(book.recipes.map((r) => [r.id, r]));
  const draw = (q = '') => {
    const shown = book.recipes.filter((r) => !q || [r.title, r.description, ...r.tags].some((x) => x.toLowerCase().includes(q)));
    $('#results').innerHTML = shown.length
      ? shown.map((r) => recipeCard(r, `#/kochbuch/${ownerId}/${r.id}`, byId)).join('')
      : '<p class="hint">Keine Rezepte gefunden.</p>';
  };
  $('#q').oninput = (e) => draw(e.target.value.trim().toLowerCase());
  draw();
}

async function renderCookbookRecipe(ownerId, recipeId, altId = null) {
  const [book] = await Promise.all([loadCookbook(ownerId), loadAlternatives()]);
  const r = book?.recipes.find((x) => x.id === recipeId);
  if (!r) {
    app.innerHTML = '<div class="notice"><p>Dieses Rezept gibt es nicht (mehr).</p><a class="btn" href="#/geteilt">Zurück</a></div>';
    return;
  }
  // Auch in einem freigegebenen Kochbuch kann man zu den Alternativen wischen.
  const group = alternativeGroup(r, links, book.recipes, collator.compare);
  const index = altId ? group.findIndex((x) => x.id === altId) : 0;
  if (index < 0) { location.hash = `#/kochbuch/${ownerId}/${recipeId}`; return; }
  showRecipe(group[index], {
    own: false,
    back: `#/kochbuch/${ownerId}`,
    backLabel: `Kochbuch von ${book.email}`,
    group,
    index,
    hrefOf: (i) => (i === 0 ? `#/kochbuch/${ownerId}/${recipeId}` : `#/kochbuch/${ownerId}/${recipeId}/${group[i].id}`),
  });
}

function importMessage(data) {
  if (data.photos) {
    return data.ingredients?.length || data.steps?.length
      ? 'Vom Foto übernommen. Die KI kann sich verlesen, besonders bei Handschrift: Prüfe alles, dann tippe auf Speichern.'
      : 'Auf den Fotos wurde kein Rezept erkannt. Versuche es mit einem schärferen, hellen Foto.';
  }
  if (data.uploaded) {
    return data.ingredients?.length || data.steps?.length
      ? 'Aus dem Video übernommen. Die KI kann sich irren: Prüfe Mengen, Schritte und Zeitstempel, dann tippe auf Speichern.'
      : 'Im Video wurde kein Rezept erkannt.';
  }
  if (data.pasted) {
    return data.ingredients?.length || data.steps?.length
      ? 'Aus dem Text übernommen. Prüfe die Angaben und tippe auf Speichern.'
      : 'Im Text wurde kein Rezept erkannt.';
  }
  if (data.ingredients?.length) {
    if (!data.video) return 'Importiert. Prüfe die Angaben und tippe auf Speichern.';
    // ai_from sagt, woraus das Rezept kommt; bei TikTok sind das die Untertitel oder die Bilder.
    const from = {
      subtitles: 'Aus den Untertiteln des TikToks übernommen. Prüfe Mengen, Schritte und Zeitstempel, dann tippe auf Speichern.',
      photos: 'Aus den Bildern des TikToks übernommen. Prüfe Mengen und Schritte, dann tippe auf Speichern.',
      description: 'Aus dem Text zum Video übernommen. Prüfe Mengen und Schritte, dann tippe auf Speichern.',
    }[data.ai_from];
    return from ?? 'Aus dem Video übernommen. Die KI kann sich irren: Prüfe Mengen, Schritte und Zeitstempel, dann tippe auf Speichern.';
  }
  if (!data.video) return 'Auf dieser Seite wurden keine Rezeptdaten gefunden. Titel und Bild sind übernommen, den Rest bitte selbst ergänzen.';
  if (data.ai === 'none') return 'Video übernommen. Für Zutaten und Schritte fehlt in Supabase noch das Secret GEMINI_API_KEY (siehe README).';
  if (data.ai === 'failed') return `Video übernommen, aber die Auswertung hat nicht geklappt${data.ai_error ? ` (${data.ai_error})` : ''}. Die Videobeschreibung steht in den Notizen.`;
  if (data.video.provider === 'tiktok') return 'In Untertiteln, Bildern und Text zum TikTok steht kein Rezept. Tippe in TikTok auf „Teilen“ → „Video speichern“ und lade das Video hier mit „🎬 Aus Video“ hoch. Titel, Bild und Link sind schon übernommen.';
  return 'Im Video wurde kein Rezept gefunden. Titel, Bild und Link sind übernommen, den Rest bitte selbst ergänzen.';
}

// Import per Link: die Edge Function "import-recipe" lädt die Seite und liest das Rezept aus.
// Bei Videos (YouTube, TikTok) wertet sie das Video mit Gemini aus.
function setupImport(form, { setTags, setSteps, addImage, drawPreview, setNutrition }) {
  const input = $('#import-url');
  const btn = $('#import-btn');
  const photoInput = $('#import-photos');
  const photoBtn = $('#import-photo-btn');
  const videoInput = $('#import-video');
  const videoBtn = $('#import-video-btn');
  const textBtn = $('#import-text-btn');
  const msg = $('#import-msg');

  const busy = (on) => {
    btn.disabled = on;
    textBtn.disabled = on;
    for (const b of [photoBtn, videoBtn]) b.classList.toggle('disabled', on);
    photoInput.disabled = on;
    videoInput.disabled = on;
    btn.textContent = on ? 'Lade …' : 'Importieren';
  };

  const invoke = async (body) => {
    const { data, error } = await supabase.functions.invoke('import-recipe', { body });
    if (error) {
      let detail = error.message;
      const status = error.context?.status;
      try { detail = (await error.context.json()).error || detail; } catch { /* keine JSON-Antwort */ }
      if (status === 404) detail = 'Die Import-Funktion ist in Supabase noch nicht eingerichtet (siehe README).';
      throw new Error(detail);
    }
    return data;
  };

  const fill = async (data) => {
    if (data.title) form.title.value = data.title;
    if (data.description) form.description.value = data.description;
    if (data.tags?.length) setTags(data.tags);
    if (data.servings) form.servings.value = data.servings;
    if (data.total_minutes != null) form.total_minutes.value = data.total_minutes;
    if (data.cook_minutes != null) form.cook_minutes.value = data.cook_minutes;
    if (data.ingredients?.length) form.ingredients.value = data.ingredients.join('\n');
    if (data.steps?.length) setSteps(data.steps);
    if (data.nutrition) setNutrition(data.nutrition);
    if (data.notes) form.notes.value = [form.notes.value.trim(), data.notes].filter(Boolean).join('\n\n');
    const sources = form.sources.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (data.source && !sources.includes(data.source)) form.sources.value = [...sources, data.source].join('\n');
    // Zeitstempel-Felder erscheinen erst mit dem Video-Link; die Schritte merken sich das Video.
    if (data.video) setSteps(data.steps ?? [], videoKey(data.video));
    if (data.image) {
      const blob = await (await fetch(data.image)).blob();
      addImage(new File([blob], 'import.jpg', { type: blob.type }));
    }
    drawPreview();
    msg.textContent = importMessage(data);
  };

  const run = async () => {
    const url = input.value.trim();
    if (!safeUrl(url)) { msg.textContent = 'Bitte einen vollständigen Link (https://…) einfügen.'; return; }
    busy(true);
    msg.textContent = videoOf([url]) || /tiktok\.com/i.test(url)
      ? 'Das Video wird ausgewertet. Das kann bis zu einer Minute dauern …' : '';
    try {
      await fill(await invoke({ url }));
      input.value = '';
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    } finally {
      busy(false);
    }
  };
  btn.onclick = run;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };

  // Fotos von Kochbuchseiten oder Rezeptkarten: verkleinert an die Edge Function, Gemini liest sie ab.
  photoInput.onchange = async () => {
    const files = [...photoInput.files].slice(0, 6);
    photoInput.value = '';
    if (!files.length) return;
    busy(true);
    msg.textContent = `${files.length === 1 ? 'Das Foto wird' : `${files.length} Fotos werden`} ausgewertet. Das kann bis zu einer Minute dauern …`;
    try {
      const images = await Promise.all(files.map(async (f) => blobToDataUrl(await compressImage(f, 2000, 0.85))));
      await fill(await invoke({ images }));
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    } finally {
      busy(false);
    }
  };

  // Gespeichertes Video (z. B. ein TikTok): kurz in den eigenen Speicherordner, die Edge Function
  // gibt es an Gemini weiter und löscht es danach. Ein Video-Link im Feld oder in den Quellen
  // wird mitgeschickt, damit Titel, Bild und das Springen zu den Zeitstempeln funktionieren.
  videoInput.onchange = async () => {
    const file = videoInput.files[0];
    videoInput.value = '';
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) { msg.textContent = 'Das Video ist größer als 50 MB. Kürze es oder nimm eine kleinere Qualität.'; return; }
    const ext = VIDEO_EXT[file.type] ?? file.name.match(/\.(mp4|mov|webm|m4v|3gp)$/i)?.[1].toLowerCase() ?? 'mp4';
    const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
    const links = [input.value.trim(), ...form.sources.value.split('\n').map((x) => x.trim())];
    const source = links.find((l) => safeUrl(l) && (videoOf([l]) || /tiktok\.com/i.test(l))) ?? '';
    busy(true);
    msg.textContent = 'Das Video wird hochgeladen …';
    const bucket = supabase.storage.from('import-videos');
    try {
      const { error } = await bucket.upload(path, file, { contentType: file.type || 'video/mp4' });
      if (error) throw new Error(/bucket/i.test(error.message) ? 'Der Speicherordner für Videos fehlt noch (videos.sql ausführen, siehe README).' : error.message);
      msg.textContent = 'Das Video wird ausgewertet. Das kann bis zu zwei Minuten dauern …';
      await fill(await invoke({ video: { path, source } }));
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    } finally {
      bucket.remove([path]).catch(() => {}); // falls die Edge Function es nicht mehr löschen konnte
      busy(false);
    }
  };

  // Eingefügter Text, z. B. ein Kommentar mit dem Rezept.
  textBtn.onclick = async () => {
    const { value, form: sheet } = await openSheet(`<h2>Text einfügen</h2>
      <label>Text mit dem Rezept <textarea name="text" rows="10" placeholder="z. B. ein Kommentar, eine Nachricht oder Notizen"></textarea></label>
      <div class="row"><button class="btn primary" value="ok">Auswerten</button>
        <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
    const text = sheet.text.value.trim();
    if (value !== 'ok' || !text) return;
    busy(true);
    msg.textContent = 'Der Text wird ausgewertet …';
    try {
      await fill(await invoke({ text }));
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    } finally {
      busy(false);
    }
  };
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v', 'video/3gpp': '3gp' };

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Start ----------

window.addEventListener('hashchange', render);

if (isConfigured) {
  supabase.auth.onAuthStateChange((event, newSession) => {
    if (event === 'INITIAL_SESSION') return; // wird unten per getSession behandelt
    const userChanged = newSession?.user?.id !== session?.user?.id;
    session = newSession;
    if (event === 'PASSWORD_RECOVERY') recoveringPassword = true;
    if (userChanged) { recipes = null; myName = undefined; categories = null; places = null; cookbookCache.clear(); }
    // Nur bei echten Wechseln neu zeichnen, nicht beim stillen Token-Refresh.
    if (userChanged || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_OUT') setTimeout(render);
  });
  const { data } = await supabase.auth.getSession();
  session = data.session;
}
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
