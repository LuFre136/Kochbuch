import { supabase, isConfigured, IMAGE_BUCKET } from './supabase.js';
import {
  parseIngredientText, parseIngredientLine, formatQuantity, ingredientToLine, ingredientParts, splitNote,
} from './ingredients.js';
import { suggestRecipes, STAPLES } from './pantry.js';
import {
  additionsFromPlan, findConflict, mergeInto, removeRecipe, removePlanEntry, recipesOnList, plannedIds, formatItemQuantity,
  frequentSuggestions,
} from './shopping.js';
import { PRODUCE, MONTHS, seasonOf, inSeason, seasonalRecipes } from './season.js';
import { CATEGORIES, guessCategory, categoryKey } from './categories.js';
import { DEFAULT_PLACES, guessPlaces, categoryOrder, walkKey } from './places.js';
import { linkify } from './links.js';
import {
  videoOf, videosOf, videoKey, embedUrl, seekTo, askPlayerState, pausePlayer, playMuted, playerState, isPlayerMessage, stepText, stepTime, stepVideo,
  dropMissingTimes, makeStep, formatTime,
} from './video.js';
import {
  pairOf, alternativeIds, alternativeGroup, suggestAlternatives, relatedAlternatives,
  filterByTags, tagMatches,
} from './alternatives.js';
import {
  SORTS, sortRecipes, formatCooked, cookedFromPlan, TIME_LIMITS, filterByTime,
} from './sorting.js';
import { HELP, helpFor, helpTopic } from './help.js';
import { NEWS, newsSince, latestVersion } from './news.js';
import {
  ingredientsFromStep, remainingIngredients, ingredientKey, mentionsIngredient,
  scaleIngredient, combinedTitle, stepsForCombine, combinedImages,
} from './combine.js';
import {
  stepAmounts, stepPieces, formatCountdown, checksFor, toggleCheck, clearChecks,
  startTimer, timerLeft, timerDone, pauseTimer, resumeTimer, removeTimer,
} from './cooking.js';

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
let frequentTable = true; // false, solange haeufig.sql nicht ausgeführt wurde
let walkColumn = true; // false, solange shopping_places keine Spalte category_order hat (ladenweg.sql)
let namesSaved = true; // false, solange ingredient_categories keine Spalte name hat (zutaten.sql)
let takenName = ''; // Name aus der Registrierung, den inzwischen jemand anderes hat
let myName; // Benutzername: undefined = noch nicht geladen, null = fehlt noch, false = benutzername.sql nicht eingerichtet
let links = null; // Alternativ-Verknüpfungen [{ recipe_a, recipe_b }]; null = noch nicht geladen
let linksTable = true; // false, solange alternativen.sql nicht ausgeführt wurde
let cookedColumn = true; // false, solange gekocht.sql nicht ausgeführt wurde
let secretColumn = true; // false, solange familiengeheimnis.sql nicht ausgeführt wurde
let pendingNew = null; // Vorbelegung für ein neues Rezept, z. B. aus dem Kombinieren
let activeTag = null;
let listSort = 'name';
let timeLimit = null; // Filter nach Zeit: null, 15, 30, 45, 60 oder 'none' (ohne Zeitangabe)
let recoveringPassword = false;
let mailNotice = ''; // Hinweis, wenn sich ein Link aus einer Mail in diesem Browser nicht einlösen ließ

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

function toast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = error ? 'toast error' : 'toast';
  el.textContent = message;
  if (error) el.setAttribute('role', 'alert');
  document.body.append(el);
  setTimeout(() => el.remove(), error ? 7000 : 3500);
}

// Meldung, wenn eine Änderung nicht gespeichert wurde. Bleibt länger stehen und ist rot.
function notSaved(error) {
  const reason = isNetworkError(error) ? 'Keine Verbindung zum Server, bitte nochmal versuchen.'
    : error?.code === '42501' ? 'Keine Berechtigung, vielleicht wurdest du aus der Liste entfernt.'
    : (error?.message ?? '');
  toast(`Nicht gespeichert. ${reason}`.trim(), { error: true });
}

// ---------- Offline ----------
// Ohne Netz liefert der Service Worker die zuletzt geladenen Daten und meldet, von wann sie
// sind. Dann steht oben ein Hinweis, und was das Internet braucht, ist gesperrt. Haken auf
// der Einkaufsliste werden gemerkt und nachgereicht.

let offlineAt = null; // Zeitpunkt der angezeigten Daten, solange die App offline ist

const isNetworkError = (err) => !navigator.onLine || /fetch|network|load failed|offline/i.test(err?.message ?? '');

function formatSaved(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toLocaleDateString('sv-SE') === today()) return `heute ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })} ${time}`;
}

function setOffline(at) {
  if (at && (!offlineAt || at < offlineAt)) offlineAt = at;
  document.body.classList.add('offline');
  let bar = document.getElementById('offline-bar');
  if (!bar) {
    bar = document.createElement('p');
    bar.id = 'offline-bar';
    bar.className = 'offline-bar';
    bar.setAttribute('role', 'status');
    document.querySelector('.topbar').after(bar);
  }
  bar.textContent = offlineAt ? `Offline · Stand von ${formatSaved(offlineAt)}` : 'Offline';
}

function setOnline() {
  if (!document.body.classList.contains('offline')) return;
  offlineAt = null;
  document.body.classList.remove('offline');
  document.getElementById('offline-bar')?.remove();
  flushPendingChecks().then(() => { if (session) render(); });
}

// Schlägt nur eine Anfrage fehl (z. B. kurz nach dem Aufwachen des iPhones), meldet der
// Browser kein "online", wenn das Netz wieder geht. Die nächste geglückte Anfrage hebt den
// Offline-Zustand deshalb wieder auf.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'kochbuch-offline') setOffline(e.data.at);
  if (e.data?.type === 'kochbuch-online' && navigator.onLine) setOnline();
});
window.addEventListener('offline', () => setOffline());
window.addEventListener('online', setOnline);
if (!navigator.onLine) setOffline();

// Was ohne Netz nicht geht, ist gesperrt: ein Tipp darauf erklärt es nur.
const NEEDS_NET = '.needs-net, .swipe-btn, [data-del], #add-item button, #list-settings button, #list-recipes button, #list-select';
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('offline') || !e.target.closest(NEEDS_NET)) return;
  e.preventDefault();
  e.stopPropagation();
  toast('Dafür braucht die App Internet.');
}, true);
document.addEventListener('submit', (e) => {
  if (!document.body.classList.contains('offline') || e.target.id !== 'add-item') return;
  e.preventDefault();
  e.stopPropagation();
  toast('Dafür braucht die App Internet.');
}, true);

// Haken auf der Einkaufsliste, die noch nicht gespeichert werden konnten: { [Eintrag]: true/false }
const loadPendingChecks = () => {
  try { return JSON.parse(localStorage.getItem('kochbuch.pendingChecks') || '{}') || {}; } catch { return {}; }
};
function savePendingChecks(p) {
  try { localStorage.setItem('kochbuch.pendingChecks', JSON.stringify(p)); } catch { /* privater Modus */ }
}

async function flushPendingChecks() {
  const pending = loadPendingChecks();
  for (const [id, checked] of Object.entries(pending)) {
    const { error } = await supabase.from('shopping_items').update({ checked }).eq('id', id);
    if (error && isNetworkError(error)) return;
    delete pending[id];
    savePendingChecks(pending);
  }
}

// Titelbilder aller Rezepte einmal vorladen, damit sie auch offline da sind (der Service
// Worker hebt jedes geladene Bild auf). Nicht im Mobilfunk, soweit der Browser das verrät.
let imagesWarmed = false;
function warmImages(list) {
  const conn = navigator.connection;
  if (imagesWarmed || !navigator.onLine || !navigator.serviceWorker?.controller || conn?.saveData || conn?.type === 'cellular') return;
  imagesWarmed = true;
  const urls = list.filter((r) => r.images?.[0]).map((r) => imageUrl(r.images[0]));
  const next = () => {
    const url = urls.shift();
    if (!url || !navigator.onLine) return;
    const img = new Image();
    img.onload = img.onerror = () => setTimeout(next, 50);
    img.src = url;
  };
  (window.requestIdleCallback ?? setTimeout)(next);
}

// ---------- Timer ----------
// Laufende Timer stehen als Leiste unten auf jeder Seite. Gespeichert wird die Endzeit, damit
// ein Timer weiterläuft, wenn die App zu ist; klingeln kann er nur, solange sie offen ist.

const loadTimers = () => {
  try { const t = JSON.parse(localStorage.getItem('kochbuch.timers') || '[]'); return Array.isArray(t) ? t : []; } catch { return []; }
};
let timers = loadTimers();
let timerTick = null;
let audio = null;

function saveTimers() {
  try { localStorage.setItem('kochbuch.timers', JSON.stringify(timers)); } catch { /* privater Modus */ }
}

// Der Ton braucht einen AudioContext, den iOS nur nach einem Tipp freigibt; darum entsteht er
// beim Starten des ersten Timers.
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}

function ring() {
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (!audio) return;
  const t0 = audio.currentTime;
  for (let i = 0; i < 3; i += 1) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.5);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.5 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.5 + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + i * 0.5);
    osc.stop(t0 + i * 0.5 + 0.4);
  }
}

// Auf dem iPhone kann statt des Timers in der App der Timer der Uhr-App laufen, über einen
// Kurzbefehl, den man einmal selbst anlegt. Die Einstellung bleibt auf dem Gerät.
const PHONE_SHORTCUT = 'Kochbuch-Timer';
const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function usePhoneTimer() {
  try { return localStorage.getItem('kochbuch.phoneTimer') === '1'; } catch { return false; }
}
function setUsePhoneTimer(on) {
  try { localStorage.setItem('kochbuch.phoneTimer', on ? '1' : '0'); } catch { /* privater Modus */ }
}
const phoneTimerUrl = (seconds) => `shortcuts://run-shortcut?name=${encodeURIComponent(PHONE_SHORTCUT)}&input=text&text=${Math.round(seconds)}`;

function addTimer(label, seconds) {
  if (usePhoneTimer()) {
    location.href = phoneTimerUrl(seconds);
    toast(`Timer der Uhr-App: ${formatCountdown(seconds * 1000)}`);
    return;
  }
  unlockAudio();
  timers = startTimer(timers, { label, seconds });
  saveTimers();
  drawTimers();
  toast(`Timer läuft: ${formatCountdown(seconds * 1000)}`);
}

function drawTimers() {
  let bar = document.getElementById('timers');
  if (!timers.length) {
    bar?.remove();
    document.body.classList.remove('has-timers');
    clearInterval(timerTick);
    timerTick = null;
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'timers';
    bar.className = 'timers';
    bar.setAttribute('aria-label', 'Timer');
    document.body.append(bar);
    bar.onclick = (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      const { t: id, act } = b.dataset;
      unlockAudio();
      if (act === 'pause') timers = pauseTimer(timers, id);
      if (act === 'play') timers = resumeTimer(timers, id);
      if (act === 'stop') timers = removeTimer(timers, id);
      saveTimers();
      drawTimers();
    };
  }
  document.body.classList.add('has-timers');
  const now = Date.now();
  bar.innerHTML = timers.map((t) => {
    const done = timerDone(t, now);
    const paused = t.end == null;
    return `<div class="timer${done ? ' ringing' : ''}${paused ? ' paused' : ''}" role="${done ? 'alert' : 'status'}">
      ${symbol('clock')}<span class="timer-label">${esc(t.label)}</span>
      <span class="timer-left">${done ? 'Fertig!' : formatCountdown(timerLeft(t, now))}</span>
      ${done ? '' : `<button type="button" class="icon-btn" data-t="${esc(t.id)}" data-act="${paused ? 'play' : 'pause'}" aria-label="${paused ? 'Weiter' : 'Anhalten'}">${paused ? '▶' : '❙❙'}</button>`}
      <button type="button" class="icon-btn" data-t="${esc(t.id)}" data-act="stop" aria-label="${done ? 'Timer schließen' : 'Timer abbrechen'}">${done ? 'OK' : '×'}</button>
    </div>`;
  }).join('');
  timerTick ??= setInterval(tickTimers, 1000);
}

// Jede Sekunde: Anzeige neu, und wer gerade abgelaufen ist, klingelt (einmal, und dann alle
// 10 Sekunden wieder, bis man ihn schließt).
function tickTimers() {
  const now = Date.now();
  let changed = false;
  for (const t of timers) {
    if (!timerDone(t, now)) continue;
    if (!t.rang || now - t.rang >= 10000) { t.rang = now; changed = true; ring(); }
  }
  if (changed) saveTimers();
  drawTimers();
}

// ---------- Haken beim Kochen ----------

const loadChecks = () => {
  try { return JSON.parse(localStorage.getItem('kochbuch.checks') || '{}') || {}; } catch { return {}; }
};
function saveChecks(all) {
  try { localStorage.setItem('kochbuch.checks', JSON.stringify(all)); } catch { /* privater Modus */ }
}

// Mengen in den Schritten lassen sich abschalten; die Einstellung bleibt auf dem Gerät.
function showStepAmounts() {
  try { return localStorage.getItem('kochbuch.stepAmounts') !== '0'; } catch { return true; }
}
function setShowStepAmounts(on) {
  try { localStorage.setItem('kochbuch.stepAmounts', on ? '1' : '0'); } catch { /* privater Modus */ }
}

// Schritttext mit antippbaren Zeitangaben und, wenn gewünscht, den Mengen der Zutaten.
// amountOf(amount) liefert den Text für eine Menge, z. B. "125 g".
function stepTextHtml(text, label, amounts = [], amountOf = null) {
  return stepPieces(text, amountOf ? amounts : []).map((p) => {
    if (p.amount) {
      const q = amountOf(p.amount);
      return q ? ` <span class="step-qty">(${esc(q)})</span>` : '';
    }
    if (p.seconds) return `<button type="button" class="timer-chip" data-timer="${p.seconds}" data-label="${esc(label)}" aria-label="Timer ${esc(p.text)} starten">${symbol('clock')}${esc(p.text)}</button>`;
    return esc(p.text);
  }).join('');
}

// ---------- Kochmodus ----------
// Eine Seite über dem ganzen Bildschirm: erst die Zutaten, dann je Schritt eine Seite in
// großer Schrift, zum Schluss "Fertig". Solange sie offen ist, bleibt das Display an.

let cookMode = null;

async function keepScreenOn() {
  if (!cookMode) return;
  try {
    cookMode.lock = await navigator.wakeLock.request('screen');
    cookMode.lock.addEventListener?.('release', () => { if (cookMode) cookMode.lock = null; });
  } catch {
    cookMode.lock = null;
    const hint = cookMode.panel.querySelector('.cook-wake');
    if (hint) hint.hidden = false;
  }
}

// Gibt das Display frei, wenn man die App verlässt; beim Zurückkommen wird neu gesperrt.
document.addEventListener('visibilitychange', () => {
  if (cookMode && document.visibilityState === 'visible' && !cookMode.lock) keepScreenOn();
});
window.addEventListener('hashchange', () => closeCookMode());
document.addEventListener('keydown', (e) => {
  if (!cookMode) return;
  if (e.key === 'Escape') closeCookMode();
  if (e.key === 'ArrowRight') cookMode.go(1);
  if (e.key === 'ArrowLeft') cookMode.go(-1);
});

function closeCookMode() {
  if (!cookMode) return;
  const { panel, lock, onClose } = cookMode;
  cookMode = null;
  lock?.release?.().catch(() => {});
  panel.classList.remove('open');
  setTimeout(() => panel.remove(), 300);
  document.body.classList.remove('cooking');
  if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
  onClose?.();
}

function openCookMode(r, { servings, own, videos = [], onClose }) {
  closeCookMode();
  const factor = servings / r.servings;
  const stepQty = stepAmounts(r.steps.map(stepText), r.ingredients);
  const amountOf = showStepAmounts() ? ({ ing, share }) => formatQuantity(r.ingredients[ing], factor * share) : null;
  // Seiten: Zutaten (falls vorhanden), jeder Schritt, Fertig.
  const pages = [
    ...(r.ingredients.length ? [{ kind: 'ing' }] : []),
    ...r.steps.map((s, i) => ({ kind: 'step', i, s })),
    { kind: 'done' },
  ];
  const checks = () => checksFor(loadChecks(), r.id);
  // Wer schon Schritte abgehakt hat, landet beim Schritt nach dem letzten Haken.
  const done = checks().steps;
  const resume = done.length ? pages.findIndex((p) => p.kind === 'step' && p.i === Math.max(...done) + 1) : -1;
  let at = Math.max(0, resume);

  const panel = document.createElement('section');
  panel.className = 'cook-mode';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Kochmodus: ${r.title}`);
  panel.innerHTML = `<header class="cook-head">
      <button type="button" class="icon-btn" data-close aria-label="Kochmodus beenden">←</button>
      <div><h2>${esc(r.title)}</h2><p class="cook-at" aria-live="polite"></p></div>
    </header>
    <p class="hint cook-wake" hidden>Dieses Gerät lässt das Display hier nicht dauerhaft an. Tippe ab und zu auf den Bildschirm.</p>
    <div class="cook-page"></div>
    <div class="cook-video" hidden></div>
    <nav class="cook-nav">
      <button type="button" class="btn" data-go="-1">‹ Zurück</button>
      <button type="button" class="btn primary" data-go="1">Weiter ›</button>
    </nav>`;
  document.body.append(panel);
  document.body.classList.add('cooking');
  document.documentElement.classList.add('sheet-open');
  requestAnimationFrame(() => panel.classList.add('open'));
  const page = panel.querySelector('.cook-page');
  const videoBox = panel.querySelector('.cook-video');
  const stepCount = r.steps.length;

  const closeVideo = () => { videoBox.hidden = true; videoBox.innerHTML = ''; };
  const draw = () => {
    const p = pages[at];
    const c = checks();
    panel.querySelector('.cook-at').textContent = p.kind === 'ing' ? `Zutaten · ${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`
      : p.kind === 'step' ? `Schritt ${p.i + 1} von ${stepCount}` : 'Fertig';
    if (p.kind === 'ing') {
      page.innerHTML = `<ul class="ingredients cook-ings">${r.ingredients.map((i, ii) => `<li class="checkable${c.ing.includes(ii) ? ' checked' : ''}" data-ing="${ii}">
        <span class="qty">${esc(formatQuantity(i, factor))}</span><span>${ingredientLabel(i)}</span></li>`).join('')}</ul>`;
    } else if (p.kind === 'step') {
      const v = stepVideo(p.s, videos);
      const t = v ? stepTime(p.s) : null;
      page.innerHTML = `<p class="cook-step checkable${c.steps.includes(p.i) ? ' checked' : ''}" data-step="${p.i}">${stepTextHtml(stepText(p.s), `${r.title} · Schritt ${p.i + 1}`, stepQty[p.i], amountOf)}</p>
        ${t != null ? `<button type="button" class="btn small cook-seek" data-t="${t}" data-video="${esc(v.key)}">${symbol('video')}Video ab ${formatTime(t)}</button>` : ''}
        <p class="hint">Tippe auf den Text, um den Schritt abzuhaken.</p>`;
    } else {
      page.innerHTML = `<div class="cook-done">${symbol('cooked')}<p>Guten Appetit!</p>
        ${own && cookedColumn ? '<button type="button" class="btn primary" data-cooked>Fertig, heute gekocht</button>' : ''}
        <button type="button" class="btn" data-close>Kochmodus beenden</button></div>`;
    }
    panel.querySelector('[data-go="-1"]').disabled = at === 0;
    const next = panel.querySelector('[data-go="1"]');
    next.hidden = at === pages.length - 1;
    page.scrollTop = 0;
  };
  const go = (d) => {
    const n = at + d;
    if (n < 0 || n >= pages.length) return;
    at = n;
    closeVideo();
    draw();
  };

  panel.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { closeCookMode(); return; }
    const nav = e.target.closest('[data-go]');
    if (nav) { go(Number(nav.dataset.go)); return; }
    const chip = e.target.closest('.timer-chip');
    if (chip) { addTimer(chip.dataset.label, Number(chip.dataset.timer)); return; }
    const seek = e.target.closest('.cook-seek');
    if (seek) {
      const v = videos.find((x) => x.key === seek.dataset.video);
      if (!v) return;
      videoBox.innerHTML = `<div class="cook-video-head"><span>Video</span><button type="button" class="icon-btn" data-video-close aria-label="Video schließen">×</button></div>
        <div class="video${v.vertical ? ' vertical' : ''}"><iframe src="${esc(embedUrl(v, location.origin, Number(seek.dataset.t)))}" title="Video zum Schritt"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
      videoBox.hidden = false;
      return;
    }
    if (e.target.closest('[data-video-close]')) { closeVideo(); return; }
    if (e.target.closest('[data-cooked]')) {
      const day = today();
      const { error } = await supabase.from('recipes').update({ last_cooked: day }).eq('id', r.id);
      if (error) { toast(error.message); return; }
      r.last_cooked = day;
      toast('Als heute gekocht gespeichert');
      closeCookMode();
      return;
    }
    if (e.target.closest('button, a, input')) return;
    const li = e.target.closest('.checkable');
    if (!li) return;
    const kind = li.dataset.ing != null ? 'ing' : 'steps';
    saveChecks(toggleCheck(loadChecks(), r.id, kind, Number(li.dataset.ing ?? li.dataset.step)));
    li.classList.toggle('checked');
  });
  enableRecipeSwipe(page, go);

  cookMode = { panel, lock: null, go, onClose };
  draw();
  keepScreenOn();
}

