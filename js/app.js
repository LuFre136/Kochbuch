import { supabase, isConfigured, IMAGE_BUCKET } from './supabase.js';
import {
  parseIngredientText, parseIngredientLine, formatQuantity, ingredientToLine,
} from './ingredients.js';
import { suggestRecipes, STAPLES } from './pantry.js';
import {
  additionsFromPlan, findConflict, mergeInto, removeRecipe, recipesOnList, plannedIds, formatItemQuantity,
} from './shopping.js';
import { PRODUCE, MONTHS, seasonOf, inSeason, seasonalRecipes } from './season.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const tabbar = document.getElementById('tabbar');

let session = null;
let recipes = null; // Cache aller eigenen Rezepte
let listQuery = '';
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
  const [first, id, action] = route();
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
    if (!first) await renderList();
    else if (first === 'geteilt') await renderSharing();
    else if (first === 'plan') await renderPlan();
    else if (first === 'einkauf') await renderShopping(id);
    else if (first === 'liste' && id) await acceptListInvite(id);
    else if (first === 'einladung' && id) await acceptInvite(id);
    else if (first === 'kochbuch' && id && action) await renderCookbookRecipe(id, action);
    else if (first === 'kochbuch' && id) await renderCookbook(id);
    else if (first === 'kochen') await renderPantry();
    else if (first === 'saison') await renderSeason();
    else if (first === 'neu') await renderEditor(null);
    else if (first === 'r' && id && action === 'bearbeiten') await renderEditor(id);
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
        const { data, error } = await supabase.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname },
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
  const active = { '': 'list', r: 'list', neu: 'list', kochen: 'pantry', saison: 'pantry', plan: 'plan', einkauf: 'shop', geteilt: 'shared', kochbuch: 'shared', liste: 'shop' }[first || ''];
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
  const [own, people] = await Promise.all([loadRecipes(), loadPeople().catch(() => ({ owners: [] }))]);
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

async function renderPantry() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const { all, sharedBooks } = await searchableRecipes();
  const state = loadPantry();
  const known = [...new Set(all.flatMap((r) => r.ingredients.map((i) => i.name.split(',')[0].trim())).filter(Boolean))]
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
    <div id="suggestions"></div>`;

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
      out.innerHTML = '<p class="hint">Gib ein, was du im Kühlschrank und Vorrat hast. Dann zeige ich dir, welche Rezepte du damit kochen kannst.</p>';
      return;
    }
    const hits = suggestRecipes(all, state.items, { useStaples: state.useStaples });
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
    const card = (h) => `<a class="suggestion" href="${recipeHref(h.recipe)}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
      <div><h3>${esc(h.recipe.title)}</h3>${fromLine(h.recipe)}
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
  const tags = [...new Set(all.flatMap((r) => r.tags))].sort(collator.compare);
  const st = seasonState;
  for (const t of st.tags) if (!tags.includes(t)) st.tags.delete(t);

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
      ${tags.length ? `<div class="chips static" id="season-tags">${tags.map((t) => `<button type="button" class="chip${st.tags.has(t) ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
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
    const hits = seasonalRecipes(all, produce, [...st.tags]);
    $('#season-results').innerHTML = hits.length ? `<div class="suggestions">${hits.map((h) => `<a class="suggestion" href="${recipeHref(h.recipe)}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
      <div><h3>${esc(h.recipe.title)}</h3>${fromLine(h.recipe)}<p class="ok">Saison: ${h.matches.map((p) => esc(p.name)).join(', ')}</p></div></a>`).join('')}</div>`
      : `<p class="hint">${all.length ? 'Keines deiner Rezepte passt dazu.' : 'Du hast noch keine Rezepte.'}</p>`;
  };

  const step = (d) => { st.month = ((st.month - 1 + d + 12) % 12) + 1; draw(); };
  $('#prev-month').onclick = () => step(-1);
  $('#next-month').onclick = () => step(1);
  $('#storage').onchange = (e) => { st.storage = e.target.checked; draw(); };
  bindSharedToggle(renderSeason);
  app.querySelectorAll('#season-tags [data-tag]').forEach((chip) => {
    chip.onclick = () => {
      const t = chip.dataset.tag;
      if (st.tags.has(t)) st.tags.delete(t); else st.tags.add(t);
      chip.classList.toggle('active', st.tags.has(t));
      draw();
    };
  });
  draw();
}

