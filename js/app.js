import { supabase, isConfigured, IMAGE_BUCKET } from './supabase.js';
import {
  parseIngredientText, parseIngredientLine, formatQuantity, ingredientToLine,
} from './ingredients.js';
import { suggestRecipes, STAPLES } from './pantry.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

let session = null;
let recipes = null; // Cache aller eigenen Rezepte
let listQuery = '';
let activeTag = null;
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
  // Geteilte Einzelrezepte kann man auch ohne Konto ansehen.
  if (first === 'teilen' && id) {
    renderNav();
    return guarded(() => renderSharedLink(id));
  }
  if (!session) return renderLogin(first === 'einladung' ? 'Melde dich an oder registriere dich, um das geteilte Kochbuch zu sehen.' : '');
  renderNav();
  return guarded(async () => {
    if (!first) await renderList();
    else if (first === 'geteilt') await renderSharing();
    else if (first === 'einladung' && id) await acceptInvite(id);
    else if (first === 'kochbuch' && id && action) await renderCookbookRecipe(id, action);
    else if (first === 'kochbuch' && id) await renderCookbook(id);
    else if (first === 'kochen') await renderPantry();
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
    <a class="btn primary small" href="#/neu">+ Neues Rezept</a>
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

function tabs(active) {
  return `<nav class="tabs" aria-label="Ansicht">
    <a href="#/" class="${active === 'list' ? 'active' : ''}">Rezepte</a>
    <a href="#/kochen" class="${active === 'pantry' ? 'active' : ''}">Was kochen?</a>
    <a href="#/geteilt" class="${active === 'shared' ? 'active' : ''}">Geteilt</a>
  </nav>`;
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

async function renderPantry() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const all = await loadRecipes();
  const state = loadPantry();
  const known = [...new Set(all.flatMap((r) => r.ingredients.map((i) => i.name.split(',')[0].trim())).filter(Boolean))]
    .sort(collator.compare);

  app.innerHTML = `
    ${tabs('pantry')}
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
    const card = (h) => `<a class="suggestion" href="#/r/${h.recipe.id}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : '<div class="placeholder" aria-hidden="true">🍲</div>'}
      <div><h3>${esc(h.recipe.title)}</h3>
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
  draw();
}

async function renderList() {
  app.innerHTML = '<p class="loading">Lade Rezepte …</p>';
  const all = await loadRecipes();
  if (!all.length) {
    app.innerHTML = `${tabs('list')}<div class="empty">
      <h1>Noch keine Rezepte</h1>
      <p>Lege dein erstes Rezept an.</p>
      <a class="btn primary" href="#/neu">+ Neues Rezept</a></div>`;
    return;
  }
  const tags = [...new Set(all.flatMap((r) => r.tags))].sort(collator.compare);
  if (activeTag && !tags.includes(activeTag)) activeTag = null;
  app.innerHTML = `
    ${tabs('list')}
    <div class="search">
      <input type="search" id="q" placeholder="Titel, Beschreibung oder Tag suchen" value="${esc(listQuery)}" aria-label="Rezepte durchsuchen">
    </div>
    ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip${t === activeTag ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div id="results" class="grid"></div>`;

  const results = $('#results');
  const draw = () => {
    const q = listQuery.trim().toLowerCase();
    const shown = all.filter((r) => (!activeTag || r.tags.includes(activeTag))
      && (!q || [r.title, r.description, ...r.tags].some((s) => s.toLowerCase().includes(q))));
    results.innerHTML = shown.length ? shown.map((r) => recipeCard(r)).join('')
      : '<p class="hint">Keine passenden Rezepte gefunden.</p>';
  };
  $('#q').oninput = (e) => { listQuery = e.target.value; draw(); };
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
  const meta = [r.total_minutes != null ? `⏱ ${formatMinutes(r.total_minutes)}` : '', ...r.tags.slice(0, 3)]
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
  app.innerHTML = `${tabs('shared')}<p class="loading">Lade …</p>`;
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
    ${tabs('shared')}
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