async function loadRecipes(force = false) {
  if (recipes && !force) return recipes;
  const { data, error } = await supabase.from('recipes').select('*').eq('owner_id', session.user.id);
  if (error) throw error;
  // Die Spalte last_cooked gibt es erst nach gekocht.sql; ohne sie entfällt die
  // Sortierung "Zuletzt gekocht".
  if (data.length) cookedColumn = 'last_cooked' in data[0];
  if (data.length) secretColumn = 'family_secret' in data[0];
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
  let { data, error } = await supabase.from('ingredient_categories').select('key, category, places, name');
  namesSaved = !error;
  // Ohne zutaten.sql gibt es die Spalte name noch nicht, ohne orte.sql auch places nicht.
  if (error) ({ data, error } = await supabase.from('ingredient_categories').select('key, category, places'));
  placesSaved = !error;
  if (error) ({ data, error } = await supabase.from('ingredient_categories').select('key, category'));
  categoriesSaved = !error;
  categories = new Map((data ?? []).map((c) => [c.key, { category: c.category, places: c.places ?? null, name: c.name ?? null }]));
  await loadPlaces();
  return categories;
}

// Eigene Einkaufsorte; wer noch keine hat, bekommt die Standard-Orte.
async function loadPlaces() {
  if (places) return places;
  let { data, error } = await supabase.from('shopping_places').select('id, name, position, category_order').order('position');
  walkColumn = !error;
  if (error) ({ data, error } = await supabase.from('shopping_places').select('id, name, position').order('position'));
  placesTable = !error;
  places = data?.length ? data.map(({ id, name, category_order: order }) => ({ id, name, order: order ?? null })) : DEFAULT_PLACES.map((p) => ({ ...p, order: null }));
  if (placesTable && !data.length) {
    const { error: e } = await supabase.from('shopping_places').insert(places.map(({ id, name }, i) => ({ id, name, position: i })));
    if (e) console.warn(e);
  }
  return places;
}

const placeIds = () => (places ?? DEFAULT_PLACES).map((p) => p.id);
const placeName = (id) => (places ?? DEFAULT_PLACES).find((p) => p.id === id)?.name;
// Ladenweg eines Orts: alle Kategorien in seiner Reihenfolge.
const walkOf = (id) => categoryOrder((places ?? []).find((p) => p.id === id)?.order, CATEGORIES);

// Eigene Kategorie einer Zutat, sonst ein Vorschlag anhand des Namens.
function categoryOf(name) {
  return categories?.get(categoryKey(name))?.category ?? guessCategory(name);
}

// Eigene Orte einer Zutat (nur solche, die es noch gibt), sonst ein Vorschlag. Jede Zutat hat
// mindestens einen Ort: Sind alle ihre Orte gelöscht, gilt wieder der Vorschlag.
function placesOf(name) {
  const ids = placeIds();
  const saved = categories?.get(categoryKey(name))?.places?.filter((id) => ids.includes(id));
  return saved?.length ? saved : guessPlaces(name, categoryOf(name), ids);
}

// So steht eine Zutat in der Liste unter „Verwalten“: "Zwiebeln, gehackt" → "Zwiebeln".
const ingredientName = (raw) => splitNote(raw).name.split(',')[0].trim();

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
    if (!known) rows.set(key, { key, category: guessCategory(name), places: placesOf(name), name: ingredientName(name) });
    else if (!known.places && placesSaved) missingPlaces.set(key, { key, category: known.category, places: placesOf(name), name: known.name ?? ingredientName(name) });
  }
  [...rows.values(), ...missingPlaces.values()].forEach((row) => categories.set(row.key, { category: row.category, places: row.places, name: row.name }));
  if (!categoriesSaved) return;
  const strip = (list) => list.map(({ places: p, name: n, ...row }) => ({ ...row, ...(placesSaved ? { places: p } : {}), ...(namesSaved ? { name: n } : {}) }));
  if (rows.size) {
    const { error } = await supabase.from('ingredient_categories')
      .upsert(strip([...rows.values()]), { onConflict: 'owner_id,key', ignoreDuplicates: true });
    if (error) console.warn(error);
  }
  if (missingPlaces.size) {
    const { error } = await supabase.from('ingredient_categories').upsert(strip([...missingPlaces.values()]), { onConflict: 'owner_id,key' });
    if (error) console.warn(error);
  }
}

// Speichert Kategorie und Orte einer Zutat; die Änderung gilt in allen Rezepten und Einkaufslisten.
async function saveIngredientInfo(name, { category = categoryOf(name), places: ids = placesOf(name) }) {
  const key = categoryKey(name);
  if (!key) return;
  await loadCategories();
  const display = categories.get(key)?.name ?? ingredientName(name);
  categories.set(key, { category, places: ids, name: display });
  if (!categoriesSaved) { toast('Kategorien werden erst gespeichert, wenn kategorien.sql ausgeführt ist.'); return; }
  const row = { key, category, ...(placesSaved ? { places: ids } : {}), ...(namesSaved ? { name: display } : {}) };
  const { error } = await supabase.from('ingredient_categories').upsert(row, { onConflict: 'owner_id,key' });
  if (error) toast(error.message);
}

// Fenster für Kategorie und Orte einer Zutat. Liefert 'saved', 'deleted' (nur mit canDelete)
// oder null bei Abbruch. Die Änderung gilt in allen Rezepten und Einkaufslisten.
async function editIngredient(name, { canDelete = false, isNew = false } = {}) {
  await loadCategories();
  const category = categoryOf(name);
  const current = placesOf(name);
  const { value, form } = await openSheet(`<h2>${esc(categories.get(categoryKey(name))?.name ?? ingredientName(name))}</h2>
    <label>Kategorie <select name="category">${categoryOptions(category)}</select></label>
    <fieldset class="place-checks"><legend>Wo bekommst du das?</legend>${placeChecks(current)}</fieldset>
    <div class="row"><button class="btn primary" value="ok">Speichern</button>
      <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button>
      ${canDelete ? '<button class="btn danger" value="delete" formnovalidate>Löschen</button>' : ''}</div>`, requirePlace);
  if (value === 'delete') { await forgetIngredient(name); return 'deleted'; }
  if (value !== 'ok') return null;
  const ids = checkedPlaces(form);
  if (!isNew && form.category.value === category && ids.join() === current.join()) return null;
  await saveIngredientInfo(name, { category: form.category.value, places: ids });
  if (!placesSaved && categoriesSaved) toast('Orte werden erst gespeichert, wenn orte.sql ausgeführt ist.');
  return 'saved';
}

// Jede Zutat hat mindestens einen Ort: Speichern geht erst, wenn einer angehakt ist.
function requirePlace(form) {
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok' || form.querySelector('[name=place]:checked')) return;
    e.preventDefault();
    toast('Wähle mindestens einen Ort.');
  });
}

// Löscht die eigene Zuordnung einer Zutat; danach gilt wieder der Vorschlag.
async function forgetIngredient(name) {
  const key = categoryKey(name);
  categories.delete(key);
  if (!categoriesSaved) return;
  const { error } = await supabase.from('ingredient_categories').delete().eq('key', key);
  if (error) toast(error.message);
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
  // Während das Formular mit dem Code aus der Mail noch speichert, bleibt es stehen.
  if (recoveringPassword) return $('#reset') ? undefined : renderNewPassword();
  const [first, id, action, extra] = route();
  renderTabbar(first);
  leaveShoppingList();
  // Alte Links (Rezept- und Listen-Einladungen) führen auf die gemeinsame Einladungsseite.
  if ((first === 'teilen' || first === 'liste') && id) {
    location.replace(`#/einladung/${encodeURIComponent(id)}`);
    return;
  }
  // Eine Einladung kann man auch ohne Konto ansehen und ablehnen.
  if (first === 'einladung' && id && (!session || myName)) {
    renderNav();
    return guarded(() => renderInvite(id));
  }
  if (!session) {
    if (mailNotice) {
      const hint = mailNotice;
      mailNotice = '';
      return renderLogin(hint);
    }
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
    else if (first === 'verwalten') renderManage();
    else if (first === 'zutaten') await renderIngredients();
    else if (first === 'orte') await renderPlaces();
    else if (first === 'ladenweg' && id) await renderWalk(id);
    else if (first === 'hilfe') renderHelp(id);
    else if (first === 'timer') renderTimerSettings();
    else if (first === 'geteilt') await renderSharing();
    else if (first === 'plan') await renderPlan();
    else if (first === 'einkauf') await renderShopping(id);
    else if (first === 'einladung' && id) await renderInvite(id);
    else if (first === 'erhalten' && id) await renderReceived(id);
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
  const [first, , action] = route();
  const topic = helpFor(first, action);
  // "+ Rezept" steht nur auf der Übersicht; Abmelden liegt unter "Verwalten".
  nav.innerHTML = `
    ${first ? '' : '<a class="btn primary small needs-net" href="#/neu">+ Rezept</a>'}
    ${topic ? '<button class="icon-btn" id="help-btn" aria-label="Hilfe zu dieser Seite" title="Hilfe zu dieser Seite">?</button>' : ''}
    <button class="icon-btn bell" id="bell" hidden>${BELL}<span class="badge" hidden></span></button>`;
  const help = $('#help-btn', nav);
  if (help) help.onclick = () => openHelpSheet(topic);
  $('#bell', nav).onclick = openNotifications;
  drawBell();
  watchNotifications();
}

// ---------- Benachrichtigungen (Glocke) ----------

const BELL = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

let notes = null; // eigene Benachrichtigungen; null = noch nicht geladen, false = benachrichtigungen.sql fehlt
let notesFor = null; // für wen die Live-Aktualisierung läuft
let noteChannel = null;

async function loadNotifications() {
  if (!session) return;
  const { data, error } = await supabase.rpc('my_notifications');
  notes = error ? false : data;
  drawBell();
}

// Die Glocke zeigt, wie viele ungelesen sind.
function drawBell() {
  const bell = document.getElementById('bell');
  if (!bell) return;
  bell.hidden = !notes;
  const unread = notes ? notes.filter((n) => !n.read_at).length : 0;
  const badge = bell.querySelector('.badge');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  const label = unread ? `Benachrichtigungen, ${unread} ungelesen` : 'Benachrichtigungen';
  bell.setAttribute('aria-label', label);
  bell.title = label;
}

// Lädt die Benachrichtigungen einmal pro Anmeldung und hält sie live aktuell.
function watchNotifications() {
  if (!session || notesFor === session.user.id) return;
  notesFor = session.user.id;
  if (noteChannel) supabase.removeChannel(noteChannel);
  noteChannel = supabase.channel(`glocke-${notesFor}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${notesFor}` }, () => loadNotifications())
    .subscribe();
  loadNotifications();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && notes !== false) loadNotifications();
});

// Text und Ziel einer Benachrichtigung.
function noteContent(n) {
  if (n.kind === 'invite_accepted') {
    if (n.target_kind === 'recipe') return { text: `${n.actor_name} hat dein Rezept „${n.title ?? 'Rezept'}“ angenommen.`, href: `#/r/${n.target_id}` };
    if (n.target_kind === 'list') return { text: `${n.actor_name} hat deine Einladung zur Einkaufsliste „${n.title ?? 'Einkaufsliste'}“ angenommen.`, href: `#/einkauf/${n.target_id}` };
    return { text: `${n.actor_name} hat deine Einladung zu deinem Kochbuch angenommen.`, href: '#/geteilt' };
  }
  if (n.kind === 'share_back') {
    return { text: `${n.actor_name} möchte das eigene Kochbuch mit dir teilen.`, href: '#/geteilt', offer: true };
  }
  return { text: `Neues von ${n.actor_name}.`, href: '#/geteilt' };
}

const OFFER_STATE = { angenommen: 'Angenommen', abgelehnt: 'Abgelehnt', zurueckgezogen: 'Zurückgezogen' };

// Antwort auf ein Angebot aus der Glocke (Zurückteilen).
async function answerOffer(inviteId, accept) {
  const { data, error } = await supabase.rpc('respond_direct_invite', { p_id: inviteId, p_accept: accept });
  if (error) { toast(error.message); return; }
  await loadNotifications();
  if (!accept) { toast('Abgelehnt'); return; }
  cookbookCache.clear();
  toast('Angenommen');
  location.hash = `#/kochbuch/${data[0].owner_id}`;
}

function formatWhen(iso) {
  const d = new Date(iso);
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(`${today()}T12:00:00`) - new Date(`${d.toLocaleDateString('sv-SE')}T12:00:00`)) / 86400000);
  if (days <= 0) return `heute, ${time}`;
  if (days === 1) return `gestern, ${time}`;
  return d.toLocaleDateString('de-DE');
}

// Liste der Benachrichtigungen als Seite, die von rechts unter die Kopfzeile gleitet und
// auf dem Handy den ganzen Bildschirm darunter füllt. Die Kopfzeile bleibt stehen; die
// Glocke oder der Pfeil oben links schließen die Liste wieder. Ungelesene sind
// hervorgehoben, solange die Liste offen ist; beim Schließen gelten alle als gelesen.
let notePanel = null;

function openNotifications() {
  if (notePanel) { closeNotifications(); return; }
  const shown = notes || [];
  const unread = shown.filter((n) => !n.read_at).map((n) => n.id);
  const panel = document.createElement('section');
  panel.className = 'note-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Benachrichtigungen');
  panel.innerHTML = `<header class="picker-head">
      <button type="button" class="icon-btn" data-close aria-label="Zurück">←</button>
      <h2>Benachrichtigungen</h2>
    </header>
    ${shown.length ? `<ul class="notes">${shown.map((n) => {
      const { text, href, offer } = noteContent(n);
      if (offer) {
        // Ein Angebot lässt sich hier direkt beantworten, genau einmal.
        return `<li class="note offer${n.read_at ? '' : ' unread'}"><div class="note-btn">
          <span>${esc(text)}</span><small>${esc(formatWhen(n.created_at))}</small>
          ${n.invite_status === 'offen' ? `<div class="row">
            <button type="button" class="btn small primary" data-answer="annehmen" data-invite="${esc(n.invite_id)}">Annehmen</button>
            <button type="button" class="btn small" data-answer="ablehnen" data-invite="${esc(n.invite_id)}">Ablehnen</button></div>`
    : `<small>${esc(OFFER_STATE[n.invite_status] ?? '')}</small>`}</div></li>`;
      }
      return `<li class="note${n.read_at ? '' : ' unread'}"><a class="note-btn" href="${esc(href)}">
        <span>${esc(text)}</span><small>${esc(formatWhen(n.created_at))}</small></a></li>`;
    }).join('')}</ul>` : '<p class="hint">Keine Benachrichtigungen.</p>'}
    <p class="hint">Gelesene verschwinden nach 7 Tagen.</p>`;
  // Die Liste beginnt direkt unter der Kopfzeile, wie hoch die auch gerade ist.
  panel.style.top = `${document.querySelector('.topbar').getBoundingClientRect().bottom}px`;
  document.body.append(panel);
  document.documentElement.classList.add('sheet-open');
  notePanel = { panel, unread, shown };
  requestAnimationFrame(() => panel.classList.add('open'));
  panel.querySelector('[data-close]').onclick = () => closeNotifications();
  panel.querySelectorAll('a.note-btn').forEach((a) => { a.onclick = () => closeNotifications(); });
  panel.querySelectorAll('[data-answer]').forEach((b) => {
    b.onclick = async () => {
      await closeNotifications();
      await answerOffer(b.dataset.invite, b.dataset.answer === 'annehmen');
    };
  });
  $('#bell', nav)?.setAttribute('aria-expanded', 'true');
}

async function closeNotifications() {
  if (!notePanel) return;
  const { panel, unread, shown } = notePanel;
  notePanel = null;
  panel.classList.remove('open');
  panel.addEventListener('transitionend', () => panel.remove(), { once: true });
  setTimeout(() => panel.remove(), 400); // falls keine Animation läuft
  if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
  $('#bell', nav)?.setAttribute('aria-expanded', 'false');
  if (unread.length) {
    const { error } = await supabase.rpc('mark_notifications_read', { p_ids: unread });
    if (!error) {
      const now = new Date().toISOString();
      shown.forEach((n) => { if (!n.read_at) n.read_at = now; });
      drawBell();
    }
  }
}

