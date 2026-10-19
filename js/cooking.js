// Beim Kochen: Zeitangaben in Schritten finden (für Timer), Haken auf Zutaten und Schritten
// merken, laufende Timer verwalten und die Mengen der Zutaten in die Schritte setzen.
// Alles hier bleibt auf dem Gerät.

import { nameWords } from './pantry.js';
import { splitNote } from './ingredients.js';

const WORD_NUMBERS = {
  ein: 1, eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8,
  neun: 9, zehn: 10, elf: 11, zwölf: 12, fünfzehn: 15, zwanzig: 20, dreißig: 30, vierzig: 40, sechzig: 60,
  anderthalb: 1.5, eineinhalb: 1.5, zweieinhalb: 2.5, halbe: 0.5, halben: 0.5,
};
const UNIT_SECONDS = [
  [/^(?:stunden?|std\.?|h)$/i, 3600],
  [/^(?:minuten?|min\.?)$/i, 60],
  [/^(?:sekunden?|sek\.?|s)$/i, 1],
];

const NUM = String.raw`\d+(?:[.,]\d+)?|½|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|')}`;
const UNIT = String.raw`Stunden?|Std\.?|Minuten?|Min\.?|Sekunden?|Sek\.?|h|s`;
// Eine Angabe ist "Zahl [bis Zahl] Einheit", z. B. "20 Minuten", "10–15 Min.", "eine halbe Stunde".
const PART = String.raw`(?:(?:eine?\s+)?(${NUM})(?:\s*(?:-|–|bis)\s*(${NUM}))?\s*(${UNIT}))`;
// Zwei Teile hintereinander zählen zusammen: "1 Stunde 20 Minuten", "1 Std. und 20 Min."
const DURATION_RE = new RegExp(String.raw`(?<![\p{L}\d])${PART}(?:\s*(?:und\s+)?${PART})?(?![\p{L}])`, 'giu');