async function renderList() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const all = await loadRecipes();
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

  const results = $('#results');
  const draw = () => {
    const q = listQuery.trim().toLowerCase();
    const shown = all.filter((r) => (!activeTag || r.tags.includes(activeTag))
      && (!q || [r.title, r.description, ...r.tags].some((s) => s.toLowerCase().includes(q))));
    if (listSort === 'rating') shown.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || collator.compare(a.title, b.title));
    results.innerHTML = shown.length ? shown.map((r) => recipeCard(r)).join('')
      : '<p class="hint">Keine passenden Rezepte gefunden.</p>';
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

function recipeCard(r, href = `#/r/${r.id}`) {
  const img = r.images[0]
    ? `<img src="${esc(imageUrl(r.images[0]))}" alt="" loading="lazy">`
    : '<div class="placeholder" aria-hidden="true">🍲</div>';
  const meta = [r.rating ? '★'.repeat(r.rating) : '', r.total_minutes != null ? `⏱ ${formatMinutes(r.total_minutes)}` : '', ...r.tags.slice(0, 3)]
    .filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  return `<a class="card" href="${href}">
    ${img}
    <div class="card-body"><h2>${esc(r.title)}</h2><div class="meta">${meta}</div></div>
  </a>`;
}

async function renderDetail(id) {
  const r = (await loadRecipes()).find((x) => x.id === id);
  if (!r) {
    app.innerHTML = '<div class="notice"><p>Dieses Rezept gibt es nicht (mehr).</p><a class="btn" href="#/">Zur Übersicht</a></div>';
    return;
  }
  showRecipe(r, { own: true, back: '#/', backLabel: 'Alle Rezepte' });
}

// Zeigt ein Rezept an. Eigene Rezepte kann man bearbeiten, teilen und löschen,
// fremde (aus einem Teilen-Link oder einem freigegebenen Kochbuch) ins eigene Kochbuch übernehmen.
function showRecipe(r, { own, back, backLabel, from = '' }) {
  window.scrollTo(0, 0);
  let servings = r.servings;
  const sources = r.sources.map((u) => [u, safeUrl(u)]).filter(([, href]) => href);

  app.innerHTML = `
    <article class="recipe">
      ${back ? `<a class="back" href="${back}">← ${esc(backLabel)}</a>` : ''}
      ${from ? `<p class="hint from">${esc(from)}</p>` : ''}
      ${r.images.length ? `<div class="gallery">${r.images.map((p) => `<img src="${esc(imageUrl(p))}" alt="">`).join('')}</div>` : ''}
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
        <ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>` : ''}

      ${r.notes ? `<section><h2>Notizen</h2><p class="notes">${esc(r.notes)}</p></section>` : ''}

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

  const ingList = $('#ing');
  const drawIngredients = () => {
    if (!ingList) return;
    $('#srv').textContent = `${servings} ${servings === 1 ? 'Person' : 'Personen'}`;
    const factor = servings / r.servings;
    ingList.innerHTML = r.ingredients.map((i) => `<li><span class="qty">${esc(formatQuantity(i, factor))}</span><span>${esc(i.name)}</span></li>`).join('');
  };
  app.querySelectorAll('.stepper button').forEach((b) => {
    b.onclick = () => {
      servings = Math.max(1, Math.min(100, servings + Number(b.dataset.d)));
      drawIngredients();
    };
  });
  drawIngredients();

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
    try {
      if (!r.share_token) {
        const token = crypto.randomUUID();
        const { error } = await supabase.from('recipes').update({ share_token: token }).eq('id', r.id);
        if (error) throw error;
        r.share_token = token;
      }
      await shareLink(appUrl(`teilen/${r.share_token}`), r.title);
      showRecipe(r, { own, back, backLabel });
    } catch (err) {
      toast(`Teilen fehlgeschlagen: ${err.message}`);
    }
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
    if (!confirm(`„${r.title}“ wirklich löschen?`)) return;
    const { error } = await supabase.from('recipes').delete().eq('id', r.id);
    if (error) { toast(error.message); return; }
    if (r.images.length) await supabase.storage.from(IMAGE_BUCKET).remove(r.images);
    recipes = recipes.filter((x) => x.id !== r.id);
    toast('Rezept gelöscht');
    location.hash = '#/';
  };
}