window.addEventListener('hashchange', () => { closeNotifications(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotifications(); });

// ---------- Benutzername ----------

const USERNAME_RE = /^[A-Za-z0-9ÄÖÜäöüß ._-]{3,30}$/;
const USERNAME_HINT = '3 bis 30 Zeichen: Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich.';

// Lädt den eigenen Benutzernamen. Wurde bei der Registrierung einer angegeben, wird er jetzt gespeichert.
async function loadMyName() {
  const { data, error } = await supabase.from('profiles').select('username').eq('user_id', session.user.id).maybeSingle();
  if (error) return false; // Tabelle fehlt noch: ohne Benutzernamen weitermachen
  if (data) return data.username;
  // Normalerweise legt die Datenbank das Profil schon beim Registrieren an (namen.sql).
  // Fehlt es, war der Name vergeben oder namen.sql ist noch nicht eingerichtet.
  const wanted = normalizeName(session.user.user_metadata?.username);
  if (USERNAME_RE.test(wanted)) {
    const { error: insertError } = await supabase.from('profiles').insert({ username: wanted });
    if (!insertError) return wanted;
    if (insertError.code === '23505') takenName = wanted;
  }
  return null;
}

const normalizeName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');

// Fragt die Datenbank, ob ein Name frei ist. null = unbekannt (namen.sql fehlt oder offline).
async function nameAvailable(name) {
  const { data, error } = await supabase.rpc('username_available', { p_name: name });
  return error ? null : data;
}

// Zeigt beim Tippen, ob der Name frei ist.
function watchUsername(input, out, current = '') {
  let timer;
  let asked = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const name = normalizeName(input.value);
    out.textContent = USERNAME_HINT;
    out.classList.remove('taken', 'free');
    if (!USERNAME_RE.test(name) || name.toLowerCase() === current.toLowerCase()) return;
    timer = setTimeout(async () => {
      asked = name;
      const free = await nameAvailable(name);
      if (asked !== name || normalizeName(input.value) !== name || free === null) return;
      out.textContent = free ? `✓ „${name}“ ist frei` : `„${name}“ ist schon vergeben`;
      out.classList.add(free ? 'free' : 'taken');
    }, 400);
  });
}

async function saveMyName(name) {
  const username = normalizeName(name);
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
      ${takenName ? `<p class="notice-inline">Den Namen „${esc(takenName)}“ hat sich inzwischen jemand anderes genommen. Bitte wähle einen anderen.</p>` : ''}
      <p class="hint">Wenn du Rezepte, dein Kochbuch oder Einkaufslisten teilst, sehen andere nur diesen Namen, nicht deine E-Mail-Adresse.</p>
      <label>Benutzername <input name="username" required minlength="3" maxlength="30" autocomplete="username" autocapitalize="off"></label>
      <small class="hint name-check" id="name-check">${USERNAME_HINT}</small>
      <button class="btn primary">Speichern</button>
      <p class="hint" id="msg" role="status"></p>
    </form>`;
  const form = $('#username-form');
  watchUsername(form.username, $('#name-check'));
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
      <small class="hint name-check" id="name-check" hidden></small>
      <div class="row">
        <button class="btn primary" name="mode" value="login">Anmelden</button>
        <button class="btn" name="mode" value="signup">Registrieren</button>
      </div>
      <button type="button" class="link" id="forgot">Passwort vergessen?</button>
      <p class="hint" id="msg"></p>
    </form>`;
  const form = $('#auth');
  const msg = $('#msg');
  const nameCheck = $('#name-check');
  watchUsername(form.username, nameCheck);
  form.username.addEventListener('input', () => { nameCheck.hidden = !form.username.value.trim(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const mode = e.submitter?.value || 'login';
    const email = form.email.value.trim();
    const password = form.password.value;
    msg.textContent = '';
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (mode === 'signup') {
        const username = normalizeName(form.username.value);
        if (!USERNAME_RE.test(username)) throw new Error(`Bitte einen Benutzernamen angeben. ${USERNAME_HINT}`);
        if (await nameAvailable(username) === false) throw new Error(`Der Benutzername „${username}“ ist schon vergeben. Bitte wähle einen anderen.`);
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
  $('#forgot').onclick = () => {
    const email = form.email.value.trim();
    if (!email || !form.email.checkValidity()) { msg.textContent = 'Gib zuerst deine E-Mail-Adresse ein.'; form.email.focus(); return; }
    renderResetCode(email);
  };
}

// Passwort vergessen: Die Mail enthält einen Code (und einen Link). Der Code wird hier in der
// App eingegeben. Das klappt auch, wenn die Mail auf einem anderen Gerät oder im Browser statt
// in der App vom Home-Bildschirm geöffnet wird; der Link geht nur im selben Browser.
async function renderResetCode(email) {
  nav.innerHTML = '';
  tabbar.hidden = true;
  app.innerHTML = `
    <form class="auth card-panel" id="reset">
      <h1>Passwort zurücksetzen</h1>
      <p class="hint" id="sent">Wir schicken eine Mail an <strong>${esc(email)}</strong> …</p>
      <label>Code aus der Mail <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required></label>
      <label>Neues Passwort <input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Passwort speichern</button>
      <div class="row">
        <button type="button" class="link" id="resend">Mail noch einmal schicken</button>
        <button type="button" class="link" id="back-login">Zurück zur Anmeldung</button>
      </div>
      <p class="hint" id="msg"></p>
    </form>`;
  const form = $('#reset');
  const send = async () => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    $('#sent').innerHTML = error
      ? esc(/rate limit|seconds/i.test(error.message)
        ? 'Es wurden gerade zu viele Mails verschickt. Bitte warte etwas und versuche es dann noch einmal.'
        : error.message)
      : `Wir haben eine Mail an <strong>${esc(email)}</strong> geschickt. Gib den Code daraus hier ein, zusammen mit deinem neuen Passwort. Die Mail kann ein paar Minuten brauchen; schau auch im Spam-Ordner nach.`;
  };
  $('#resend').onclick = send;
  $('#back-login').onclick = () => renderLogin();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = () => $('#msg');
    msg().textContent = '';
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    // Der Code meldet an. Bis das neue Passwort gespeichert ist, bleibt die Seite
    // „Neues Passwort“ stehen, damit niemand ohne neues Passwort in der App landet.
    recoveringPassword = true;
    const { error } = await supabase.auth.verifyOtp({ email, token: form.code.value.trim(), type: 'recovery' });
    if (error) {
      recoveringPassword = false;
      msg().textContent = /expired|invalid/i.test(error.message)
        ? 'Der Code stimmt nicht oder ist abgelaufen. Lass dir eine neue Mail schicken.' : error.message;
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return;
    }
    const saved = await supabase.auth.updateUser({ password: form.password.value });
    if (saved.error) {
      // Angemeldet ist man jetzt; die Seite „Neues Passwort“ lässt es noch einmal versuchen.
      if (!$('#pw')) renderNewPassword();
      $('#msg').textContent = passwordError(saved.error);
      return;
    }
    recoveringPassword = false;
    toast('Passwort geändert');
    render();
  };
  await send();
}

function passwordError(err) {
  if (/different from the old/i.test(err.message)) return 'Das neue Passwort muss sich vom alten unterscheiden.';
  if (/at least|short/i.test(err.message)) return 'Das Passwort ist zu kurz.';
  if (/weak|pwned|easy to guess/i.test(err.message)) return 'Dieses Passwort ist zu leicht zu erraten. Bitte wähle ein anderes.';
  if (/reauthenticat/i.test(err.message)) return 'Bitte melde dich ab und setze das Passwort über „Passwort vergessen?“ zurück.';
  return err.message;
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
    if (error) { $('#msg').textContent = passwordError(error); return; }
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
  manage: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  shared: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c.8-3 2.8-4.5 5-4.5s4.2 1.5 5 4.5M14 18.5c.5-2 1.7-3 3.2-3s2.7 1 3.3 3"/>',
};

const TABS = [
  ['list', '#/', 'Rezepte'],
  ['pantry', '#/kochen', 'Was kochen?'],
  ['plan', '#/plan', 'Plan'],
  ['shop', '#/einkauf', 'Einkauf'],
  ['manage', '#/verwalten', 'Verwalten'],
];

// Kleine Symbole im Strich der Leiste unten, statt Emojis. Sie erben Farbe und Größe vom
// umgebenden Text; auf den Karten färbt das CSS sie im Orangeton.
const SYMBOLS = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cooked: '<circle cx="12" cy="12.5" r="5"/><path d="M3 4v4.5a1.5 1.5 0 0 0 3 0V4M4.5 10v10M21 4c-1.6.8-2.5 3-2.5 6.5H21V20"/>',
  pot: '<path d="M4 10h16v5.5a4.5 4.5 0 0 1-4.5 4.5h-7A4.5 4.5 0 0 1 4 15.5V10z"/><path d="M2 10h2M20 10h2M9.5 7c0-1.2 1.2-1.6 1.2-3M14 7c0-1.2 1.2-1.6 1.2-3"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-10.8a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
  text: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12.5h7M9 16.5h5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
};
const symbol = (name, cls = 'sym') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${SYMBOLS[name]}</svg>`;
const PLACEHOLDER = `<div class="placeholder" aria-hidden="true">${symbol('pot')}</div>`;

function renderTabbar(first) {
  if (!session) { tabbar.hidden = true; return; }
  const active = { '': 'list', r: 'list', neu: 'list', kombinieren: 'list', kochen: 'pantry', saison: 'pantry', plan: 'plan', einkauf: 'shop', verwalten: 'manage', zutaten: 'manage', orte: 'manage', ladenweg: 'manage', timer: 'manage', geteilt: 'manage', kochbuch: 'manage', hilfe: 'manage', liste: 'shop' }[first || ''];
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

// Eigene Rezepte, plus die aus geteilten Kochbüchern, wenn gewünscht. sharedBooks: Anzahl
// geteilter Kochbücher. Ausgeblendete Kochbücher (Auge unter "Teilen") bleiben außen vor.
async function searchableRecipes() {
  const [own, people, shares] = await Promise.all([
    loadRecipes(), loadPeople().catch(() => ({ owners: [] })), loadRecipeShares().catch(() => []), loadAlternatives(),
  ]);
  const owners = people.owners.filter((o) => !o.hidden);
  const received = shares.filter((x) => x.user_id === session.user.id);
  const sources = owners.length + received.length;
  if (!sources || !includeShared()) return { all: own, sharedBooks: sources };
  const [books, single] = await Promise.all([
    Promise.all(owners.map((o) => loadCookbook(o.owner_id))),
    loadReceived(received),
  ]);
  const shared = books.filter(Boolean).flatMap((b) => b.recipes.map((r) => ({ ...r, from: b.email })));
  const seen = new Set(shared.map((r) => r.id));
  return { all: [...own, ...shared, ...single.filter((r) => !seen.has(r.id))], sharedBooks: sources };
}

const recipeHref = (r) => {
  if (r.received) return `#/erhalten/${r.id}`;
  return r.from ? `#/kochbuch/${r.owner_id}/${r.id}` : `#/r/${r.id}`;
};

function sharedToggle(sharedBooks) {
  return sharedBooks ? `<label class="check"><input type="checkbox" id="include-shared" ${includeShared() ? 'checked' : ''}>
    Auch Rezepte, die andere mit mir geteilt haben</label>` : '';
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
    <div id="pantry-time"></div>
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
      $('#pantry-time').innerHTML = '';
      out.innerHTML = '<p class="hint">Gib ein, was du im Kühlschrank und Vorrat hast. Dann zeige ich dir, welche Rezepte du damit kochen kannst.</p>';
      return;
    }
    const found = suggestRecipes(all, state.items, { useStaples: state.useStaples });
    const hits = timeFilter($('#pantry-time'), draw, (h) => h.recipe)(tagFilter($('#pantry-tags'), found.map((h) => h.recipe), pantryTags, draw)(found));
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
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : PLACEHOLDER}
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