function numberOf(word) {
  if (word == null) return null;
  if (word === '½') return 0.5;
  const w = word.toLowerCase();
  if (w in WORD_NUMBERS) return WORD_NUMBERS[w];
  const n = Number(w.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function unitSeconds(unit) {
  for (const [re, s] of UNIT_SECONDS) if (re.test(unit)) return s;
  return null;
}

// Alle Zeitangaben in einem Text: [{ start, end, seconds, max }]. Bei einer Spanne ist
// seconds der kleinere Wert (dann schaut man rechtzeitig nach), max der größere.
export function findDurations(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(DURATION_RE)) {
    let seconds = 0;
    let max = 0;
    let ok = true;
    for (const [from, to, unit] of [[m[1], m[2], m[3]], [m[4], m[5], m[6]]]) {
      if (!unit) continue;
      const a = numberOf(from);
      const b = to == null ? a : numberOf(to);
      const s = unitSeconds(unit);
      if (a == null || b == null || !s) { ok = false; break; }
      seconds += Math.min(a, b) * s;
      max += Math.max(a, b) * s;
    }
    // Einzelne Buchstaben als Einheit ("5 s", "2 h") nur hinter Ziffern, damit "eine h…" nicht zählt.
    if (/^(?:h|s)$/i.test(m[3]) && !/^\d/.test(m[1])) ok = false;
    if (!ok || seconds <= 0 || seconds > 48 * 3600) continue;
    found.push({ start: m.index, end: m.index + m[0].length, seconds: Math.round(seconds), max: Math.round(max), text: m[0] });
  }
  return found;
}

// Zerlegt einen Schritt in Textstücke und Zeitangaben, damit diese antippbar werden.
export function durationParts(text) {
  const parts = [];
  let at = 0;
  for (const d of findDurations(text)) {
    if (d.start > at) parts.push({ text: text.slice(at, d.start) });
    parts.push({ text: d.text, seconds: d.seconds });
    at = d.end;
  }
  if (at < String(text ?? '').length) parts.push({ text: String(text).slice(at) });
  return parts;
}

// "1:05:00", "12:30", "0:45"
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------- Haken ----------

// Nach so langer Zeit ohne neuen Haken beginnt ein Rezept wieder leer.
export const CHECKS_EXPIRE = 12 * 3600 * 1000;

// all: { [rezeptId]: { at, ing: [Index], steps: [Index] } }
export function checksFor(all, id, now = Date.now()) {
  const c = all?.[id];
  if (!c || now - c.at > CHECKS_EXPIRE) return { ing: [], steps: [] };
  return { ing: Array.isArray(c.ing) ? c.ing : [], steps: Array.isArray(c.steps) ? c.steps : [] };
}

// Schaltet einen Haken um und räumt abgelaufene Rezepte weg. kind: 'ing' oder 'steps'.
export function toggleCheck(all, id, kind, index, now = Date.now()) {
  const next = {};
  for (const [k, v] of Object.entries(all ?? {})) if (now - v.at <= CHECKS_EXPIRE) next[k] = v;
  const current = checksFor(next, id, now);
  const list = new Set(current[kind]);
  if (list.has(index)) list.delete(index); else list.add(index);
  next[id] = { ...current, [kind]: [...list].sort((a, b) => a - b), at: now };
  if (!next[id].ing.length && !next[id].steps.length) delete next[id];
  return next;
}

export function clearChecks(all, id) {
  const next = { ...(all ?? {}) };
  delete next[id];
  return next;
}

// ---------- Timer ----------
// Ein Timer ist { id, label, seconds, end } während er läuft, und { id, label, seconds, left }
// solange er angehalten ist (end ist dann null). Gespeichert wird die Endzeit, damit er auch
// weiterläuft, wenn die App geschlossen ist.

export function startTimer(timers, { label, seconds }, now = Date.now()) {
  const id = `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return [...timers, { id, label, seconds, end: now + seconds * 1000, left: null }];
}

export const timerLeft = (t, now = Date.now()) => (t.end == null ? t.left : Math.max(0, t.end - now));
export const timerDone = (t, now = Date.now()) => t.end != null && t.end <= now;

export function pauseTimer(timers, id, now = Date.now()) {
  return timers.map((t) => (t.id === id && t.end != null && !timerDone(t, now) ? { ...t, left: t.end - now, end: null } : t));
}

export function resumeTimer(timers, id, now = Date.now()) {
  return timers.map((t) => (t.id === id && t.end == null ? { ...t, end: now + t.left, left: null } : t));
}

export const removeTimer = (timers, id) => timers.filter((t) => t.id !== id);

// ---------- Zutatenmengen in den Schritten ----------

// Zwei Wörter (schon normalisiert) gehören zur selben Zutat: "mehl" passt auf "mehl" und
// "weizenmehl", "ol" auf "olivenol"; kurze Wörter nur genau, damit "ei" nicht in "brei" steckt.
const sameWord = (word, head) => word === head
  // Gebeugte Formen: "Zuckers" wird zu "zucker", "Zucker" zu "zuck".
  || (word.startsWith(head) && word.length - head.length <= 2 && head.length >= 3)
  || (head.startsWith(word) && head.length - word.length <= 2 && word.length >= 3)
  || (head.length >= 4 && word.endsWith(head))
  || (word.length >= 4 && head.endsWith(word))
  || (head === 'ol' && word.endsWith('ol'));

// Anteile, die vor einer Zutat stehen können: "die Hälfte des Mehls", "ein Drittel der
// Butter", "1/3 der Milch", "die restliche Sahne", "den Rest des Zuckers". Geprüft wird das
// Stück Text direkt vor dem Wort, bis zum letzten Komma, Punkt oder "und".
const ART = String.raw`(?:des|der|vom|von\s+der|von\s+den|von|dem)?\s*(?:[\p{L}-]+\s+)?`;
const SHARES = [
  [new RegExp(String.raw`(?:zwei|2)\s*drittel\s+${ART}$`, 'iu'), 2 / 3],
  [new RegExp(String.raw`(?:drei|3)\s*viertel\s+${ART}$`, 'iu'), 3 / 4],
  [new RegExp(String.raw`h(?:ä|ae)lfte\s+${ART}$`, 'iu'), 1 / 2],
  [new RegExp(String.raw`drittel\s+${ART}$`, 'iu'), 1 / 3],
  [new RegExp(String.raw`viertel\s+${ART}$`, 'iu'), 1 / 4],
  [new RegExp(String.raw`(?<![\d/])(\d+)\s*\/\s*(\d+)\s+${ART}$`, 'iu'), 'fraction'],
  [new RegExp(String.raw`(?:rest\s+${ART}|(?:restliche|übrige|verbliebene)[nrs]?\s+(?:[\p{L}-]+\s+)?)$`, 'iu'), 'rest'],
  [/(?:etwas|wenig|ein\s+bisschen|ein\s+paar|einige[nrs]?)\s+(?:[\p{L}-]+\s+)?$/iu, 'some'],
];

function shareBefore(text) {
  const clause = text.split(/[.,;:!?()]|\s(?:und|sowie|mit|oder)\s/iu).pop();
  for (const [re, share] of SHARES) {
    const m = clause.match(re);
    if (!m) continue;
    if (share === 'fraction') {
      const v = Number(m[1]) / Number(m[2]);
      return v > 0 && v < 1 ? v : null;
    }
    return share;
  }
  return null;
}

// Wörter, die in Schritten oft stehen und nach dem Kürzen wie eine Zutat aussehen ("ein" → "ei").
const NOT_INGREDIENTS = new Set(['ein', 'eine', 'einen', 'einem', 'einer', 'eines']);

const headWord = (name) => {
  const parts = nameWords(splitNote(name).name.split(',')[0]);
  return parts.length ? parts[parts.length - 1] : null;
};

// Wo in welchem Schritt welche Menge dazugehört. Ergebnis: je Schritt eine Liste
// { at, ing, share } — at ist die Stelle hinter dem Wort, ing der Index der Zutat und share
// der Anteil ihrer Menge (1 = alles). Regeln: ein Anteil vor dem Wort gilt immer; "Rest"
// bekommt, was frühere Schritte übrig gelassen haben; ohne Anteil steht die Menge nur beim
// ersten Mal, damit es nicht so aussieht, als bräuchte man die Zutat doppelt.
export function stepAmounts(stepTexts, ingredients) {
  const heads = ingredients.map((ing) => (ing.amount != null ? headWord(ing.name ?? '') : null));
  const used = ingredients.map(() => 0);
  const seen = ingredients.map(() => false);
  return stepTexts.map((text) => {
    const out = [];
    const taken = new Set();
    for (const m of String(text ?? '').matchAll(/[\p{L}]+/gu)) {
      if (NOT_INGREDIENTS.has(m[0].toLowerCase())) continue;
      const [word] = nameWords(m[0]);
      if (!word) continue;
      // Genauer Treffer vor ungefährem: "Zucker" vor "Puderzucker".
      let i = heads.findIndex((h, k) => h && h === word && !taken.has(k));
      if (i === -1) i = heads.findIndex((h, k) => h && (word.startsWith(h) || h.startsWith(word)) && sameWord(word, h) && !taken.has(k));
      if (i === -1) i = heads.findIndex((h, k) => h && sameWord(word, h) && !taken.has(k));
      if (i === -1) continue;
      taken.add(i);
      const share = shareBefore(text.slice(0, m.index));
      let part = null;
      if (typeof share === 'number') { part = share; used[i] += share; } else if (share === 'rest') {
        if (used[i] > 0 && used[i] < 0.999) part = 1 - used[i];
        used[i] = 1;
      } else if (share === null && !seen[i] && used[i] === 0) { part = 1; used[i] = 1; }
      seen[i] = true;
      if (part != null) out.push({ at: m.index + m[0].length, ing: i, share: Math.round(part * 1000) / 1000 });
    }
    return out;
  });
}

// Schritttext in Stücke für die Anzeige: Text, Zeitangaben (mit seconds) und Mengen (mit
// amount = { ing, share }), in der Reihenfolge, in der sie im Text stehen.
export function stepPieces(text, amounts = []) {
  const pieces = [];
  const inserts = [...amounts].sort((a, b) => a.at - b.at);
  let k = 0;
  const flushUntil = (end, part) => {
    let at = part.start;
    while (k < inserts.length && inserts[k].at <= end) {
      const ins = inserts[k];
      if (ins.at > at) pieces.push({ ...part.extra, text: text.slice(at, ins.at) });
      at = Math.max(at, ins.at);
      pieces.push({ amount: { ing: ins.ing, share: ins.share } });
      k += 1;
    }
    if (end > at) pieces.push({ ...part.extra, text: text.slice(at, end) });
  };
  let at = 0;
  for (const d of findDurations(text)) {
    flushUntil(d.start, { start: at, extra: {} });
    pieces.push({ text: d.text, seconds: d.seconds });
    // Eine Menge mitten in einer Zeitangabe gibt es nicht; was dort läge, kommt dahinter.
    while (k < inserts.length && inserts[k].at <= d.end) { pieces.push({ amount: { ing: inserts[k].ing, share: inserts[k].share } }); k += 1; }
    at = d.end;
  }
  flushUntil(String(text ?? '').length, { start: at, extra: {} });
  return pieces;
}
