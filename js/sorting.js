// Reihenfolge der Rezepte in der Übersicht und die Anzeige von "zuletzt gekocht".

// Die Auswahl im Sortier-Feld. 'cooked' steht nur zur Verfügung, wenn es die Spalte
// last_cooked gibt (gekocht.sql).
export const SORTS = [
  ['name', 'A–Z'],
  ['rating', 'Beste zuerst'],
  ['created', 'Neueste zuerst'],
  ['cooked', 'Zuletzt gekocht'],
];

// Sortiert eine Kopie der Liste. Bei gleichem Wert entscheidet der Titel; Rezepte ohne
// Datum stehen hinten.
export function sortRecipes(list, sort, compare = (a, b) => a.localeCompare(b)) {
  const byTitle = (a, b) => compare(a.title, b.title);
  const desc = (key) => (a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')) || byTitle(a, b);
  const out = [...list];
  if (sort === 'rating') out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byTitle(a, b));
  else if (sort === 'created') out.sort(desc('created_at'));
  else if (sort === 'cooked') out.sort(desc('last_cooked'));
  else out.sort(byTitle);
  return out;
}

// "zuletzt gekocht" kurz: heute, gestern, vor n Tagen, sonst das Datum.
export function formatCooked(iso, todayIso) {
  if (!iso) return '';
  const diff = Math.round((new Date(`${todayIso}T12:00:00`) - new Date(`${iso}T12:00:00`)) / 86400000);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'gestern';
  if (diff > 1 && diff < 14) return `vor ${diff} Tagen`;
  return new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Das späteste Datum je Rezept aus vergangenen Plan-Einträgen: Map von recipe_id auf Datum.
export function cookedFromPlan(rows) {
  const latest = new Map();
  for (const p of rows ?? []) {
    if (!p.recipe_id || !p.planned_for) continue;
    const have = latest.get(p.recipe_id);
    if (!have || have < p.planned_for) latest.set(p.recipe_id, p.planned_for);
  }
  return latest;
}