// Zeit-Chips über einer Liste. Liefert eine Funktion, die die Liste filtert und darunter
// meldet, wie viele Rezepte ohne Zeitangabe dabei wegfallen (antippbar: zeigt genau die).
function timeFilter(container, onChange, of = (x) => x) {
  if (!container) return (list) => list;
  container.innerHTML = `<div class="chips time-filter" role="group" aria-label="Zeit">${TIME_LIMITS.map(([m, label]) => `<button type="button" class="chip${timeLimit === m ? ' active' : ''}" data-limit="${m}" aria-pressed="${timeLimit === m}">${symbol('clock')}${label}</button>`).join('')}
    ${timeLimit === 'none' ? '<button type="button" class="chip active" data-limit="none" aria-pressed="true">ohne Zeitangabe ×</button>' : ''}</div>
    <p class="hint time-unknown" hidden></p>`;
  container.querySelectorAll('[data-limit]').forEach((chip) => {
    chip.onclick = () => {
      const v = chip.dataset.limit === 'none' ? 'none' : Number(chip.dataset.limit);
      timeLimit = timeLimit === v ? null : v;
      onChange();
    };
  });
  return (list) => {
    const { shown, unknown } = filterByTime(list, timeLimit, of);
    const note = container.querySelector('.time-unknown');
    note.hidden = !unknown;
    if (unknown) {
      note.innerHTML = `<button type="button" class="link">${unknown === 1 ? '1 Rezept' : `${unknown} Rezepte`} ohne Zeitangabe ausgeblendet</button>`;
      note.querySelector('button').onclick = () => { timeLimit = 'none'; onChange(); };
    }
    return shown;
  };
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

const fromLine = (r) => {
  if (r.received) return `<p class="from-book">von ${esc(r.from)} mit dir geteilt</p>`;
  return r.from ? `<p class="from-book">aus dem Kochbuch von ${esc(r.from)}</p>` : '';
};

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
      <div id="season-time"></div>
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
    const hits = timeFilter($('#season-time'), draw, (h) => h.recipe)(tagFilter($('#season-tags'), found.map((h) => h.recipe), st.tags, draw)(found));
    $('#season-results').innerHTML = hits.length ? `<div class="suggestions">${hits.map((h) => `<a class="suggestion${altStack(h.recipe)}" href="${recipeHref(h.recipe)}">
      ${h.recipe.images[0] ? `<img src="${esc(imageUrl(h.recipe.images[0]))}" alt="" loading="lazy">` : PLACEHOLDER}
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
  warmImages(all);
  app.innerHTML = `
    
    <div class="search">
      <input type="search" id="q" placeholder="Titel, Beschreibung oder Tag suchen" value="${esc(listQuery)}" aria-label="Rezepte durchsuchen">
      <select id="sort" aria-label="Sortierung">
        ${SORTS.filter(([key]) => key !== 'cooked' || cookedColumn).map(([key, label]) => `<option value="${key}"${listSort === key ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip${t === activeTag ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div id="list-time"></div>
    <div id="results" class="grid"></div>`;

  const byId = new Map(all.map((r) => [r.id, r]));
  const results = $('#results');
  const draw = () => {
    const q = listQuery.trim().toLowerCase();
    const found = all.filter((r) => (!activeTag || r.tags.includes(activeTag))
      && (!q || [r.title, r.description, ...r.tags].some((s) => s.toLowerCase().includes(q))));
    const shown = sortRecipes(timeFilter($('#list-time'), draw)(found), listSort, collator.compare);
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
  app.querySelectorAll('.chip[data-tag]').forEach((chip) => {
    chip.onclick = () => {
      activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
      app.querySelectorAll('.chip[data-tag]').forEach((c) => c.classList.toggle('active', c.dataset.tag === activeTag));
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
    // Mit der Maus folgt auf das Wischen selbst ein Klick; der darf das Element nicht gleich wieder schließen.
    if (moved) { moved = false; return; }
    self.close(); openSwipe = null; // Tipp auf ein geöffnetes Element schließt es wieder
  }, true);
}

// Sortieren per Ziehen an den drei Strichen (.drag-handle) der Einträge (li[data-n]) einer Liste.
// Beim Loslassen bekommt done die neue Reihenfolge als Liste der alten Nummern.
function enableDragSort(list, done) {
  list.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // nicht gleichzeitig wischen
      closeSwipes();
      const item = handle.closest('li');
      handle.setPointerCapture(e.pointerId);
      item.classList.add('dragging');
      let lastY = e.clientY;
      let offset = 0;
      const move = (ev) => {
        offset += ev.clientY - lastY;
        lastY = ev.clientY;
        // Über die Mitte des Nachbarn gezogen: Platz tauschen. Bewegt wird der Nachbar, damit das
        // gezogene Element im Dokument bleibt und den Zeiger nicht verliert.
        const prev = item.previousElementSibling;
        const next = item.nextElementSibling;
        if (prev && offset < -prev.offsetHeight / 2) {
          offset += prev.offsetHeight;
          item.after(prev);
        } else if (next && offset > next.offsetHeight / 2) {
          offset -= next.offsetHeight;
          item.before(next);
        }
        item.style.transform = `translateY(${offset}px)`;
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        item.classList.remove('dragging');
        item.style.transform = '';
        const order = [...list.querySelectorAll(':scope > li')].map((li) => Number(li.dataset.n));
        if (order.some((n, i) => n !== i)) done(order);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  });
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

// Ein Player, der sich gemeldet hat (nach askPlayerState), nimmt Befehle an: dann spielt
// ein Zeitstempel das Video ab der Stelle, ohne es neu zu laden. Wer sich gemeldet hat,
// steht am iframe selbst — oben im Rezept stehen alle Videos gleichzeitig, jedes mit
// eigenem Player.
window.addEventListener('message', (e) => {
  if (!isPlayerMessage(e.data)) return;
  for (const frame of document.querySelectorAll('#media-box iframe[data-video]')) {
    if (e.source !== frame.contentWindow) continue;
    frame.dataset.ready = '1';
    // Ob gerade abgespielt wird, entscheidet darüber, ob ein zweiter, stummer Versuch nötig ist.
    const state = playerState(e.data);
    if (state === 'playing') frame.dataset.playing = '1';
    else if (state) delete frame.dataset.playing;
    return;
  }
});

// Einmaliger Hinweis, dass zwischen den Alternativen gewischt werden kann. Er geht weg,
// sobald einmal gewechselt wurde.
const ALT_HINT = 'altHintSeen';
function showAltHint() {
  try { if (localStorage.getItem(ALT_HINT)) return; } catch { return; }
  const stack = $('.stack');
  if (!stack) return;
  stack.insertAdjacentHTML('afterend', `<p class="swipe-hint" id="alt-hint">← Wisch über das Rezept oder tippe auf den Rand der Karte dahinter, um die Alternativen zu sehen. →</p>`);
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
    : PLACEHOLDER;
  const meta = [
    r.rating ? `<span class="rating" aria-label="${r.rating} von 5 Sternen">${symbol('star', 'sym filled').repeat(r.rating)}</span>` : '',
    r.total_minutes != null ? `<span>${symbol('clock')}${esc(formatMinutes(r.total_minutes))}</span>` : '',
    r.last_cooked ? `<span>${symbol('cooked')}gekocht ${esc(formatCooked(r.last_cooked, today()))}</span>` : '',
    ...r.tags.slice(0, 2).map((t) => `<span>${esc(t)}</span>`),
  ].join('');
  return `<a class="card${altStack(r)}" href="${href}">
    ${img}
    <div class="card-body"><h2>${secretMark(r)}${esc(r.title)}${altMark(r, byId)}</h2><div class="meta">${meta}</div></div>
  </a>`;
}

// Schloss vor dem Titel eines Familiengeheimnisses. Leser fremder Kochbücher bekommen
// solche Rezepte gar nicht erst; sieht man eines, ist es eigenes oder einzeln geschickt.
const secretMark = (r) => (r.family_secret ? `<span class="secret-mark" title="Familiengeheimnis" aria-label="Familiengeheimnis">${symbol('lock')}</span>` : '');

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
  const videoHtml = (v) => `<p class="hint offline-only">Ohne Internet lässt sich das Video nicht abspielen.</p><div class="video${v.vertical ? ' vertical' : ''}">
    <iframe data-video="${esc(v.key)}" src="${esc(embedUrl(v, location.origin))}" title="Video zum Rezept"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  // Alle Videos und die Bilder stehen gleichzeitig im Kasten, sichtbar ist immer nur eines.
  // So bleibt jeder Player geladen: ein Zeitstempel kann ihn direkt anspringen und starten,
  // und beim Wechseln geht die Stelle im anderen Video nicht verloren.
  const mediaHtml = () => tabs.map((t, i) => `<div class="media-panel" data-panel="${esc(t.key)}"${i ? ' hidden' : ''}>
    ${t.video ? videoHtml(t.video) : galleryHtml()}</div>`).join('');
  // Videos und Bilder stehen nach den Zutaten, über der Überschrift Zubereitung.
  const mediaBlock = shown ? `<div class="media-block">
    ${tabs.length > 1 ? `<div class="media-tabs" id="media-tabs" role="tablist">${tabs.map((t, i) => `<button type="button" class="chip${i === 0 ? ' active' : ''}"
      data-media="${esc(t.key)}" role="tab" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>` : ''}
    <div class="media" id="media-box">${mediaHtml()}</div></div>` : '';

  // Wo in den Schritten Mengen stehen; ohne einen Treffer gibt es auch keinen Schalter dafür.
  const stepQty = stepAmounts(r.steps.map(stepText), r.ingredients);
  const hasStepAmounts = stepQty.some((list) => list.length);

  // Alternativen liegen als Kartenstapel hinter der aktuellen Karte: in die Richtungen,
  // in die auch gewischt werden kann.
  const prev = index > 0 ? group[index - 1] : null;
  const next = index < group.length - 1 ? group[index + 1] : null;

  app.innerHTML = `
    <article class="recipe">
      ${back ? `<a class="back" href="${back}">← ${esc(backLabel)}</a>` : ''}
      ${from ? `<p class="hint from">${esc(from)}</p>` : ''}
      <div class="stack${prev ? ' has-prev' : ''}${next ? ' has-next' : ''}">
        ${prev ? `<button type="button" class="stack-edge prev" data-alt="${index - 1}" aria-label="Zurück zu „${esc(prev.title)}“"><span>‹</span></button>` : ''}
        ${next ? `<button type="button" class="stack-edge next" data-alt="${index + 1}" aria-label="Weiter zu „${esc(next.title)}“"><span>›</span></button>` : ''}
        <div class="recipe-card">
          <h1>${secretMark(r)}${esc(r.title)}</h1>
          ${own ? `<div class="stars" role="group" aria-label="Bewertung">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${(r.rating ?? 0) >= n ? 'on' : ''}" aria-label="${n} von 5 Sternen" aria-pressed="${r.rating === n}">★</button>`).join('')}</div>`
    : r.rating ? `<div class="stars readonly" aria-label="${r.rating} von 5 Sternen">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>` : ''}
          ${r.family_secret && own ? '<p class="hint secret-hint">Familiengeheimnis: Wer dein Kochbuch liest, sieht dieses Rezept nicht.</p>' : ''}
          ${r.description ? `<p class="lead">${esc(r.description)}</p>` : ''}
          ${r.tags.length ? `<div class="chips static">${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
          ${r.total_minutes != null || r.cook_minutes != null || r.last_cooked ? `<dl class="times">
            ${r.total_minutes != null ? `<div><dt>Gesamtzeit</dt><dd>${formatMinutes(r.total_minutes)}</dd></div>` : ''}
            ${r.cook_minutes != null ? `<div><dt>Koch-/Backzeit</dt><dd>${formatMinutes(r.cook_minutes)}</dd></div>` : ''}
            ${r.last_cooked ? `<div><dt>Zuletzt gekocht</dt><dd>${esc(formatCooked(r.last_cooked, today()))}</dd></div>` : ''}
          </dl>` : ''}
          ${group.length > 1 ? `<p class="stack-at">${index === 0 ? 'Hauptrezept' : `Alternative ${index} von ${group.length - 1}`}
            · ${group.length - 1 === 1 ? 'eine Alternative' : `${group.length - 1} Alternativen`} · wischen oder auf den Rand tippen</p>` : ''}
        </div>
      </div>
      ${own ? '<div id="planned"></div>' : ''}

      ${r.ingredients.length ? `<section>
        <div class="section-head">
          <h2>Zutaten</h2>
          <div class="stepper" role="group" aria-label="Anzahl Portionen">
            <button class="btn small" data-d="-1" aria-label="Eine Portion weniger">−</button>
            <label class="srv-field"><input id="srv" type="number" min="1" max="100" step="1"
              inputmode="numeric" value="${servings}" aria-label="Anzahl Portionen"><span id="srv-unit"></span></label>
            <button class="btn small" data-d="1" aria-label="Eine Portion mehr">+</button>
          </div>
        </div>
        <ul class="ingredients" id="ing"></ul>
      </section>` : ''}

      ${mediaBlock}

      ${r.steps.length ? `<section><div class="section-head"><h2>Zubereitung</h2>
        ${hasStepAmounts ? `<label class="check small"><input type="checkbox" id="step-amounts"${showStepAmounts() ? ' checked' : ''}> Mengen in den Schritten</label>` : ''}</div>
        <ol class="steps" id="steps"></ol></section>` : ''}
      <p class="checks-bar" id="checks-bar" hidden><button type="button" class="link" id="clear-checks">Haken entfernen</button></p>

      ${r.notes ? `<section><h2>Notizen</h2><p class="notes">${linkify(r.notes)}</p></section>` : ''}

      ${hasNutrition(r.nutrition) ? `<section><h2>Nährwerte <small class="hint">${r.nutrition.per === '100 g' ? 'pro 100 g' : 'pro Portion'}</small></h2>
        <dl class="nutrition">${NUTRIENTS.filter(([k]) => r.nutrition[k] != null).map(([k, label, unit]) => `<div><dt>${label}</dt><dd>${formatNutrient(r.nutrition[k])} ${unit}</dd></div>`).join('')}</dl></section>` : ''}

      ${sources.length ? `<section><h2>Quellen</h2><ul class="sources">
        ${sources.map(([u, href]) => `<li><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u))}</a></li>`).join('')}
      </ul></section>` : ''}

      <div class="actions">
        ${r.steps.length || r.ingredients.length ? `<button class="btn primary" id="cook-btn">${symbol('pot')}Kochen</button>` : ''}${own ? `
        <button class="btn needs-net" id="plan-btn">Einplanen</button>
        <a class="btn needs-net" href="#/r/${r.id}/bearbeiten">Bearbeiten</a>
        <button class="btn needs-net" id="share">Teilen</button>
        <button class="btn danger needs-net" id="del">Löschen</button>` : session
    ? '<button class="btn primary needs-net" id="copy">In mein Kochbuch übernehmen</button>'
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
    app.querySelectorAll('.stack-edge[data-alt]').forEach((b) => {
      b.onclick = () => { seenAltHint(); location.hash = hrefOf(Number(b.dataset.alt)); };
    });
    enableRecipeSwipe($('.recipe'), (step) => { seenAltHint(); go(step); });
    showAltHint();
  }

  // Schritte mit Zeitstempeln, Timern und den Mengen der Zutaten für die eingestellten Portionen.
  const stepList = $('#steps');
  const drawSteps = () => {
    if (stepList) {
      const factor = servings / r.servings;
      const amountOf = showStepAmounts()
        ? ({ ing, share }) => formatQuantity(r.ingredients[ing], factor * share) : null;
      stepList.innerHTML = r.steps.map((s, si) => {
        const v = stepVideo(s, videos);
        const t = v ? stepTime(s) : null;
        // Bei mehreren Videos steht am Zeitstempel, in welchem er liegt.
        const n = videos.length > 1 ? `${videos.indexOf(v) + 1} · ` : '';
        return `<li class="checkable" data-step="${si}">${t != null ? `<button type="button" class="seek" data-t="${t}" data-video="${esc(v.key)}"
          aria-label="Video ${videos.length > 1 ? `${videos.indexOf(v) + 1} ` : ''}ab ${formatTime(t)} abspielen">▶ ${n}${formatTime(t)}</button> ` : ''}${stepTextHtml(stepText(s), `${r.title} · Schritt ${si + 1}`, stepQty[si], amountOf)}</li>`;
      }).join('');
    }
    drawChecks();
  };
  const stepBox = $('#step-amounts');
  if (stepBox) stepBox.onchange = () => { setShowStepAmounts(stepBox.checked); drawSteps(); };

  const ingList = $('#ing');
  // keepInput: beim Tippen im Feld bleibt die Eingabe stehen, nur die Mengen rechnen neu.
  const drawIngredients = ({ keepInput = false } = {}) => {
    if (!ingList) { drawSteps(); return; }
    const srv = $('#srv');
    if (srv && !keepInput) srv.value = String(servings);
    $('#srv-unit').textContent = servings === 1 ? 'Portion' : 'Portionen';
    const factor = servings / r.servings;
    ingList.innerHTML = r.ingredients.map((i, ii) => `<li class="checkable" data-ing="${ii}"><span class="qty">${esc(formatQuantity(i, factor))}</span><span>${ingredientLabel(i)}</span></li>`).join('');
    drawSteps();
  };
  // Haken: ein Tipp auf eine Zutat oder einen Schritt streicht sie durch. Sie bleiben auf dem
  // Gerät, bis man sie entfernt oder 12 Stunden lang nichts mehr abhakt.
  const checkKey = r.id;
  const drawChecks = () => {
    const c = checksFor(loadChecks(), checkKey);
    app.querySelectorAll('[data-ing]').forEach((li) => li.classList.toggle('checked', c.ing.includes(Number(li.dataset.ing))));
    app.querySelectorAll('.steps [data-step]').forEach((li) => li.classList.toggle('checked', c.steps.includes(Number(li.dataset.step))));
    const bar = $('#checks-bar');
    if (bar) bar.hidden = !c.ing.length && !c.steps.length;
  };
  app.querySelector('.recipe').addEventListener('click', (e) => {
    const chip = e.target.closest('.timer-chip');
    if (chip) { addTimer(chip.dataset.label, Number(chip.dataset.timer)); return; }
    if (e.target.closest('button, a, input')) return;
    const li = e.target.closest('.checkable');
    if (!li) return;
    const kind = li.dataset.ing != null ? 'ing' : 'steps';
    saveChecks(toggleCheck(loadChecks(), checkKey, kind, Number(li.dataset.ing ?? li.dataset.step)));
    drawChecks();
  });
  const clearBtn = $('#clear-checks');
  if (clearBtn) clearBtn.onclick = () => { saveChecks(clearChecks(loadChecks(), checkKey)); drawChecks(); };
  const setServings = (n, opts) => {
    servings = Math.max(1, Math.min(100, Math.round(n)));
    drawIngredients(opts);
  };
  app.querySelectorAll('.stepper button').forEach((b) => {
    b.onclick = () => setServings(servings + Number(b.dataset.d));
  });
  // Die Zahl kann auch getippt werden. Halbfertige Eingaben (leeres Feld) bleiben stehen,
  // beim Verlassen wird auf den geltenden Wert zurückgesetzt.
  const srvInput = $('#srv');
  if (srvInput) {
    srvInput.addEventListener('input', () => {
      const n = Number(srvInput.value);
      if (!Number.isFinite(n) || n < 1) return;
      setServings(n, { keepInput: true });
    });
    srvInput.addEventListener('blur', () => { srvInput.value = String(servings); });
  }
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

  const frames = () => [...app.querySelectorAll('#media-box iframe[data-video]')];
  const frameOf = (key) => frames().find((f) => f.dataset.video === key);

  // Bittet den Player, sich zu melden, und springt an die gewünschte Stelle: TikTok kennt
  // keine Startzeit in der Adresse, und bei YouTube hilft der Befehl, wenn die Wiedergabe
  // trotz autoplay nicht von selbst anläuft.
  const watchPlayer = (frame, video, seconds = null) => {
    if (!frame || !video) return;
    frame.addEventListener('load', () => {
      // Die Bitte wird wiederholt, bis sich der Player meldet: direkt nach dem Laden ist
      // sein Innenleben manchmal noch nicht bereit, und dann geht die erste verloren.
      let tries = 0;
      const ask = () => {
        if (frame.dataset.ready || tries >= 12 || !frame.isConnected) return;
        tries += 1;
        askPlayerState(frame, video);
        setTimeout(ask, 250);
      };
      ask();
      if (seconds != null) {
        seekTo(frame, video, seconds);
        setTimeout(() => { if (frame.isConnected) seekTo(frame, video, seconds); }, 700);
      }
    }, { once: true });
  };
  // Der sichtbare Player trägt #video (siehe showMedia), beim Öffnen also der erste.
  if (shown?.video) frameOf(shown.key).id = 'video';
  // Beim Öffnen melden sich alle Player, damit später jeder Zeitstempel sofort wirkt.
  tabs.filter((t) => t.video).forEach((t) => watchPlayer(frameOf(t.key), t.video));

  // Hat sich ein Player nie gemeldet, bleibt nur: mit der Startzeit neu laden.
  const reloadAt = (entry, seconds) => {
    const frame = frameOf(entry.key);
    if (!frame) return;
    delete frame.dataset.ready;
    watchPlayer(frame, entry.video, seconds);
    frame.src = embedUrl(entry.video, location.origin, seconds);
  };

  // Springt an die Stelle und startet. Läuft die Wiedergabe kurz darauf immer noch nicht,
  // folgt ein stummer Versuch mit Ton gleich danach: mit Ton verweigern Browser den Start
  // ohne Geste im Video selbst, bei TikTok durchweg.
  const playAt = (entry, seconds) => {
    const frame = frameOf(entry.key);
    if (!frame) return;
    seekTo(frame, entry.video, seconds);
    clearTimeout(Number(frame.dataset.retry));
    frame.dataset.retry = String(setTimeout(() => {
      if (frame.isConnected && !frame.dataset.playing) playMuted(frame, entry.video, seconds);
    }, 900));
  };

  // Zeigt ein Video oder die Bilder. Der sichtbare Player trägt die Kennung #video, damit
  // es weiterhin genau einen gibt, der gemeint ist.
  const showMedia = (key, seconds = null) => {
    const box = $('#media-box');
    const next = tabs.find((t) => t.key === key);
    if (!box || !next) return;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (next.key !== shown.key) {
      if (shown.video) {
        const alt = frameOf(shown.key);
        clearTimeout(Number(alt?.dataset.retry));
        pausePlayer(alt, shown.video);
      }
      app.querySelectorAll('#media-box [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== next.key; });
      frames().forEach((f) => { if (f.dataset.video === next.key) f.id = 'video'; else f.removeAttribute('id'); });
      shown = next;
      app.querySelectorAll('#media-tabs [data-media]').forEach((t) => {
        const on = t.dataset.media === next.key;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      });
    }
    if (!next.video || seconds == null) return;
    const frame = frameOf(next.key);
    if (frame?.dataset.ready) playAt(next, seconds);
    else reloadAt(next, seconds);
  };

  app.querySelectorAll('#media-tabs [data-media]').forEach((t) => {
    t.onclick = () => showMedia(t.dataset.media);
  });

  // Zeitstempel bei den Schritten: zum passenden Video und dort an die Stelle springen.
  // Die Schritte werden bei jeder Portionenänderung neu gezeichnet, darum hängt der Klick am Ganzen.
  stepList?.addEventListener('click', (e) => {
    const b = e.target.closest('.seek');
    if (b) showMedia(b.dataset.video, Number(b.dataset.t));
  });

  const cookBtn = $('#cook-btn');
  if (cookBtn) cookBtn.onclick = () => openCookMode(r, { servings, own, videos, onClose: drawChecks });

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

  $('#share').onclick = () => shareRecipe(r);

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

// Schickt ein Rezept als Einladung an eine Person.
function shareRecipe(r) {
  return shareInvite({ kind: 'recipe', recipe_id: r.id }, r.title);
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
// aus dem Zutaten und Portionen zunächst übernommen werden.
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
      <p class="hint">Hauptrezept ist <strong>${esc(main.title)}</strong>: seine Zutaten und ${servings} ${servings === 1 ? 'Portion' : 'Portionen'} stehen schon im neuen Rezept.
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
    const offer = all.filter((x) => !taken.has(x.id));
    const inPicker = new Map(offer.map((x) => [x.id, x]));
    // Reiter wie beim Hinzufügen von Alternativen: Tags der beteiligten Rezepte, deren
    // Alternativen, Titelsuche.
    const related = relatedAlternatives(links, main.id, [...taken])
      .filter((x) => inPicker.has(x.id))
      .map((x) => ({ r: inPicker.get(x.id), note: `Alternative zu ${byId(x.via)?.title ?? 'einem Rezept'}` }));
    const picked2 = await pickRecipeSheet(offer, 'Rezept zum Kombinieren', {
      tags: [...new Set(chosen.flatMap((x) => x.tags))].sort(collator.compare),
      related,
    });
    if (!picked2) return;
    const r = all.find((x) => x.id === picked2);
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
      // Steckt ein Familiengeheimnis drin, ist auch das neue Rezept eines.
      family_secret: chosen.some((r) => r.family_secret),
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

// Vollbild-Auswahl. Der Hintergrund wird festgestellt, damit nicht versehentlich im
// Rezept dahinter gescrollt wird; gescrollt wird nur in der Trefferliste.
function openPicker(title, body) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet full';
  dialog.innerHTML = `<form method="dialog" class="picker">
    <header class="picker-head">
      <button class="icon-btn" value="back" formnovalidate aria-label="Zurück">←</button>
      <h2>${esc(title)}</h2>
    </header>
    ${body}
  </form>`;
  document.body.append(dialog);
  document.documentElement.classList.add('sheet-open');
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
  });
  dialog.showModal();
  return dialog;
}

// Zeile in einer Trefferliste: ein Rezept zum Antippen, mit Zusatz, Tags und Haken.
const pickRow = (r, { note = '', on = false, extra = '', tags = '' } = {}) => `<div class="pick-item">
  <button type="button" class="pick-row${on ? ' on' : ''}" data-pick="${esc(r.id)}" aria-pressed="${on}">
    <span>${esc(r.title)}${note ? `<small>${esc(note)}</small>` : ''}${tags}</span>
    <span class="pick-mark">${on ? '✓' : '+'}</span>
  </button>${extra}</div>`;