async function renderEditor(id) {
  const existing = id ? (await loadRecipes()).find((x) => x.id === id) : null;
  if (id && !existing) { location.hash = '#/'; return; }
  window.scrollTo(0, 0);
  const r = existing || {
    title: '', description: '', tags: [], servings: 2, total_minutes: null, cook_minutes: null,
    ingredients: [], steps: [], sources: [], notes: '', images: [],
  };
  let keptImages = [...r.images];
  let tags = [...r.tags];
  let steps = r.steps.length ? [...r.steps] : [''];
  const knownTags = [...new Set((recipes || []).flatMap((x) => x.tags))].sort(collator.compare);
  let newFiles = [];

  app.innerHTML = `
    <form class="editor" id="editor">
      <a class="back" href="${existing ? `#/r/${existing.id}` : '#/'}">← Abbrechen</a>
      <h1>${existing ? 'Rezept bearbeiten' : 'Neues Rezept'}</h1>

      ${existing ? '' : `<div class="import card-panel">
        <label>Aus Link importieren
          <div class="import-row">
            <input type="url" id="import-url" inputmode="url" placeholder="https://www.chefkoch.de/rezepte/…" autocomplete="off">
            <button type="button" class="btn primary" id="import-btn">Importieren</button>
          </div>
          <small>Liest Titel, Zutaten, Zubereitung, Zeiten und Bild aus. Danach kannst du alles anpassen.</small>
        </label>
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

      <label>Zutaten <textarea name="ingredients" rows="8" placeholder="200 g Mehl&#10;2 Eier&#10;1 Prise Salz">${esc(r.ingredients.map(ingredientToLine).join('\n'))}</textarea>
        <small>Eine Zutat pro Zeile, Menge zuerst. Die Menge bezieht sich auf die Personenzahl oben.</small></label>
      <ul class="parse-preview" id="preview"></ul>

      <fieldset>
        <legend>Zubereitung</legend>
        <ol class="step-edit" id="steps"></ol>
        <button type="button" class="btn small" id="step-add">+ Schritt hinzufügen</button>
      </fieldset>
      <label>Notizen <textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
      <label>Quellen <textarea name="sources" rows="2" placeholder="https://… (ein Link pro Zeile)">${esc(r.sources.join('\n'))}</textarea></label>

      <fieldset>
        <legend>Bilder</legend>
        <div class="thumbs" id="thumbs"></div>
        <label class="btn file">Bilder hinzufügen<input type="file" accept="image/*" multiple id="files" hidden></label>
      </fieldset>

      <div class="actions">
        <button class="btn primary" id="save">Speichern</button>
      </div>
    </form>`;

  const form = $('#editor');
  const preview = $('#preview');
  const drawPreview = () => {
    const items = parseIngredientText(form.ingredients.value);
    preview.innerHTML = items.map((i) => `<li><span class="qty">${esc(formatQuantity(i)) || '–'}</span><span>${esc(i.name)}</span></li>`).join('');
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
    stepList.innerHTML = steps.map((text, i) => `<li>
      <div class="step-head"><span>Schritt ${i + 1}</span>
        ${steps.length > 1 ? `<button type="button" class="link danger-link" data-remove="${i}">Entfernen</button>` : ''}</div>
      <textarea data-step="${i}" rows="2" aria-label="Schritt ${i + 1}">${esc(text)}</textarea>
    </li>`).join('');
    stepList.querySelectorAll('textarea').forEach((ta) => {
      grow(ta);
      ta.oninput = () => { steps[Number(ta.dataset.step)] = ta.value; grow(ta); };
    });
    stepList.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = () => { steps.splice(Number(b.dataset.remove), 1); drawSteps(); };
    });
  };
  const setSteps = (list) => { steps = list.length ? [...list] : ['']; drawSteps(); };
  $('#step-add').onclick = () => {
    steps.push('');
    drawSteps();
    stepList.querySelector('li:last-child textarea').focus();
  };
  drawSteps();

  if (!existing) setupImport(form, { setTags, setSteps, addImage: (file) => { newFiles.push({ file, preview: URL.createObjectURL(file) }); drawThumbs(); }, drawPreview });

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
      const row = {
        id: recipeId,
        title: form.title.value.trim(),
        description: form.description.value.trim(),
        tags,
        servings: Math.max(1, num(form.servings.value) || 1),
        total_minutes: num(form.total_minutes.value),
        cook_minutes: num(form.cook_minutes.value),
        ingredients: lines(form.ingredients.value).map(parseIngredientLine),
        steps: steps.map((st) => st.trim()).filter(Boolean),
        sources: lines(form.sources.value),
        notes: form.notes.value.trim(),
        images: [...keptImages, ...uploaded],
      };
      const { data, error } = await supabase.from('recipes').upsert(row).select().single();
      if (error) throw error;

      const removed = existing ? existing.images.filter((p) => !keptImages.includes(p)) : [];
      if (removed.length) await supabase.storage.from(IMAGE_BUCKET).remove(removed);
      newFiles.forEach((f) => URL.revokeObjectURL(f.preview));

      if (recipes) {
        recipes = [...recipes.filter((x) => x.id !== data.id), data].sort((a, b) => collator.compare(a.title, b.title));
      }
      toast('Gespeichert');
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

  $('#plan-btn').onclick = () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.innerHTML = `<form method="dialog" class="sheet-form">
      <h2>„${esc(r.title)}“ einplanen</h2>
      <label>Datum <input type="date" name="date" required min="${today()}" value="${today()}"></label>
      <label>Personen <input type="number" name="servings" min="1" max="100" required value="${currentServings()}"></label>
      <div class="row">
        <button class="btn primary" value="ok">Einplanen</button>
        <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button>
      </div>
    </form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', async () => {
      const form = dialog.querySelector('form');
      if (dialog.returnValue === 'ok') {
        const { error } = await supabase.from('meal_plan').insert({
          recipe_id: r.id, planned_for: form.date.value, servings: Number(form.servings.value),
        });
        if (error) toast(error.message);
        else { toast(`Eingeplant für ${formatDay(form.date.value)}`); drawPlanned(); }
      }
      dialog.remove();
    });
    dialog.showModal();
  };
}

async function renderPlan() {
  app.innerHTML = '<p class="loading">Lade Plan …</p>';
  const [plan, own, onLists] = await Promise.all([loadPlan(), loadRecipes(), loadPlannedOnLists()]);
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
    return `<div class="suggestion plan-entry" data-id="${p.id}">
          ${r.images[0] ? `<img src="${esc(imageUrl(r.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
          <div><h3><a href="#/r/${r.id}">${esc(r.title)}</a></h3>
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
      const { error } = await supabase.from('meal_plan').delete().eq('id', b.dataset.remove);
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
  const lists = await loadLists();
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
      <select id="item-sort" aria-label="Sortierung">
        ${[['added', 'Hinzugefügt'], ['name', 'A–Z'], ['recipe', 'Nach Rezept']].map(([v, l]) => `<option value="${v}"${shoppingSort() === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <form class="import-row add-item" id="add-item">
      <input name="item" placeholder="z. B. 1 l Milch" autocomplete="off" enterkeyhint="done" aria-label="Eintrag hinzufügen">
      <button class="btn">Hinzufügen</button>
    </form>
    <div id="list-recipes"></div>
    <ul class="shop-items" id="open-items"></ul>
    <div id="done-items"></div>

    <section class="card-panel share-section list-settings">
      <h2>Liste verwalten</h2>
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
        ${members.length ? `<ul class="people">${members.map((p) => `<li><span>${esc(p.email)}</span>
          <button class="link danger-link" data-member="${p.user_id}">Entfernen</button></li>`).join('')}</ul>` : ''}`
    : `<p class="hint">Geteilt von ${esc(owner?.email ?? 'jemand anderem')}${members.length > 1 ? ` mit ${members.filter((p) => p.user_id !== me).map((p) => esc(p.email)).join(', ')}` : ''}.</p>
        <div class="row"><button class="btn danger" id="leave-list">Liste verlassen</button></div>`}
    </section>`;

  const draw = () => {
    const sort = shoppingSort();
    const sorted = sortItems(items, sort);
    const open = sorted.filter((i) => !i.checked);
    const done = sorted.filter((i) => i.checked);
    const row = (i) => `<li class="${i.checked ? 'done' : ''}">
      <label class="shop-check"><input type="checkbox" data-check="${i.id}" ${i.checked ? 'checked' : ''}>
        <span><span class="qty">${esc(formatItemQuantity(i))}</span> ${esc(i.name)}
        ${i.sources?.length ? `<small>${esc(sourceTitles(i.sources))}${i.manual ? ' + von Hand' : ''}</small>` : ''}</span></label>
      <button class="icon-btn" data-del="${i.id}" aria-label="${esc(i.name)} löschen">×</button></li>`;
    // Nach Rezept: Zwischenüberschriften, sobald ein neues Rezept beginnt.
    const rows = (list) => list.map((item, i) => {
      const group = groupOf(item);
      const head = sort === 'recipe' && (i === 0 || groupOf(list[i - 1]) !== group) ? `<li class="group-head">${esc(group)}</li>` : '';
      return head + row(item);
    }).join('');
    $('#open-items').innerHTML = open.length ? rows(open)
      : `<li class="hint empty-list">${done.length ? 'Alles erledigt.' : 'Die Liste ist leer. Füge oben etwas hinzu oder setze im Plan Rezepte auf die Liste.'}</li>`;
    $('#done-items').innerHTML = done.length ? `<div class="section-head done-head"><h2>Erledigt (${done.length})</h2>
      <button class="link danger-link" id="clear-done">Erledigte löschen</button></div>
      <ul class="shop-items">${rows(done)}</ul>` : '';
    const recs = recipesOnList(items);
    $('#list-recipes').innerHTML = recs.length ? `<p class="hint">Aus Rezepten:</p><div class="chips static">${recs.map((r) => `<span class="chip tag-chip">${esc(r.title)}
      <button type="button" data-recipe="${esc(r.recipe_id)}" aria-label="${esc(r.title)} von der Liste nehmen">×</button></span>`).join('')}</div>` : '';

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
    draw();
    input.focus();
  };

  const byId = (sel) => app.querySelector(sel);
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
      if (!confirm('Liste verlassen? Du brauchst dann einen neuen Einladungslink.')) return;
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

function shoppingSort() {
  try { return localStorage.getItem('kochbuch.listSort') || 'added'; } catch { return 'added'; }
}

const groupOf = (item) => item.sources?.[0]?.title ?? 'Von Hand';

function sortItems(items, sort) {
  const list = [...items];
  if (sort === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
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
    };
    const { data, error } = await supabase.from('recipes').insert(row).select().single();
    if (error) throw error;
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
    
    <section class="card-panel share-section">
      <h2>Mit mir geteilte Kochbücher</h2>
      ${owners.length ? `<ul class="people">${owners.map((o) => `<li>
          <a href="#/kochbuch/${o.owner_id}">Kochbuch von ${esc(o.owner_email)}</a>
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
          <span>${esc(p.reader_email)}</span>
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
  const book = { email: owner.owner_email, recipes: data.sort((a, b) => collator.compare(a.title, b.title)) };
  cookbookCache.set(ownerId, book);
  return book;
}

async function renderCookbook(ownerId) {
  app.innerHTML = '<p class="loading">Lade Kochbuch …</p>';
  cookbookCache.delete(ownerId);
  const book = await loadCookbook(ownerId);
  if (!book) {
    app.innerHTML = '<div class="notice"><p>Du hast keinen Zugriff (mehr) auf dieses Kochbuch.</p><a class="btn" href="#/geteilt">Zurück</a></div>';
    return;
  }
  app.innerHTML = `
    <a class="back" href="#/geteilt">← Geteilt</a>
    <h1>Kochbuch von ${esc(book.email)}</h1>
    <div class="search"><input type="search" id="q" placeholder="Rezepte durchsuchen" aria-label="Rezepte durchsuchen"></div>
    <div id="results" class="grid"></div>`;
  const draw = (q = '') => {
    const shown = book.recipes.filter((r) => !q || [r.title, r.description, ...r.tags].some((x) => x.toLowerCase().includes(q)));
    $('#results').innerHTML = shown.length
      ? shown.map((r) => recipeCard(r, `#/kochbuch/${ownerId}/${r.id}`)).join('')
      : '<p class="hint">Keine Rezepte gefunden.</p>';
  };
  $('#q').oninput = (e) => draw(e.target.value.trim().toLowerCase());
  draw();
}

async function renderCookbookRecipe(ownerId, recipeId) {
  const book = await loadCookbook(ownerId);
  const r = book?.recipes.find((x) => x.id === recipeId);
  if (!r) {
    app.innerHTML = '<div class="notice"><p>Dieses Rezept gibt es nicht (mehr).</p><a class="btn" href="#/geteilt">Zurück</a></div>';
    return;
  }
  showRecipe(r, { own: false, back: `#/kochbuch/${ownerId}`, backLabel: `Kochbuch von ${book.email}` });
}

// Import per Link: die Edge Function "import-recipe" lädt die Seite und liest das Rezept aus.
function setupImport(form, { setTags, setSteps, addImage, drawPreview }) {
  const input = $('#import-url');
  const btn = $('#import-btn');
  const msg = $('#import-msg');

  const run = async () => {
    const url = input.value.trim();
    if (!safeUrl(url)) { msg.textContent = 'Bitte einen vollständigen Link (https://…) einfügen.'; return; }
    btn.disabled = true;
    btn.textContent = 'Lade …';
    msg.textContent = '';
    try {
      const { data, error } = await supabase.functions.invoke('import-recipe', { body: { url } });
      if (error) {
        let detail = error.message;
        const status = error.context?.status;
        try { detail = (await error.context.json()).error || detail; } catch { /* keine JSON-Antwort */ }
        if (status === 404) detail = 'Die Import-Funktion ist in Supabase noch nicht eingerichtet (siehe README).';
        throw new Error(detail);
      }
      if (data.title) form.title.value = data.title;
      if (data.description) form.description.value = data.description;
      if (data.tags?.length) setTags(data.tags);
      if (data.servings) form.servings.value = data.servings;
      if (data.total_minutes != null) form.total_minutes.value = data.total_minutes;
      if (data.cook_minutes != null) form.cook_minutes.value = data.cook_minutes;
      if (data.ingredients?.length) form.ingredients.value = data.ingredients.join('\n');
      if (data.steps?.length) setSteps(data.steps);
      if (data.notes) form.notes.value = [form.notes.value.trim(), data.notes].filter(Boolean).join('\n\n');
      const sources = form.sources.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!sources.includes(data.source)) form.sources.value = [...sources, data.source].join('\n');
      if (data.image) {
        const blob = await (await fetch(data.image)).blob();
        addImage(new File([blob], 'import.jpg', { type: blob.type }));
      }
      drawPreview();
      msg.textContent = data.ingredients?.length
        ? 'Importiert. Prüfe die Angaben und tippe auf Speichern.'
        : 'Auf dieser Seite wurden keine Rezeptdaten gefunden. Titel und Bild sind übernommen, den Rest bitte selbst ergänzen.';
      input.value = '';
    } catch (err) {
      msg.textContent = `Import fehlgeschlagen: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Importieren';
    }
  };
  btn.onclick = run;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
}

// ---------- Start ----------

window.addEventListener('hashchange', render);

if (isConfigured) {
  supabase.auth.onAuthStateChange((event, newSession) => {
    if (event === 'INITIAL_SESSION') return; // wird unten per getSession behandelt
    const userChanged = newSession?.user?.id !== session?.user?.id;
    session = newSession;
    if (event === 'PASSWORD_RECOVERY') recoveringPassword = true;
    if (userChanged) { recipes = null; cookbookCache.clear(); }
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