// Reiterleiste der Auswahl-Dialoge. Ein Reiter ohne Treffer ist ausgegraut und nicht
// anwählbar; die Zahlen kommen vom Dialog, weil sie sich mit jeder Auswahl ändern.
const PICK_TABS = ['tags', 'verwandte', 'titel'];
const pickTabsHtml = (tab, counts, relatedLabel) => {
  const label = { tags: 'Tags', verwandte: relatedLabel, titel: 'Titel' };
  return PICK_TABS.map((t) => `<button type="button" class="chip${t === tab ? ' active' : ''}"
    data-tab="${t}"${counts[t] ? '' : ' disabled'}>${esc(label[t])}</button>`).join('');
};

// Die Tags des eigenen Rezepts als Filter: mehrere lassen sich auswählen, dann zählen
// nur diese. Ohne Auswahl zählen alle Tags.
const tagFilterHtml = (tags, active) => (tags.length ? `<div class="chips static pick-tags">
  <span class="hint">Tags:</span>${tags.map((t) => `<button type="button"
    class="chip small${active.includes(t) ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
  ${active.length ? '<button type="button" class="chip small ghost" data-tag-clear>alle</button>' : ''}</div>` : '');

// Die Tags eines Treffers; die passenden sind hervorgehoben.
const pickTagsHtml = (r, highlight) => {
  if (!r.tags?.length) return '';
  const hit = new Set(tagMatches(r.tags, highlight).map((t) => t.toLowerCase()));
  return `<span class="pick-tag-row">${r.tags.map((t) => `<span class="pick-tag${hit.has(t.toLowerCase()) ? ' match' : ''}">${esc(t)}</span>`).join('')}</span>`;
};

// Ein Rezept auswählen, z. B. zum Kombinieren: dieselben Reiter wie beim Hinzufügen von
// Alternativen. tags: Tags der schon beteiligten Rezepte, related: deren Alternativen als
// { r, note }. Liefert die Kennung oder null.
function pickRecipeSheet(candidates, title = 'Rezept wählen', { tags = [], related = [], relatedLabel = 'Alternativen' } = {}) {
  return new Promise((resolve) => {
    let tab = 'tags';
    let active = []; // ausgewählte Tags
    const dialog = openPicker(title, `
      <div class="chips" id="pick-tabs"></div>
      <div id="pick-filter"></div>
      <input id="pick-q" type="search" placeholder="Titel oder Tag" autocomplete="off" enterkeyhint="search" hidden>
      <div class="pick-list" id="pick-hits"></div>`);
    const input = dialog.querySelector('#pick-q');
    const hits = dialog.querySelector('#pick-hits');
    let picked = null;

    const byTags = () => (active.length
      ? filterByTags(candidates, active, { compare: collator.compare })
      : filterByTags(candidates, tags, { compare: collator.compare }));
    const byTitle = () => {
      const q = input.value.trim().toLowerCase();
      return candidates
        .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)))
        .slice(0, 30);
    };

    const drawTabs = () => {
      const counts = { tags: tags.length, verwandte: related.length, titel: candidates.length };
      dialog.querySelector('#pick-tabs').innerHTML = pickTabsHtml(tab, counts, relatedLabel);
      dialog.querySelectorAll('[data-tab]').forEach((b) => {
        b.onclick = () => { tab = b.dataset.tab; drawAll(); };
      });
    };

    const drawFilter = () => {
      dialog.querySelector('#pick-filter').innerHTML = tab === 'tags' ? tagFilterHtml(tags, active) : '';
      dialog.querySelectorAll('[data-tag]').forEach((b) => {
        b.onclick = () => {
          const t = b.dataset.tag;
          active = active.includes(t) ? active.filter((x) => x !== t) : [...active, t];
          drawAll();
        };
      });
      const clear = dialog.querySelector('[data-tag-clear]');
      if (clear) clear.onclick = () => { active = []; drawAll(); };
    };

    const drawHits = () => {
      input.hidden = tab !== 'titel';
      const list = tab === 'verwandte' ? related : (tab === 'tags' ? byTags() : byTitle()).map((r) => ({ r, note: '' }));
      const highlight = tab === 'tags' ? (active.length ? active : tags) : [];
      hits.innerHTML = list.length
        ? list.map(({ r, note }) => pickRow(r, { note, tags: pickTagsHtml(r, highlight) })).join('')
        : `<p class="hint">${tab === 'verwandte' ? 'Die beteiligten Rezepte haben keine Alternativen.'
          : tab === 'tags' ? 'Kein Rezept mit diesen Tags. Suche unter „Titel“.' : 'Kein Rezept gefunden.'}</p>`;
      hits.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => { picked = b.dataset.pick; dialog.close(); };
      });
    };

    const drawAll = () => { drawTabs(); drawFilter(); drawHits(); };
    if (!byTags().length) tab = related.length ? 'verwandte' : 'titel';
    input.oninput = drawHits;
    drawAll();
    dialog.addEventListener('close', () => resolve(picked));
  });
}

// Alternativen verwalten: drei Reiter, bleibt nach einer Auswahl offen und fragt nach,
// wenn das gewählte Rezept selbst Alternativen hat. Liefert die verknüpften Kennungen.
function alternativesSheet({ selfId, tags, candidates, linked }) {
  return new Promise((resolve) => {
    const byId = new Map(candidates.map((r) => [r.id, r]));
    let chosen = [...linked];
    let tab = 'tags';
    let activeTags = []; // ausgewählte Tags des Rezepts; ohne Auswahl zählen alle
    let ask = null; // Kennung des Rezepts, zu dessen Gruppe gerade gefragt wird
    const dialog = openPicker('Alternative hinzufügen', `
      <div class="chips" id="alt-tabs"></div>
      <div id="alt-filter"></div>
      <input id="alt-q" type="search" placeholder="Titel oder Tag" autocomplete="off" enterkeyhint="search" hidden>
      <div class="pick-list" id="alt-hits"></div>
      <footer class="picker-foot">
        <div class="chips static" id="alt-chosen"></div>
        <button class="btn primary" value="done">Fertig</button>
      </footer>`);
    const input = dialog.querySelector('#alt-q');
    const hits = dialog.querySelector('#alt-hits');

    // Vorschläge nach gemeinsamen Tags; schon verknüpfte stehen mit Haken dabei. Sind
    // Tags ausgewählt, zählen nur diese.
    const byTags = () => (activeTags.length
      ? filterByTags(candidates, activeTags, { exclude: [selfId], compare: collator.compare })
      : suggestAlternatives({ id: selfId, tags }, candidates, [], { limit: 50, compare: collator.compare }));
    // Alternativen der schon verknüpften Rezepte, also die Gruppe einen Schritt weiter.
    const related = () => relatedAlternatives(links, selfId, chosen)
      .filter((x) => byId.has(x.id))
      .map((x) => ({ r: byId.get(x.id), note: `über ${byId.get(x.via)?.title ?? 'eine Alternative'}` }));
    const byTitle = () => {
      const q = input.value.trim().toLowerCase();
      return candidates
        .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)))
        .slice(0, 30);
    };

    const drawTabs = () => {
      // Der Reiter "Tags" bleibt anwählbar, solange das Rezept Tags hat — auch wenn ein
      // gesetzter Filter gerade nichts findet.
      const counts = { tags: tags.length, verwandte: related().length, titel: candidates.length };
      dialog.querySelector('#alt-tabs').innerHTML = pickTabsHtml(tab, counts, 'Verwandte');
      dialog.querySelectorAll('[data-tab]').forEach((b) => {
        b.onclick = () => { tab = b.dataset.tab; ask = null; drawAll(); };
      });
    };

    const drawFilter = () => {
      dialog.querySelector('#alt-filter').innerHTML = tab === 'tags' ? tagFilterHtml(tags, activeTags) : '';
      dialog.querySelectorAll('[data-tag]').forEach((b) => {
        b.onclick = () => {
          const t = b.dataset.tag;
          activeTags = activeTags.includes(t) ? activeTags.filter((x) => x !== t) : [...activeTags, t];
          ask = null;
          drawAll();
        };
      });
      const clear = dialog.querySelector('[data-tag-clear]');
      if (clear) clear.onclick = () => { activeTags = []; ask = null; drawAll(); };
    };

    const drawChosen = () => {
      dialog.querySelector('#alt-chosen').innerHTML = chosen.length
        ? `<span class="hint">Verknüpft:</span>${chosen.map((id) => `<span class="chip tag-chip">${esc(byId.get(id)?.title ?? 'Rezept')}
            <button type="button" data-off="${esc(id)}" aria-label="Verknüpfung lösen">×</button></span>`).join('')}`
        : '<span class="hint">Noch keine Alternative verknüpft.</span>';
      dialog.querySelectorAll('[data-off]').forEach((b) => {
        b.onclick = () => { chosen = chosen.filter((x) => x !== b.dataset.off); ask = null; drawAll(); };
      });
    };

    const drawHits = () => {
      const list = tab === 'verwandte' ? related() : (tab === 'tags' ? byTags() : byTitle()).map((r) => ({ r, note: '' }));
      const highlight = tab === 'tags' ? (activeTags.length ? activeTags : tags) : [];
      input.hidden = tab !== 'titel';
      hits.innerHTML = list.length ? list.map(({ r, note }) => {
        const on = chosen.includes(r.id);
        // Nachfrage nach der ganzen Gruppe, direkt unter dem gewählten Rezept.
        const group = alternativeIds(links, r.id).filter((x) => x !== selfId && !chosen.includes(x));
        const extra = ask === r.id && group.length ? `<div class="pick-ask">
          <p>„${esc(r.title)}“ hat ${group.length === 1 ? 'eine weitere Alternative' : `${group.length} weitere Alternativen`}. Auch verknüpfen?</p>
          <div class="row"><button type="button" class="btn small primary" data-group="${esc(r.id)}">Alle ${group.length + 1} verknüpfen</button>
            <button type="button" class="btn small ghost" data-only="${esc(r.id)}">Nur „${esc(r.title)}“</button></div></div>` : '';
        return pickRow(r, { note, on, extra, tags: pickTagsHtml(r, highlight) });
      }).join('') : `<p class="hint">${tab === 'verwandte'
        ? 'Die verknüpften Rezepte haben selbst keine weiteren Alternativen.'
        : tab === 'tags' ? (activeTags.length ? 'Kein Rezept mit diesen Tags. Nimm einen Tag heraus oder suche unter „Titel“.'
          : 'Keine Vorschläge – die Tags passen zu keinem anderen Rezept. Suche unter „Titel“.') : 'Kein Rezept gefunden.'}</p>`;

      hits.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => {
          const id = b.dataset.pick;
          if (chosen.includes(id)) { chosen = chosen.filter((x) => x !== id); ask = null; }
          else { chosen = [...chosen, id]; ask = id; }
          drawAll();
        };
      });
      hits.querySelectorAll('[data-group]').forEach((b) => {
        b.onclick = () => {
          const add = alternativeIds(links, b.dataset.group).filter((x) => x !== selfId);
          chosen = [...new Set([...chosen, ...add])];
          ask = null;
          drawAll();
        };
      });
      hits.querySelectorAll('[data-only]').forEach((b) => { b.onclick = () => { ask = null; drawAll(); }; });
    };

    const drawAll = () => { drawTabs(); drawFilter(); drawHits(); drawChosen(); };
    if (!byTags().length) tab = 'titel';
    input.oninput = drawHits;
    drawAll();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'back' ? null : chosen));
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
      <a class="back" href="${existing ? `#/r/${existing.id}` : '#/'}">← ${existing ? 'Zum Rezept' : 'Zur Übersicht'}</a>
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
            <label class="btn" id="import-photo-btn">${symbol('camera')}Aus Fotos<input type="file" id="import-photos" accept="image/*" multiple hidden></label>
            <label class="btn" id="import-video-btn">${symbol('video')}Aus Video<input type="file" id="import-video" accept="video/*" hidden></label>
            <button type="button" class="btn" id="import-text-btn">${symbol('text')}Text einfügen</button>
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
      ${secretColumn ? `<label class="lock-toggle"><input type="checkbox" name="family_secret"${r.family_secret ? ' checked' : ''}>
        <span class="lock-icon">${symbol('lock', 'sym locked')}${symbol('unlock', 'sym unlocked')}</span>
        <span><strong>Familiengeheimnis</strong>
          <span class="lock-texts"><small class="when-on">Geschlossen: Leser deines Kochbuchs sehen es nicht, nur wem du es einzeln schickst.</small>
          <small class="when-off">Offen: Leser deines Kochbuchs sehen es. Tippe aufs Schloss, um es zu verbergen.</small></span></span></label>` : ''}

      <div class="cols">
        <label>Anzahl Portionen <input name="servings" type="number" min="1" max="100" required value="${r.servings}"></label>
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
        <div class="nutrition-calc">
          <button type="button" class="btn small" id="nutrition-btn">Nährwerte ermitteln</button>
          <small>Schätzt die Werte pro Portion aus den Zutaten unten und überschreibt die Felder.</small>
        </div>
        <p class="hint" id="nutrition-msg" role="status"></p>
      </details>

      <label>Zutaten <textarea name="ingredients" rows="8" placeholder="200 g Mehl&#10;2 Eier&#10;1 Prise Salz">${esc(r.ingredients.map(ingredientToLine).join('\n'))}</textarea>
        <small>Eine Zutat pro Zeile, Menge zuerst. Die Menge bezieht sich auf die Anzahl Portionen oben.</small></label>
      <ul class="parse-preview" id="preview"></ul>
      <p class="hint preview-hint">Wische eine Zutat nach links, um Kategorie und Einkaufsorte zu ändern, oder nach rechts, um sie zu löschen. An den drei Strichen ziehst du sie an eine andere Stelle.</p>

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
    // Nur Zeilen, die eine Zutat ergeben; lines[n] ist die Zeile zur n-ten Zutat.
    const lines = form.ingredients.value.split('\n').filter((l) => parseIngredientLine(l));
    const items = lines.map(parseIngredientLine);
    // Je Zutat Kategorie und Einkaufsorte. Nach links wischen zeigt „Ändern“ (gilt für diese Zutat
    // in allen Rezepten und Einkaufslisten), nach rechts „Löschen“; die drei Striche verschieben sie.
    preview.innerHTML = items.map((i, n) => `<li class="swipe" data-n="${n}">
      <div class="swipe-actions start"><button type="button" class="swipe-btn danger" data-drop-ing="${n}">Löschen</button></div>
      ${i.name ? `<div class="swipe-actions end"><button type="button" class="swipe-btn accent" data-ing="${n}">Ändern</button></div>` : ''}
      <div class="ing-row"><span class="qty">${esc(formatQuantity(i)) || '–'}</span><span>${ingredientLabel(i)}
        ${i.name ? `<small class="ing-info">${esc(categoryOf(i.name))} · ${symbol('pin')}${esc(placeLabel(placesOf(i.name)))}</small>` : ''}</span>
        <button type="button" class="drag-handle" aria-label="${esc(i.name || 'Zutat')} verschieben">${symbol('grip')}</button></div></li>`).join('');
    const setLines = (list) => { form.ingredients.value = list.join('\n'); drawPreview(); };
    preview.querySelectorAll('.swipe').forEach((el) => enableSwipe(el, el.querySelector('.ing-row')));
    preview.querySelectorAll('[data-ing]').forEach((b) => {
      b.onclick = async () => {
        closeSwipes();
        if (await editIngredient(items[Number(b.dataset.ing)].name)) drawPreview();
      };
    });
    preview.querySelectorAll('[data-drop-ing]').forEach((b) => {
      b.onclick = () => {
        closeSwipes();
        setLines(lines.filter((_, n) => n !== Number(b.dataset.dropIng)));
      };
    });
    enableDragSort(preview, (order) => setLines(order.map((n) => lines[n])));
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
      const picked = await alternativesSheet({
        selfId: existing?.id ?? '',
        tags,
        candidates: own.filter((x) => x.id !== existing?.id),
        linked: altIds,
      });
      if (!picked) return;
      altIds = picked.filter((x) => x !== existing?.id);
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

  setupNutritionCalc(form, setNutrition);
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
      // Die Spalte gibt es erst nach familiengeheimnis.sql.
      if (form.family_secret) row.family_secret = form.family_secret.checked;
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

// Ein eingeplanter Tag, der vorbei ist, gilt als gekocht: bevor die alten Einträge aus
// dem Plan fallen, wird ihr Datum als "zuletzt gekocht" am Rezept vermerkt — nur, wenn es
// neuer ist als das, was dort steht.
async function markCooked() {
  if (!cookedColumn) return;
  const { data } = await supabase.from('meal_plan').select('recipe_id, planned_for')
    .eq('owner_id', session.user.id).lt('planned_for', today());
  const latest = cookedFromPlan(data);
  if (!latest.size) return;
  const own = await loadRecipes();
  for (const [id, day] of latest) {
    const r = own.find((x) => x.id === id);
    if (!r || (r.last_cooked && r.last_cooked >= day)) continue;
    const { error } = await supabase.from('recipes').update({ last_cooked: day }).eq('id', id);
    if (error) { cookedColumn = false; return; } // Spalte gibt es erst nach gekocht.sql
    r.last_cooked = day;
  }
}

// Kommende Einträge; vergangene werden dabei aufgeräumt.
async function loadPlan() {
  await markCooked();
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
  // Wer den Kochmodus startet, kocht heute: das Rezept kommt für heute in den Plan.
  $('#cook-btn')?.addEventListener('click', async () => {
    if (await planToday(r, currentServings())) { toast('Für heute eingeplant'); drawPlanned(); }
  });
}

// Trägt das Rezept für heute in den Plan ein, falls es dort noch nicht steht; andere
// Einträge für heute bleiben. Fehler (etwa offline) bleiben still, das Kochen geht vor.
// Liefert true, wenn ein Eintrag dazugekommen ist.
async function planToday(r, servings) {
  const { data, error } = await supabase.from('meal_plan').select('id')
    .eq('owner_id', session.user.id).eq('recipe_id', r.id).eq('planned_for', today()).limit(1);
  if (error || data?.length) return false;
  const { error: insertError } = await supabase.from('meal_plan').insert({
    recipe_id: r.id, planned_for: today(), servings: Math.max(1, Math.min(100, servings || r.servings)),
  });
  return !insertError;
}

// Dialog zum Einplanen; setzt die Zutaten auf Wunsch gleich auf die Einkaufsliste.
// Liefert true, wenn eingeplant wurde.
async function planRecipe(r, servings = r.servings) {
  const { value, form } = await openSheet(`<h2>„${esc(r.title)}“ einplanen</h2>
    <label>Datum <input type="date" name="date" required min="${today()}" value="${today()}"></label>
    <label>Anzahl Portionen <input type="number" name="servings" min="1" max="100" required value="${servings}"></label>
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
          ${r.images[0] ? `<img src="${esc(imageUrl(r.images[0]))}" alt="" loading="lazy">` : PLACEHOLDER}
          <div><h3><a href="#/r/${r.id}">${esc(r.title)}</a>${altMark(r, byId)}</h3>
            <p class="missing">${p.servings} ${p.servings === 1 ? 'Portion' : 'Portionen'}${onLists.has(p.id) ? ' · <span class="on-list">✓ auf der Einkaufsliste</span>' : ''}</p>
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
  // Offline gesetzte Haken gelten, bis sie gespeichert sind.
  const pending = loadPendingChecks();
  return data.map((i) => (i.id in pending ? { ...i, checked: pending[i.id] } : i));
}

// Häufig gekaufte Artikel einer Liste; ohne haeufig.sql eine leere Liste.
async function loadFrequent(listId) {
  if (!frequentTable) return [];
  const { data, error } = await supabase.from('shopping_frequent').select('*').eq('list_id', listId);
  if (error) {
    if (SQL_MISSING.has(error.code)) frequentTable = false;
    return [];
  }
  return data;
}

// Zählt einen Kauf mit und liefert die neue Liste der häufigen Artikel.
async function countPurchase(listId, item, frequent) {
  if (!frequentTable) return frequent;
  const key = categoryKey(item.name);
  const { error } = await supabase.rpc('count_purchase', {
    p_list: listId, p_key: key, p_name: item.name, p_amount: item.amount ?? null, p_unit: item.unit ?? '',
  });
  if (error) {
    if (SQL_MISSING.has(error.code)) frequentTable = false;
    return frequent;
  }
  const now = new Date().toISOString();
  const old = frequent.find((f) => f.key === key);
  if (old) return frequent.map((f) => (f === old ? { ...f, count: f.count + 1, name: item.name, amount: item.amount, unit: item.unit, last_bought: now } : f));
  return [...frequent, { list_id: listId, key, name: item.name, amount: item.amount, unit: item.unit, count: 1, last_bought: now, hidden: false }];
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
// onOpen bekommt das Formular, z. B. um Eingaben schon beim Tippen zu prüfen.
function openSheet(html, onOpen) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.innerHTML = `<form method="dialog" class="sheet-form">${html}</form>`;
    document.body.append(dialog);
    onOpen?.(dialog.querySelector('form'));
    // Ist das erste Feld eine Auswahlliste, bekommt die Überschrift den Fokus; sonst klappt das
    // Handy die Liste gleich beim Öffnen auf.
    const first = dialog.querySelector('input:not([type=hidden]), select, textarea, button');
    const heading = dialog.querySelector('h2');
    if (first?.tagName === 'SELECT' && heading) { heading.tabIndex = -1; heading.autofocus = true; }
    // Solange ein Dialog offen ist, wird dahinter nicht gescrollt.
    document.documentElement.classList.add('sheet-open');
    dialog.addEventListener('close', () => {
      resolve({ value: dialog.returnValue, form: dialog.querySelector('form') });
      dialog.remove();
      if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
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
    <p class="hint">Das Rezept ist schon eingeplant; hier geht es nur um die Zutaten.</p>
    <div class="row"><button class="btn primary" value="ok">Weiter</button>
      <button class="btn ghost" value="cancel" formnovalidate>Überspringen</button></div>`);
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
    notSaved(err);
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
  let frequent = await loadFrequent(list.id);
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
        ${[['added', 'Hinzugefügt'], ['name', 'A–Z'], ['category', 'Ladenweg'], ['recipe', 'Nach Rezept']].map(([v, l]) => `<option value="${v}"${shoppingSort() === v ? ' selected' : ''}>${l}</option>`).join('')}
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
        <p class="hint">Wer den Einladungslink annimmt und ein Konto hat, kann diese Liste mitbearbeiten. Jeder Link gilt für eine Person.</p>
        <div class="row">
          <button class="btn primary" id="list-invite">Einladungslink teilen</button>
        </div>
        ${members.length ? `<ul class="people">${members.map((p) => `<li><span>${esc(personName(p))}</span>
          <button class="link danger-link" data-member="${p.user_id}">Entfernen</button></li>`).join('')}</ul>` : ''}`
    : `<p class="hint">Geteilt von ${esc(owner ? personName(owner) : 'jemand anderem')}${members.length > 1 ? ` mit ${members.filter((p) => p.user_id !== me).map((p) => esc(personName(p))).join(', ')}` : ''}.</p>
        <div class="row"><button class="btn danger" id="leave-list">Austreten</button></div>`}
      <h3>Einkaufsorte und Zutaten</h3>
      <p class="hint">Welche Orte eine Zutat hat, änderst du, indem du den Eintrag nach rechts wischst. Die Orte selbst verwaltest du unter <a href="#/orte">Verwalten → Orte</a>, alle Zutaten unter <a href="#/zutaten">Verwalten → Zutaten</a>.</p>
    </section>
    <form class="import-row add-item" id="add-item">
      <input name="item" placeholder="z. B. 1 l Milch" autocomplete="off" enterkeyhint="done" aria-label="Eintrag hinzufügen">
      <button class="btn">Hinzufügen</button>
    </form>
    <div id="frequent"></div>
    <div id="list-recipes"></div>
    <ul class="shop-items" id="open-items"></ul>
    <div id="done-items"></div>`;

  const draw = () => {
    const sort = shoppingSort();
    const filter = placeIds().includes(placeFilter()) ? placeFilter() : '';
    const sorted = sortItems(items, sort, filter).filter((i) => !filter || placesOf(i.name).includes(filter));
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
    // Auf dem Ladenweg ohne Ort-Filter steht zusätzlich der Ort darüber, sobald einer beginnt.
    const placeOfItem = (x) => walkOfItem(x, filter).place;
    const rows = (list) => list.map((item, i) => {
      const groupBy = sort === 'category' ? (x) => categoryOf(x.name) : groupOf;
      const group = groupBy(item);
      const newPlace = sort === 'category' && !filter && (i === 0 || placeOfItem(list[i - 1]) !== placeOfItem(item));
      const placeHead = newPlace && places.length > 1 ? `<li class="group-head place-head">${symbol('pin')}${esc(placeName(placeOfItem(item)) ?? '')}</li>` : '';
      const head = (sort === 'recipe' || sort === 'category') && (newPlace || i === 0 || groupBy(list[i - 1]) !== group) ? `<li class="group-head">${esc(group)}</li>` : '';
      return placeHead + head + row(item);
    }).join('');
    $('#open-items').innerHTML = open.length ? rows(open)
      : `<li class="hint empty-list">${done.length ? 'Alles erledigt.' : filter ? `Für ${esc(placeName(filter))} steht nichts auf der Liste.` : 'Die Liste ist leer. Füge oben etwas hinzu oder setze im Plan Rezepte auf die Liste.'}</li>`;
    $('#done-items').innerHTML = done.length ? `<div class="section-head done-head"><h2>Erledigt (${done.length})</h2>
      <button class="link danger-link" id="clear-done">Erledigte löschen</button></div>
      <ul class="shop-items">${rows(done)}</ul>` : '';
    const tips = frequentSuggestions(frequent, items, categoryKey, { keep: (f) => !filter || placesOf(f.name).includes(filter) });
    $('#frequent').innerHTML = tips.length ? `<p class="hint">Häufig gekauft:</p><div class="chips frequent">${tips.map((f) => `<button type="button" class="chip needs-net" data-frequent="${esc(f.key)}" title="Lange drücken: nicht mehr vorschlagen">+ ${esc(f.name)}</button>`).join('')}</div>` : '';
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
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`, requirePlace);
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
        const { error } = await save(supabase.from('shopping_items').update(patch).eq('id', item.id));
        if (error) { notSaved(error); reload(); }
      };
    });
    app.querySelectorAll('[data-check]').forEach((box) => {
      box.onchange = async () => {
        const item = items.find((i) => i.id === box.dataset.check);
        item.checked = box.checked;
        draw();
        const pending = loadPendingChecks();
        const remember = () => { savePendingChecks({ ...loadPendingChecks(), [item.id]: item.checked }); };
        if (!navigator.onLine) { remember(); return; }
        const { error } = await save(supabase.from('shopping_items').update({ checked: item.checked }).eq('id', item.id));
        if (error && isNetworkError(error)) { remember(); toast('Offline gemerkt, wird nachgereicht'); return; }
        if (error) { notSaved(error); item.checked = !item.checked; draw(); }
        else if (item.id in pending) { delete pending[item.id]; savePendingChecks(pending); }
        if (!error && item.checked) frequent = await countPurchase(list.id, item, frequent);
      };
    });
    app.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        items = items.filter((i) => i.id !== b.dataset.del);
        draw();
        const { error } = await save(supabase.from('shopping_items').delete().eq('id', b.dataset.del));
        if (error) { notSaved(error); reload(); }
      };
    });
    app.querySelectorAll('[data-recipe]').forEach((b) => {
      b.onclick = async () => {
        const rec = recs.find((r) => r.recipe_id === b.dataset.recipe);
        if (!confirm(`Alle Zutaten von „${rec.title}“ von der Liste nehmen?`)) return;
        const { updates, deletes } = removeRecipe(items, rec.recipe_id);
        const results = await Promise.all([
          ...updates.map(({ id, ...patch }) => save(supabase.from('shopping_items').update(patch).eq('id', id))),
          deletes.length ? save(supabase.from('shopping_items').delete().in('id', deletes)) : null,
        ].filter(Boolean));
        const failed = results.find((r) => r.error);
        if (failed) notSaved(failed.error); else toast(`„${rec.title}“ von der Liste genommen`);
        await reload();
      };
    });
    const clear = $('#clear-done');
    if (clear) {
      clear.onclick = async () => {
        const ids = done.map((i) => i.id);
        items = items.filter((i) => !i.checked);
        draw();
        const { error } = await save(supabase.from('shopping_items').delete().in('id', ids));
        if (error) { notSaved(error); reload(); }
      };
    }
  };

  // Neu laden, ohne eigene Änderungen zu überschreiben. Früher konnte eine Antwort, die vor
  // dem Speichern abgeschickt wurde, einen gerade hinzugefügten Eintrag oder Haken wieder
  // verschwinden lassen. Jetzt gilt: Solange etwas gespeichert wird, wartet das Laden, und eine
  // Antwort, die älter ist als die letzte eigene Änderung, wird verworfen und neu geholt.
  let edits = 0; // Zähler der eigenen Änderungen
  let saving = 0; // davon gerade unterwegs
  let reloading = null;
  let reloadAgain = false;
  const reload = () => {
    if (reloading || saving) { reloadAgain = true; return reloading ?? Promise.resolve(); }
    const startedAt = edits;
    reloading = loadItems(list.id).then((fresh) => {
      if (edits === startedAt && !saving) { items = fresh; draw(); } else reloadAgain = true;
    }).catch(() => {}).finally(() => {
      reloading = null;
      if (reloadAgain && !saving) { reloadAgain = false; reload(); }
    });
    return reloading;
  };
  // Schickt eine Änderung an die Datenbank und liefert deren Antwort ({ data, error }).
  const save = async (request) => {
    edits += 1;
    saving += 1;
    try {
      return await request;
    } catch (error) {
      return { data: null, error };
    } finally {
      saving -= 1;
      if (!saving && reloadAgain && !reloading) { reloadAgain = false; reload(); }
    }
  };

  $('#item-sort').onchange = (e) => {
    try { localStorage.setItem('kochbuch.listSort', e.target.value); } catch { /* privater Modus */ }
    draw();
  };

  $('#place-filter').onchange = (e) => {
    try { localStorage.setItem('kochbuch.listPlace', e.target.value); } catch { /* privater Modus */ }
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
    const { data, error } = await save(supabase.from('shopping_items').insert({
      list_id: list.id,
      name: (parsed.name || text).slice(0, 200),
      amount: parsed.amountMax ?? parsed.amount,
      unit: parsed.unit,
      manual: true,
    }).select().single());
    if (error) { notSaved(error); if (!input.value) input.value = text; return; }
    if (!items.some((i) => i.id === data.id)) items.push(data);
    rememberCategories([data.name]);
    draw();
    // Gespeichert ist der Eintrag; der Ort-Filter blendet ihn aber vielleicht aus.
    const filter = placeIds().includes(placeFilter()) ? placeFilter() : '';
    if (filter && !placesOf(data.name).includes(filter)) {
      toast(`„${data.name}“ steht auf der Liste, ist aber ausgeblendet: Der Filter zeigt nur ${placeName(filter)}.`);
    }
    input.focus();
  };

  // Häufig gekauft: Tipp setzt den Artikel auf die Liste, langes Drücken blendet ihn aus.
  const box = $('#frequent');
  let pressTimer = null;
  let pressed = false;
  const hideFrequent = async (key) => {
    const f = frequent.find((x) => x.key === key);
    if (!f || !frequentTable) { toast('Ausblenden geht, sobald haeufig.sql ausgeführt ist.'); return; }
    const { value } = await openSheet(`<h2>${esc(f.name)}</h2><p>Nicht mehr unter „Häufig gekauft“ vorschlagen?</p>
      <div class="row"><button class="btn primary" value="ok">Nicht mehr vorschlagen</button><button class="btn ghost" value="cancel">Abbrechen</button></div>`);
    if (value !== 'ok') return;
    const { error } = await supabase.from('shopping_frequent').update({ hidden: true }).eq('list_id', list.id).eq('key', key);
    if (error) { toast(error.message); return; }
    f.hidden = true;
    draw();
  };
  box.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('[data-frequent]');
    if (!chip) return;
    pressed = false;
    pressTimer = setTimeout(() => { pressed = true; hideFrequent(chip.dataset.frequent); }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => box.addEventListener(ev, () => clearTimeout(pressTimer)));
  box.addEventListener('contextmenu', (e) => {
    const chip = e.target.closest('[data-frequent]');
    if (!chip) return;
    e.preventDefault();
    if (!pressed) { clearTimeout(pressTimer); pressed = true; hideFrequent(chip.dataset.frequent); }
  });
  box.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-frequent]');
    if (!chip || pressed) { pressed = false; return; }
    const f = frequentSuggestions(frequent, items, categoryKey, { limit: Infinity }).find((x) => x.key === chip.dataset.frequent);
    if (!f) return;
    chip.disabled = true;
    const { data, error } = await save(supabase.from('shopping_items').insert({
      list_id: list.id, name: f.name, amount: f.amount ?? null, unit: f.unit ?? '', manual: true,
    }).select().single());
    if (error) { notSaved(error); chip.disabled = false; return; }
    if (!items.some((i) => i.id === data.id)) items.push(data);
    draw();
  });

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
  if (byId('#list-invite')) byId('#list-invite').onclick = () => shareInvite({ kind: 'list', list_id: list.id }, list.name);
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

// Wo eine Zutat auf dem Ladenweg liegt; filter = der Ort, nach dem die Liste gefiltert ist.
const walkOfItem = (item, filter) => walkKey(placesOf(item.name), categoryOf(item.name), placeIds(), walkOf, filter);

function sortItems(items, sort, filter = '') {
  const list = [...items];
  if (sort === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
  if (sort === 'category') {
    const keys = new Map(list.map((i) => [i, walkOfItem(i, filter).rank]));
    list.sort((a, b) => keys.get(a)[0] - keys.get(b)[0] || keys.get(a)[1] - keys.get(b)[1] || collator.compare(a.name, b.name));
  }
  if (sort === 'recipe') {
    list.sort((a, b) => (!a.sources?.length - !b.sources?.length)
      || collator.compare(groupOf(a), groupOf(b)) || collator.compare(a.name, b.name));
  }
  return list;
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
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'aborted';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link kopiert');
  } catch {
    prompt('Link zum Kopieren:', url);
  }
  return 'copied';
}

const SQL_MISSING = new Set(['PGRST202', 'PGRST205', '42P01', '42883']);
const inviteProblem = (error) => (SQL_MISSING.has(error.code)
  ? 'Für Einladungen fehlt in Supabase noch supabase/einladungen.sql.' : error.message);

// Legt eine Einladung an (row: kind plus recipe_id oder list_id) und öffnet das Teilen-Menü.
// Jeder Link gilt für eine Person. Wird das Teilen abgebrochen, wird die Einladung gleich
// wieder zurückgezogen, damit kein ungenutzter Link herumliegt.
async function shareInvite(row, title) {
  const { data, error } = await supabase.from('invites').insert(row).select('id, token').single();
  if (error) { toast(inviteProblem(error)); return false; }
  const result = await shareLink(appUrl(`einladung/${data.token}`), title);
  if (result === 'aborted') {
    await supabase.rpc('withdraw_invite', { p_id: data.id });
    return false;
  }
  if (result === 'shared') toast('Der Link gilt für eine Person');
  return true;
}

// Einzeln geteilte Rezepte: was ich verschickt und was ich bekommen habe, mit Namen.
async function loadRecipeShares() {
  const { data, error } = await supabase.rpc('recipe_share_people');
  if (error) throw error;
  return data;
}

// Die Rezepte zu den Freigaben, die ich bekommen habe, markiert mit received und from.
async function loadReceived(received) {
  if (!received.length) return [];
  const { data, error } = await supabase.from('recipes').select('*').in('id', received.map((x) => x.recipe_id));
  if (error) throw error;
  const byId = new Map(received.map((x) => [x.recipe_id, x]));
  return data.map((r) => ({ ...r, received: true, from: byId.get(r.id)?.owner_name ?? 'jemand' }))
    .sort((a, b) => collator.compare(a.title, b.title));
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
      // Ein übernommenes Familiengeheimnis bleibt eines, sonst sähen es die eigenen Leser.
      ...(r.family_secret ? { family_secret: true } : {}),
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

const INVITE_TEXT = {
  cookbook: (i) => ({ title: `Kochbuch von ${i.owner_name}`, text: `Du kannst alle Rezepte von ${i.owner_name} ansehen und in dein Kochbuch übernehmen, aber nichts ändern.` }),
  list: (i) => ({ title: `Einkaufsliste „${i.title ?? 'Einkaufsliste'}“`, text: `Du kannst die Liste zusammen mit ${i.owner_name} bearbeiten. Änderungen sehen alle sofort.` }),
  recipe: (i) => ({ title: `Rezept „${i.title ?? 'Rezept'}“`, text: `${i.owner_name} schickt dir dieses Rezept. Nach dem Annehmen findest du es unter „Teilen“ und kannst es in dein Kochbuch übernehmen.` }),
};

const inviteTarget = (kind, target) => ({ cookbook: `#/kochbuch/${target}`, list: `#/einkauf/${target}`, recipe: `#/erhalten/${target}` }[kind]);

// Die Einladungsseite für Rezepte, Kochbücher und Einkaufslisten. Annehmen braucht ein
// Konto, Ablehnen nicht. Danach ist der Link verbraucht.
async function renderInvite(token) {
  app.innerHTML = '<p class="loading">Lade Einladung …</p>';
  const { data, error } = await supabase.rpc('invite_info', { p_token: token });
  const notice = (text, link = session ? '<a class="btn" href="#/">Zu meinen Rezepten</a>' : '') => {
    app.innerHTML = `<div class="notice"><p>${esc(text)}</p>${link}</div>`;
  };
  if (error) { notice(SQL_MISSING.has(error.code) ? 'Einladungen sind noch nicht eingerichtet (supabase/einladungen.sql fehlt).' : error.message); return; }
  const inv = data?.[0];
  if (!inv) { notice('Diese Einladung gibt es nicht.'); return; }
  const { title, text } = INVITE_TEXT[inv.kind](inv);
  const head = `<div class="invite card-panel">
      <p class="hint">Einladung von ${esc(inv.owner_name)}</p>
      ${inv.image ? `<img class="invite-image" src="${esc(imageUrl(inv.image))}" alt="">` : ''}
      <h1>${esc(title)}</h1>`;
  if (inv.status !== 'offen') {
    app.innerHTML = `${head}<p>${inv.status === 'zurueckgezogen' ? 'Diese Einladung wurde zurückgezogen.' : 'Diese Einladung wurde schon verwendet. Jeder Link gilt nur für eine Person; bitte um einen neuen.'}</p>
      ${session ? '<a class="btn" href="#/">Zu meinen Rezepten</a>' : ''}</div>`;
    return;
  }
  if (inv.own) {
    app.innerHTML = `${head}<p>Das ist deine eigene Einladung. Schick den Link an die Person, die du einladen möchtest. Er gilt für genau eine Person.</p>
      <a class="btn" href="#/geteilt">Zu „Teilen“</a></div>`;
    return;
  }
  if (inv.already) {
    app.innerHTML = `${head}<p>Du hast schon Zugriff. Der Link bleibt für jemand anderen gültig.</p>
      <a class="btn primary" href="${inviteTarget(inv.kind, inv.target_id)}">Öffnen</a></div>`;
    return;
  }
  app.innerHTML = `${head}<p>${esc(text)}</p>
      <div class="row">
        <button class="btn primary" id="accept">${session ? 'Annehmen' : 'Anmelden und annehmen'}</button>
        <button class="btn" id="decline">Ablehnen</button>
      </div>
      <p class="hint">Der Link gilt nur einmal: Nach Annehmen oder Ablehnen ist er verbraucht.</p>
      <p class="hint" id="msg" role="status"></p></div>`;
  const respond = async (accept) => {
    app.querySelectorAll('.invite button').forEach((b) => { b.disabled = true; });
    const { data: res, error: e } = await supabase.rpc('respond_invite', { p_token: token, p_accept: accept });
    if (e) {
      $('#msg').textContent = e.message;
      app.querySelectorAll('.invite button').forEach((b) => { b.disabled = false; });
      return;
    }
    const r = res?.[0];
    if (!accept) { notice('Einladung abgelehnt. Der Link ist damit verbraucht.'); return; }
    cookbookCache.clear();
    toast({ cookbook: 'Einladung angenommen', list: 'Du kannst die Liste jetzt mitbearbeiten', recipe: 'Rezept angenommen' }[r.kind]);
    if (r.kind === 'cookbook') await askShareBack(r.owner_id, inv.owner_name);
    location.replace(inviteTarget(r.kind, r.target_id));
  };
  $('#accept').onclick = () => {
    if (!session) { renderLogin('Melde dich an oder registriere dich, um die Einladung anzunehmen.'); return; }
    respond(true);
  };
  $('#decline').onclick = () => {
    if (confirm('Einladung ablehnen? Der Link ist danach verbraucht.')) respond(false);
  };
}

// Nach einer angenommenen Kochbuch-Einladung: das eigene Kochbuch zurückteilen? Die andere
// Person bekommt das Angebot in ihre Glocke und entscheidet dort.
async function askShareBack(person, name) {
  const { data: possible, error } = await supabase.rpc('share_back_possible', { p_person: person });
  if (error || !possible) return; // zurueckteilen.sql fehlt, oder sie liest mein Kochbuch schon
  const { value } = await openSheet(`<h2>Dein Kochbuch auch mit ${esc(name)} teilen?</h2>
    <p>${esc(name)} bekommt das Angebot in die Glocke und kann es annehmen oder ablehnen. Familiengeheimnisse bleiben verborgen.</p>
    <div class="row"><button class="btn primary" value="ja">Ja, teilen</button>
      <button class="btn ghost" value="nein" formnovalidate>Nein</button></div>`);
  if (value !== 'ja') return;
  const { error: e } = await supabase.rpc('offer_share_back', { p_person: person });
  toast(e ? e.message : `Angebot an ${name} geschickt`);
}

// Ein Rezept, das jemand einzeln mit mir geteilt hat.
async function renderReceived(id) {
  app.innerHTML = '<p class="loading">Lade Rezept …</p>';
  const shares = await loadRecipeShares();
  const share = shares.find((x) => x.recipe_id === id && x.user_id === session.user.id);
  const [r] = share ? await loadReceived([share]) : [];
  if (!r) {
    app.innerHTML = '<div class="notice"><p>Dieses Rezept ist nicht (mehr) mit dir geteilt.</p><a class="btn" href="#/geteilt">Zu „Teilen“</a></div>';
    return;
  }
  showRecipe(r, { own: false, back: '#/geteilt', backLabel: 'Teilen', from: `Von ${r.from} mit dir geteilt` });
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

// ---------- Verwalten und Hilfe ----------

// Sammelseite hinter dem letzten Reiter: von hier geht es zum Teilen, zu Zutaten und Orten und zur Hilfe.
function renderManage() {
  app.innerHTML = `
    <h1>Verwalten</h1>
    <nav class="manage-list">
      <a class="manage-item card-panel" href="#/geteilt">
        <strong>Teilen</strong>
        <small>Kochbuch freigeben, einzeln geteilte Rezepte, Kochbücher anderer und dein Benutzername</small>
      </a>
      <a class="manage-item card-panel" href="#/zutaten">
        <strong>Zutaten</strong>
        <small>Kategorie und Einkaufsorte jeder Zutat ändern und neue Zutaten erfassen</small>
      </a>
      <a class="manage-item card-panel" href="#/orte">
        <strong>Orte</strong>
        <small>Einkaufsorte wie Supermarkt oder Markt anlegen, umbenennen, sortieren und löschen</small>
      </a>
      <a class="manage-item card-panel" href="#/timer">
        <strong>Timer</strong>
        <small>${usePhoneTimer() ? 'Timer laufen in der Uhr-App' : 'Timer laufen in dieser App'}; auf dem iPhone geht auch die Uhr-App</small>
      </a>
      <a class="manage-item card-panel" href="#/hilfe">
        <strong>Hilfe</strong>
        <small>Kurze Anleitungen zu allen Bereichen der App</small>
      </a>
      <button type="button" class="manage-item card-panel" id="news-again">
        <strong>Was ist neu</strong>
        <small>Die Änderungen der letzten Fassungen noch einmal ansehen</small>
      </button>
      <button type="button" class="manage-item card-panel" id="change-password">
        <strong>Passwort ändern</strong>
        <small>Ein neues Passwort für dein Konto festlegen</small>
      </button>
      <button type="button" class="manage-item card-panel" id="logout">
        <strong>Abmelden</strong>
        <small>Angemeldet als ${esc(session.user.email)}</small>
      </button>
    </nav>`;
  $('#news-again').onclick = () => openNewsSheet(NEWS.slice(0, 2));
  $('#change-password').onclick = () => changePassword();
  $('#logout').onclick = async () => {
    await supabase.auth.signOut();
    // Die zwischengespeicherten Daten gehören zu diesem Konto.
    window.caches?.delete('kochbuch-daten').catch(() => {});
  };
}

async function changePassword(hint = '') {
  const { value, form } = await openSheet(`<h2>Passwort ändern</h2>
    ${hint ? `<p class="hint error">${esc(hint)}</p>` : ''}
    <input type="email" name="email" value="${esc(session.user.email ?? '')}" autocomplete="username" hidden>
    <label>Neues Passwort <input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
    <label>Noch einmal <input type="password" name="repeat" autocomplete="new-password" minlength="6" required></label>
    <div class="row"><button class="btn primary" value="ok">Speichern</button><button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`);
  if (value !== 'ok') return;
  if (form.password.value !== form.repeat.value) { changePassword('Die beiden Passwörter sind nicht gleich.'); return; }
  const { error } = await supabase.auth.updateUser({ password: form.password.value });
  if (error) { changePassword(passwordError(error)); return; }
  toast('Passwort geändert');
}

// Einstellung, ob Timer in der App oder über einen Kurzbefehl in der Uhr-App laufen.
function renderTimerSettings() {
  const apple = isApple();
  app.innerHTML = `
    <a class="back" href="#/verwalten">← Verwalten</a>
    <h1>Timer</h1>
    <p class="hint">Ein Tipp auf eine Zeitangabe in einem Schritt startet einen Timer. Normalerweise läuft er in dieser App und klingelt nur, solange sie offen ist. Auf dem iPhone und iPad kann er stattdessen in der Uhr-App laufen; dann klingelt er auch bei gesperrtem Display.</p>
    ${apple ? '' : '<p class="notice">Das geht nur auf dem iPhone und iPad. Android-Handys lassen Webseiten den Timer der Uhr nicht stellen.</p>'}
    <label class="check"><input type="checkbox" id="phone-timer"${usePhoneTimer() ? ' checked' : ''}> Timer der Uhr-App verwenden</label>
    <section class="card-panel timer-howto">
      <h2>Einmal einrichten</h2>
      <p>Die App startet den Timer über einen Kurzbefehl. So legst du ihn an:</p>
      <ol>
        <li>Öffne die App „Kurzbefehle“ und tippe oben rechts auf „+“.</li>
        <li>Tippe oben auf den Namen und nenne den Kurzbefehl genau <strong>${esc(PHONE_SHORTCUT)}</strong>.</li>
        <li>Tippe auf „Aktion hinzufügen“, suche „Timer starten“ und wähle die Aktion aus.</li>
        <li>Tippe in der Aktion auf die Zahl, dann auf „Kurzbefehleingabe“. Stelle die Einheit auf „Sekunden“.</li>
        <li>Tippe auf „Fertig“.</li>
      </ol>
      <p>Beim Starten wechselt das Handy kurz in die App „Kurzbefehle“. Mit „Kochbuch“ oben links oder einem Wisch kommst du zurück. Beim ersten Mal fragt das iPhone, ob der Kurzbefehl laufen darf.</p>
      <button type="button" class="btn" id="phone-timer-test">Mit 10 Sekunden ausprobieren</button>
    </section>`;
  $('#phone-timer').onchange = (e) => {
    setUsePhoneTimer(e.target.checked);
    toast(e.target.checked ? 'Timer laufen jetzt in der Uhr-App.' : 'Timer laufen jetzt in dieser App.');
  };
  $('#phone-timer-test').onclick = () => { location.href = phoneTimerUrl(10); };
}

// Alle Zutaten mit Kategorie und Orten, nach Kategorien gruppiert. Neue Zutaten lassen sich
// hier erfassen, bevor sie in einem Rezept vorkommen.
async function renderIngredients() {
  const [own] = await Promise.all([loadRecipes(), loadCategories()]);
  // Schreibweise aus den eigenen Rezepten, falls eine Zuordnung keinen Namen hat (vor zutaten.sql).
  const fromRecipes = new Map();
  for (const r of own) {
    for (const i of r.ingredients) {
      const key = categoryKey(i.name);
      if (key && !fromRecipes.has(key)) fromRecipes.set(key, ingredientName(i.name));
    }
  }
  const nameOf = (key) => categories.get(key)?.name ?? fromRecipes.get(key) ?? key.charAt(0).toUpperCase() + key.slice(1);
  app.innerHTML = `
    <a class="back" href="#/verwalten">← Verwalten</a>
    <h1>Zutaten</h1>
    <p class="hint">Kategorie und Einkaufsorte gelten für die Zutat in allen Rezepten und Einkaufslisten. Tippe eine Zutat an, um sie zu ändern.</p>
    <form class="import-row" id="add-ingredient">
      <input name="ingredient" placeholder="Neue Zutat, z. B. Kichererbsen" maxlength="100" autocomplete="off" enterkeyhint="done" aria-label="Neue Zutat">
      <button class="btn">Hinzufügen</button>
    </form>
    <input type="search" id="ing-q" placeholder="Zutat suchen" aria-label="Zutaten durchsuchen" autocomplete="off">
    <div id="ing-list"></div>`;
  const draw = () => {
    const q = $('#ing-q').value.trim().toLowerCase();
    const all = [...new Set([...categories.keys(), ...fromRecipes.keys()])]
      .map((key) => ({ key, name: nameOf(key) }))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .sort((a, b) => collator.compare(a.name, b.name));
    const groups = CATEGORIES.map((c) => [c, all.filter((x) => categoryOf(x.name) === c)]).filter(([, list]) => list.length);
    $('#ing-list').innerHTML = groups.length ? groups.map(([c, list]) => `<h2 class="ing-group">${esc(c)}</h2>
      <ul class="people ing-list">${list.map((x) => `<li><button type="button" class="ing-item" data-key="${esc(x.key)}">
        <span>${esc(x.name)}</span><small>${symbol('pin')}${esc(placeLabel(placesOf(x.name)))}</small></button></li>`).join('')}</ul>`).join('')
      : `<p class="hint">${q ? 'Keine Zutat gefunden.' : 'Noch keine Zutaten. Sie kommen beim Speichern von Rezepten dazu, oder du erfasst sie oben.'}</p>`;
    app.querySelectorAll('[data-key]').forEach((b) => {
      b.onclick = async () => {
        const { key } = b.dataset;
        const canDelete = categories.has(key) && !fromRecipes.has(key);
        if (await editIngredient(nameOf(key), { canDelete })) draw();
      };
    });
  };
  $('#ing-q').oninput = draw;
  $('#add-ingredient').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.ingredient;
    const name = ingredientName(input.value.trim());
    const key = categoryKey(name);
    if (!key) return;
    if (!categoriesSaved) { toast('Eigene Zutaten gibt es, sobald kategorien.sql ausgeführt ist.'); return; }
    const known = categories.has(key) || fromRecipes.has(key);
    if (await editIngredient(known ? nameOf(key) : name, { isNew: !known })) {
      input.value = '';
      draw();
    }
  };
  draw();
}

// Eigene Einkaufsorte anlegen, umbenennen, sortieren und löschen. Mindestens ein Ort bleibt.
async function renderPlaces() {
  await loadCategories();
  app.innerHTML = `
    <a class="back" href="#/verwalten">← Verwalten</a>
    <h1>Orte</h1>
    <p class="hint">Wo du einkaufst. Die Orte gelten für alle deine Einkaufslisten; welche Orte eine Zutat hat, stellst du unter <a href="#/zutaten">Zutaten</a> ein. Tippe einen Ort an, um ihn umzubenennen oder zu löschen; mit den Pfeilen änderst du die Reihenfolge, auch im Filter der Einkaufsliste. Unter „Ladenweg“ legst du fest, in welcher Reihenfolge die Abteilungen in diesem Laden liegen.</p>
    <ul class="people place-list" id="place-list"></ul>
    <form class="import-row" id="add-place">
      <input name="place" placeholder="Neuer Ort, z. B. Bäcker" maxlength="40" autocomplete="off" enterkeyhint="done" aria-label="Neuer Ort">
      <button class="btn">Hinzufügen</button>
    </form>`;
  const needPlacesTable = () => {
    if (placesTable) return false;
    toast('Eigene Orte gibt es, sobald orte.sql ausgeführt ist.');
    return true;
  };
  const savePositions = async (list) => {
    const results = await Promise.all(list.map((p) => supabase.from('shopping_places').update({ position: places.indexOf(p) }).eq('id', p.id)));
    const failed = results.find((r) => r.error);
    if (failed) toast(failed.error.message);
  };
  const draw = () => {
    $('#place-list').innerHTML = places.map((p, i) => `<li><button type="button" class="place-name" data-place="${esc(p.id)}">${esc(p.name)}</button><span class="row">
      <a class="btn small" href="#/ladenweg/${encodeURIComponent(p.id)}" aria-label="Ladenweg für ${esc(p.name)}">Ladenweg</a>
      <button type="button" class="btn small" data-up="${i}" aria-label="${esc(p.name)} nach oben"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="btn small" data-down="${i}" aria-label="${esc(p.name)} nach unten"${i === places.length - 1 ? ' disabled' : ''}>↓</button></span></li>`).join('');
    const move = async (i, j) => {
      if (needPlacesTable()) return;
      [places[i], places[j]] = [places[j], places[i]];
      draw();
      await savePositions(places);
    };
    app.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => move(Number(b.dataset.up), Number(b.dataset.up) - 1); });
    app.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => move(Number(b.dataset.down), Number(b.dataset.down) + 1); });
    // Tipp auf einen Ort: umbenennen oder löschen (der letzte Ort bleibt).
    app.querySelectorAll('[data-place]').forEach((b) => {
      b.onclick = async () => {
        if (needPlacesTable()) return;
        const place = places.find((p) => p.id === b.dataset.place);
        const { value, form } = await openSheet(`<h2>${esc(place.name)}</h2>
          <label>Name <input name="name" value="${esc(place.name)}" maxlength="40" required autocomplete="off" enterkeyhint="done"></label>
          ${places.length > 1 ? '<p class="hint">Löschst du den Ort, verschwindet er bei allen Zutaten. Hatte eine Zutat nur diesen Ort, bekommt sie wieder einen vorgeschlagenen.</p>' : '<p class="hint">Der letzte Ort lässt sich nicht löschen.</p>'}
          <div class="row"><button class="btn primary" value="ok">Speichern</button>
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button>
            ${places.length > 1 ? '<button class="btn danger" value="delete" formnovalidate>Löschen</button>' : ''}</div>`);
        if (value === 'delete') {
          const { error } = await supabase.from('shopping_places').delete().eq('id', place.id);
          if (error) { toast(error.message); return; }
          places = places.filter((p) => p !== place);
          draw();
          return;
        }
        const name = value === 'ok' ? form.name.value.trim().slice(0, 40) : '';
        if (!name || name === place.name) return;
        if (places.some((p) => p !== place && p.name.toLowerCase() === name.toLowerCase())) { toast('Diesen Ort gibt es schon.'); return; }
        const { error } = await supabase.from('shopping_places').update({ name }).eq('id', place.id);
        if (error) { toast(error.message); return; }
        place.name = name;
        draw();
      };
    });
  };
  draw();
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
    draw();
  };
}

// Ladenweg eines Orts: die Kategorien in der Reihenfolge, in der man durch den Laden geht.
async function renderWalk(placeId) {
  await loadCategories();
  const place = places.find((p) => p.id === placeId);
  if (!place) { location.hash = '#/orte'; return; }
  let order = walkOf(place.id);
  app.innerHTML = `
    <a class="back" href="#/orte">← Orte</a>
    <h1>Ladenweg: ${esc(place.name)}</h1>
    <p class="hint">Bring die Abteilungen in die Reihenfolge, in der du durch ${esc(place.name)} gehst. Was es dort nicht gibt, schiebst du nach unten. Auf der Einkaufsliste sortiert „Ladenweg“ danach.</p>
    ${walkColumn ? '' : '<p class="notice">Damit der Ladenweg gespeichert wird, muss in Supabase noch supabase/ladenweg.sql ausgeführt werden.</p>'}
    <ol class="people place-list walk-list" id="walk-list"></ol>
    <div class="row"><button type="button" class="btn ghost" id="walk-reset">Zurücksetzen</button></div>`;
  const save = async () => {
    if (!walkColumn) { toast('Dafür fehlt noch ladenweg.sql.'); return false; }
    const custom = order.join() === CATEGORIES.join() ? null : order;
    const { error } = await supabase.from('shopping_places').update({ category_order: custom }).eq('id', place.id);
    if (error) { toast(error.message); return false; }
    place.order = custom;
    return true;
  };
  const draw = () => {
    $('#walk-list').innerHTML = order.map((c, i) => `<li><span>${esc(c)}</span><span class="row">
      <button type="button" class="btn small" data-up="${i}" aria-label="${esc(c)} nach oben"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="btn small" data-down="${i}" aria-label="${esc(c)} nach unten"${i === order.length - 1 ? ' disabled' : ''}>↓</button></span></li>`).join('');
    $('#walk-reset').disabled = order.join() === CATEGORIES.join();
  };
  const move = async (i, j) => {
    const before = order;
    order = [...order];
    [order[i], order[j]] = [order[j], order[i]];
    draw();
    if (!await save()) { order = before; draw(); }
    // Der Knopf bleibt unter dem Finger, damit man mehrmals hintereinander tippen kann.
    app.querySelector(`[data-${j < i ? 'up' : 'down'}="${j}"]`)?.focus();
  };
  $('#walk-list').onclick = (e) => {
    const b = e.target.closest('[data-up], [data-down]');
    if (!b) return;
    const i = Number(b.dataset.up ?? b.dataset.down);
    move(i, b.dataset.up != null ? i - 1 : i + 1);
  };
  $('#walk-reset').onclick = async () => {
    const before = order;
    order = [...CATEGORIES];
    draw();
    if (!await save()) { order = before; draw(); }
  };
  draw();
}

const helpLines = (topic) => `<ul class="help-lines">${topic.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;

function renderHelp(id) {
  const open = helpTopic(id);
  app.innerHTML = `
    <a class="back" href="#/verwalten">← Verwalten</a>
    <h1>Hilfe</h1>
    <p class="hint">Tippe ein Thema an. Auf jeder Seite der App führt das Fragezeichen oben rechts direkt zum passenden Thema.</p>
    ${HELP.map((t) => `<details class="help-topic card-panel" id="hilfe-${t.id}"${t === open ? ' open' : ''}>
      <summary>${esc(t.title)}</summary>
      ${helpLines(t)}</details>`).join('')}`;
  if (open) $(`#hilfe-${open.id}`).scrollIntoView({ block: 'start' });
}

// Der Hilfe-Knopf oben rechts: zeigt den Abschnitt zur aktuellen Seite.
async function openHelpSheet(topic) {
  const { value } = await openSheet(`<h2>${esc(topic.title)}</h2>
    ${helpLines(topic)}
    <div class="row"><button class="btn primary" value="ok">Verstanden</button>
      <button class="btn ghost" value="alle" formnovalidate>Ganze Hilfe</button></div>`);
  if (value === 'alle') location.hash = `#/hilfe/${topic.id}`;
}

const NEWS_KEY = 'kochbuch.news';

// Beim ersten Start nach einem Update: zeigt, was dazugekommen ist. Die gesehene Fassung
// liegt im Browser, also pro Gerät — am Handy kommt das Blatt noch einmal.
function showNewsIfUpdated() {
  let seen = null;
  try { seen = localStorage.getItem(NEWS_KEY); } catch { return; }
  const neu = newsSince(seen);
  try { localStorage.setItem(NEWS_KEY, latestVersion()); } catch { /* privater Modus */ }
  if (neu.length) openNewsSheet(neu);
}

async function openNewsSheet(entries) {
  // Jede Zeile kann einen Knopf haben, der das Blatt schließt und zur passenden Stelle führt;
  // der Wert des Knopfs ist die Adresse.
  const { value } = await openSheet(`<h2>Was ist neu</h2>
    ${entries.map((e) => `<section class="news-entry">
      <h3>${esc(e.title)}</h3>
      <ul class="help-lines">${e.lines.map((l) => `<li>${esc(l.text)}
        ${l.ziel ? `<button class="btn small ghost" value="${esc(l.ziel)}" formnovalidate>Ansehen</button>` : ''}</li>`).join('')}</ul>
    </section>`).join('')}
    <div class="row"><button class="btn primary" value="ok">Alles klar</button></div>`);
  if (value.startsWith('#/')) location.hash = value;
}

async function renderSharing() {
  app.innerHTML = `<p class="loading">Lade …</p>`;
  const me = session.user.id;
  const [own, people, shares, invites, lists, invitees] = await Promise.all([
    loadRecipes(),
    loadPeople(),
    loadRecipeShares().catch(() => null),
    supabase.from('invites').select('*').eq('owner_id', me).eq('status', 'offen').order('created_at'),
    supabase.from('shopping_lists').select('id, name').eq('owner_id', me),
    supabase.rpc('invitee_names'),
  ]);
  const ready = shares !== null && !invites.error; // false, solange einladungen.sql fehlt
  const received = await loadReceived((shares ?? []).filter((x) => x.user_id === me));
  // Verschickte Rezepte: je Rezept die Personen, die es angenommen haben.
  const given = new Map();
  (shares ?? []).filter((x) => x.owner_id === me).forEach((x) => {
    if (!given.has(x.recipe_id)) given.set(x.recipe_id, []);
    given.get(x.recipe_id).push(x);
  });
  const titleOf = (id) => own.find((r) => r.id === id)?.title ?? 'Gelöschtes Rezept';
  const listName = (id) => (lists.data ?? []).find((l) => l.id === id)?.name ?? 'Einkaufsliste';
  const inviteeName = (i) => (invitees.data ?? []).find((x) => x.invite_id === i.id)?.name ?? 'jemanden';
  const inviteLabel = (i) => ({ cookbook: i.invitee_id ? `Mein Kochbuch an ${inviteeName(i)}` : 'Mein Kochbuch', recipe: `Rezept „${titleOf(i.recipe_id)}“`, list: `Einkaufsliste „${listName(i.list_id)}“` }[i.kind]);
  const open = invites.data ?? [];
  const { readers, owners } = people;

  app.innerHTML = `
    <a class="back" href="#/verwalten">← Verwalten</a>
    <h1>Teilen</h1>
    ${myName ? `<section class="card-panel share-section">
      <h2>Dein Benutzername</h2>
      <div class="row"><strong>${esc(myName)}</strong><button class="btn small" id="rename-me">Ändern</button></div>
      <p class="hint">Diesen Namen sehen andere, wenn du etwas mit ihnen teilst.</p>
    </section>` : ''}
    <section class="card-panel share-section">
      <h2>Mit mir geteilte Kochbücher</h2>
      ${owners.length ? `<ul class="people">${owners.map((o) => `<li class="${o.hidden ? 'book-hidden' : ''}">
          <a href="#/kochbuch/${o.owner_id}">Kochbuch von ${esc(ownerName(o))}</a>
          ${'hidden' in o ? `<button class="icon-btn eye" data-eye="${o.owner_id}" aria-pressed="${!o.hidden}"
            aria-label="${o.hidden ? 'Wieder einblenden' : 'Ausblenden'}" title="${o.hidden ? 'Ausgeblendet: tippen zum Einblenden' : 'Eingeblendet: tippen zum Ausblenden'}">${o.hidden ? EYE_OFF : EYE}</button>` : ''}
          <button class="link danger-link" data-leave="${o.owner_id}">Verlassen</button>
        </li>`).join('')}</ul>
        ${owners.some((o) => o.hidden) ? '<p class="hint">Ausgeblendete Kochbücher erscheinen nicht bei „Was kochen?“, in der Saison und beim Kombinieren. Öffnen kannst du sie hier weiterhin.</p>' : ''}`
        : '<p class="hint">Noch keine. Wenn dir jemand einen Einladungslink schickt, erscheint sein Kochbuch hier.</p>'}
    </section>

    ${ready ? `<section class="card-panel share-section">
      <h2>Mit mir geteilte Rezepte</h2>
      ${received.length ? `<ul class="people">${received.map((r) => `<li>
          <a href="#/erhalten/${r.id}">${esc(r.title)} <small class="hint">von ${esc(r.from)}</small></a>
          <button class="link danger-link" data-drop="${r.id}">Entfernen</button>
        </li>`).join('')}</ul>`
        : '<p class="hint">Noch keine. Wenn dir jemand ein Rezept schickt und du annimmst, steht es hier.</p>'}
    </section>` : ''}

    <section class="card-panel share-section">
      <h2>Mein Kochbuch freigeben</h2>
      <p class="hint">Wer die Einladung annimmt und ein Konto hat, kann alle deine Rezepte ansehen und übernehmen, aber nichts ändern. Familiengeheimnisse sieht niemand.</p>
      <div class="row"><button class="btn primary" id="invite-share">Einladungslink teilen</button></div>
      <p class="hint">Jeder Link gilt für eine Person. Für mehrere Leute teilst du einfach mehrmals.</p>
      <h3>Lesezugriff haben</h3>
      ${readers.length ? `<ul class="people">${readers.map((p) => `<li>
          <span>${esc(readerName(p))}</span>
          <button class="link danger-link" data-remove="${p.reader_id}">Entfernen</button>
        </li>`).join('')}</ul>` : '<p class="hint">Noch niemand.</p>'}
    </section>

    <section class="card-panel share-section">
      <h2>Einzeln geteilte Rezepte</h2>
      ${given.size ? `<ul class="people">${[...given].map(([id, people]) => `<li class="given">
          <a href="#/r/${id}">${esc(titleOf(id))}</a>
          <ul class="given-people">${people.map((x) => `<li><span>${esc(x.user_name)}</span>
            <button class="link danger-link" data-unshare="${id}" data-user="${x.user_id}">Entfernen</button></li>`).join('')}</ul>
        </li>`).join('')}</ul>`
        : '<p class="hint">Öffne ein Rezept und tippe auf „Teilen“, um es an eine Person zu schicken.</p>'}
    </section>

    ${open.length ? `<section class="card-panel share-section">
      <h2>Offene Einladungen</h2>
      <p class="hint">Verschickt, aber noch nicht beantwortet. Sobald jemand annimmt oder ablehnt, verschwindet der Link hier.</p>
      <ul class="people">${open.map((i) => `<li>
          <span>${esc(inviteLabel(i))} <small class="hint">${esc(new Date(i.created_at).toLocaleDateString('de-DE'))}</small></span>
          <span class="row-actions">${i.token ? `<button class="link" data-resend="${i.id}">Link teilen</button>` : ''}
          <button class="link danger-link" data-withdraw="${i.id}">Zurückziehen</button></span>
        </li>`).join('')}</ul>
    </section>` : ''}`;

  const byId = (id) => app.querySelector(id);
  if (byId('#rename-me')) {
    byId('#rename-me').onclick = async () => {
      let problem = '';
      for (;;) {
        const { value, form } = await openSheet(`<h2>Benutzername ändern</h2>
          <label>Benutzername <input name="username" required minlength="3" maxlength="30" value="${esc(myName)}" autocapitalize="off"></label>
          <p class="hint name-check">${esc(problem || USERNAME_HINT)}</p>
          <div class="row"><button class="btn primary" value="ok">Speichern</button>
            <button class="btn ghost" value="cancel" formnovalidate>Abbrechen</button></div>`, (sheet) => {
          watchUsername(sheet.querySelector('[name=username]'), sheet.querySelector('.name-check'), myName);
        });
        if (value !== 'ok') return;
        problem = await saveMyName(form.username.value);
        if (!problem) break;
      }
      toast('Benutzername gespeichert');
      renderSharing();
    };
  }
  byId('#invite-share').onclick = async () => {
    if (await shareInvite({ kind: 'cookbook' }, 'Mein Kochbuch')) renderSharing();
  };
  app.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Lesezugriff entfernen?')) return;
      const { error } = await supabase.from('cookbook_readers').delete()
        .eq('owner_id', session.user.id).eq('reader_id', b.dataset.remove);
      if (error) toast(error.message); else renderSharing();
    };
  });
  app.querySelectorAll('[data-eye]').forEach((b) => {
    b.onclick = async () => {
      const owner = owners.find((o) => o.owner_id === b.dataset.eye);
      const { error } = await supabase.rpc('set_cookbook_hidden', { p_owner: owner.owner_id, p_hidden: !owner.hidden });
      if (error) { toast(error.message); return; }
      toast(owner.hidden ? 'Wieder eingeblendet' : 'Ausgeblendet');
      renderSharing();
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
  app.querySelectorAll('[data-drop]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Dieses Rezept aus „Mit mir geteilt“ entfernen? Du brauchst dann eine neue Einladung.')) return;
      const { error } = await supabase.from('recipe_shares').delete().eq('recipe_id', b.dataset.drop).eq('user_id', me);
      if (error) toast(error.message); else renderSharing();
    };
  });
  app.querySelectorAll('[data-unshare]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Diese Person kann das Rezept danach nicht mehr sehen. Entfernen?')) return;
      const { error } = await supabase.from('recipe_shares').delete().eq('recipe_id', b.dataset.unshare).eq('user_id', b.dataset.user);
      if (error) toast(error.message); else renderSharing();
    };
  });
  app.querySelectorAll('[data-resend]').forEach((b) => {
    const i = open.find((x) => x.id === b.dataset.resend);
    b.onclick = () => shareLink(appUrl(`einladung/${i.token}`), inviteLabel(i));
  });
  app.querySelectorAll('[data-withdraw]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Einladung zurückziehen? Der Link funktioniert danach nicht mehr.')) return;
      const { error } = await supabase.rpc('withdraw_invite', { p_id: b.dataset.withdraw });
      if (error) toast(error.message); else renderSharing();
    };
  });
}

const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

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
  // Zutaten erkannt, Schritte nicht: das sagen, statt still eine leere Zubereitung zu zeigen.
  if (data.steps_missing) {
    return 'Die Zutaten sind übernommen, aber die Zubereitungsschritte konnte die KI nicht erkennen (oft, wenn im Video nur gekocht und nichts erklärt wird). Bitte die Schritte selbst ergänzen oder den Import später noch einmal versuchen.';
  }
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
  return `Im Video wurde kein Rezept gefunden${data.ai_error ? ` (${data.ai_error})` : ''}. Titel, Bild und Link sind übernommen, den Rest bitte selbst ergänzen.`;
}

// Fehlermeldung der Edge Function: der Text steht im Body, nicht in error.message.
async function invokeDetail(error) {
  let detail = error.message;
  const status = error.context?.status;
  try { detail = (await error.context.json()).error || detail; } catch { /* keine JSON-Antwort */ }
  if (status === 404) return 'Die Import-Funktion ist in Supabase noch nicht eingerichtet (siehe README).';
  return detail;
}

function nutritionMessage(data) {
  const missing = data?.missing ?? [];
  const ohne = missing.length ? ` Für diese Zutaten gab es keine Nährwerte, sie fehlen in der Summe: ${missing.join(', ')}.` : '';
  if (!data?.nutrition) return `Für keine Zutat wurden Nährwerte gefunden.${ohne} Bitte die Werte selbst eintragen.`;
  return `Aus ${data.counted} von ${data.ingredients} Zutaten geschätzt, pro Portion. Prüfe die Werte.${ohne}`;
}

// Nährwerte aus den Zutaten: die Edge Function fragt Gemini nach den Werten jeder Zutat und
// summiert sie. Steht auch beim Bearbeiten eines bestehenden Rezepts zur Verfügung.
function setupNutritionCalc(form, setNutrition) {
  const btn = $('#nutrition-btn');
  const msg = $('#nutrition-msg');
  if (!btn) return;
  btn.onclick = async () => {
    const ingredients = form.ingredients.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!ingredients.length) { msg.textContent = 'Trage zuerst die Zutaten ein.'; return; }
    btn.disabled = true;
    btn.textContent = 'Ermittle …';
    msg.textContent = 'Die Zutaten werden ausgewertet, das dauert einen Moment.';
    try {
      const body = { nutrition: { ingredients, servings: Math.max(1, Number(form.servings.value) || 1) } };
      const { data, error } = await supabase.functions.invoke('import-recipe', { body });
      if (error) throw new Error(await invokeDetail(error));
      if (data?.error) throw new Error(data.error);
      if (data?.nutrition) setNutrition(data.nutrition);
      msg.textContent = nutritionMessage(data);
    } catch (err) {
      msg.textContent = `Das hat nicht geklappt: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Nährwerte ermitteln';
    }
  };
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
    if (error) throw new Error(await invokeDetail(error));
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
drawTimers();

if (isConfigured) {
  supabase.auth.onAuthStateChange((event, newSession) => {
    if (event === 'INITIAL_SESSION') return; // wird unten per getSession behandelt
    const userChanged = newSession?.user?.id !== session?.user?.id;
    session = newSession;
    if (event === 'PASSWORD_RECOVERY') recoveringPassword = true;
    if (userChanged) { recipes = null; myName = undefined; categories = null; places = null; notes = null; notesFor = null; cookbookCache.clear(); }
    // Nur bei echten Wechseln neu zeichnen, nicht beim stillen Token-Refresh.
    if (userChanged || event === 'PASSWORD_RECOVERY' || event === 'SIGNED_OUT') setTimeout(render);
  });
  // Rückkehr aus einer Mail (Bestätigung oder Passwort): ?code=… oder ein Fehler in der Adresse.
  const back = new URLSearchParams(location.search + '&' + location.hash.replace(/^#\/?/, ''));
  const fromMail = back.has('code') || back.has('error_description');
  const { data } = await supabase.auth.getSession().catch(() => ({ data: {} }));
  session = data.session ?? null;
  if (fromMail) {
    if (session) mailNotice = '';
    else if (back.has('error_description')) mailNotice = 'Der Link aus der Mail ist abgelaufen oder wurde schon benutzt. Zum Zurücksetzen des Passworts tippe auf „Passwort vergessen?“ und gib den Code aus der neuen Mail ein.';
    // Der Link wurde in einem anderen Browser geöffnet als dem, in dem die Mail angefordert wurde.
    // Eine Bestätigung der E-Mail-Adresse hat trotzdem geklappt, ein Passwort-Link nicht.
    else mailNotice = 'Falls du gerade deine E-Mail-Adresse bestätigt hast: Melde dich jetzt an. Wolltest du dein Passwort zurücksetzen, tippe auf „Passwort vergessen?“ und gib den Code aus der Mail hier ein; der Link funktioniert nur im selben Browser.';
    history.replaceState(null, '', location.pathname + (back.has('error_description') ? '' : location.hash));
  }
  // Ohne Netz kann die Anmeldung nicht erneuert werden; die gespeicherte reicht dann, um die
  // zwischengespeicherten Daten zu zeigen.
  if (!session && !navigator.onLine) session = storedSession();
  if (navigator.onLine) flushPendingChecks();
}

function storedSession() {
  try {
    const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k));
    const saved = key && JSON.parse(localStorage.getItem(key));
    return saved?.user?.id ? saved : null;
  } catch { return null; }
}
render();

if (isConfigured && session) showNewsIfUpdated();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
