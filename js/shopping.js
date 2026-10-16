// Einkaufslisten: Zutaten aus eingeplanten Rezepten zusammenstellen, zusammenrechnen
// und wieder herausnehmen. Ein Eintrag ist { name, amount, unit, manual, checked, sources },
// sources = [{ recipe_id, plan_id, title, amount }] mit amount in der Einheit des Eintrags.
import { nameWords, isAvailable, STAPLES } from './pantry.js';
import { formatAmount } from './ingredients.js';

// Einheiten, die sich ineinander umrechnen lassen, haben dieselbe Klasse.
const CONVERTIBLE = {
  g: ['mass', 1], gramm: ['mass', 1], kg: ['mass', 1000], kilo: ['mass', 1000], mg: ['mass', 0.001],
  ml: ['volume', 1], l: ['volume', 1000], liter: ['volume', 1000], cl: ['volume', 10], dl: ['volume', 100],
  '': ['count', 1], 'stück': ['count', 1], 'stk.': ['count', 1], stk: ['count', 1],
};

// Schreibweisen derselben Einheit.
const SYNONYMS = [
  ['prise', 'prisen'], ['msp.', 'msp'], ['tasse', 'tassen'], ['dose', 'dosen'],
  ['pck.', 'pck', 'päckchen', 'packung', 'packungen'], ['scheibe', 'scheiben'], ['zehe', 'zehen'],
  ['zweig', 'zweige'], ['blatt', 'blätter'], ['glas', 'gläser'], ['kugel', 'kugeln'],
  ['stange', 'stangen'], ['knolle', 'knollen'], ['cup', 'cups'],
];
const SYNONYM_OF = new Map(SYNONYMS.flatMap((group) => group.map((u) => [u, group[0]])));

function unitInfo(unit) {
  const u = String(unit ?? '').trim().toLowerCase();
  if (CONVERTIBLE[u]) return { cls: CONVERTIBLE[u][0], factor: CONVERTIBLE[u][1] };
  return { cls: `unit:${SYNONYM_OF.get(u) ?? u}`, factor: 1 };
}

export function unitsCompatible(a, b) {
  return unitInfo(a).cls === unitInfo(b).cls;
}

const round = (n) => Math.round(n * 1000) / 1000;

export function convert(amount, from, to) {
  if (amount == null) return null;
  return round(Number(amount) * unitInfo(from).factor / unitInfo(to).factor);
}

function add(a, b) {
  if (a == null && b == null) return null;
  return round(Number(a ?? 0) + Number(b ?? 0));
}

// Name ohne Zusatz nach dem Komma: "Zwiebel(n), gewürfelt" → "Zwiebel(n)".
export function itemName(name) {
  return String(name).split(',')[0].trim() || String(name).trim();
}

// Vergleichsschlüssel: "Zwiebeln" und "Zwiebel, gehackt" gelten als dieselbe Zutat.
export function itemKey(name) {
  return nameWords(itemName(name)).join(' ');
}

export function sameItem(a, b) {
  const key = itemKey(a.name);
  return key !== '' && key === itemKey(b.name) && unitsCompatible(a.unit, b.unit);
}

// Zutaten der eingeplanten Rezepte, auf die geplante Personenzahl umgerechnet.
// entries: [{ plan_id, recipe, servings }]. Gleiche Zutaten werden direkt zusammengefasst.
// Grundzutaten (Salz, Pfeffer, Wasser, Öl, Zucker) hat man im Haus; sie kommen nicht auf die Liste.
export function additionsFromPlan(entries) {
  const out = [];
  for (const { plan_id, recipe, servings } of entries) {
    const factor = recipe.servings > 0 && servings > 0 ? servings / recipe.servings : 1;
    for (const ing of recipe.ingredients ?? []) {
      if (!ing.name?.trim() || isAvailable(ing.name, STAPLES)) continue;
      const base = ing.amountMax ?? ing.amount; // Bei "2–3" lieber genug kaufen.
      const amount = base == null ? null : round(base * factor);
      const addition = {
        name: itemName(ing.name),
        amount,
        unit: ing.unit ?? '',
        sources: [{ recipe_id: recipe.id, plan_id, title: recipe.title, amount }],
      };
      const existing = out.find((a) => sameItem(a, addition));
      if (existing) Object.assign(existing, mergeInto(existing, addition));
      else out.push(addition);
    }
  }
  return out;
}

// Gibt es auf der Liste schon einen offenen Eintrag, mit dem sich das zusammenrechnen lässt?
export function findConflict(addition, items) {
  return items.find((item) => !item.checked && sameItem(item, addition)) ?? null;
}

// Neue Menge und Quellen, wenn addition zu item dazugerechnet wird (in der Einheit von item).
export function mergeInto(item, addition) {
  return {
    amount: add(item.amount, convert(addition.amount, addition.unit, item.unit)),
    sources: [
      ...(item.sources ?? []),
      ...addition.sources.map((s) => ({ ...s, amount: convert(s.amount, addition.unit, item.unit) })),
    ],
  };
}

// Nimmt alles heraus, was ein Rezept beigetragen hat. Einträge, die nur aus diesem Rezept
// stammen, werden gelöscht; von Hand angelegte bleiben.
export function removeRecipe(items, recipeId) {
  const updates = [];
  const deletes = [];
  for (const item of items) {
    const sources = item.sources ?? [];
    const own = sources.filter((s) => s.recipe_id === recipeId);
    if (!own.length) continue;
    const rest = sources.filter((s) => s.recipe_id !== recipeId);
    if (!rest.length && !item.manual) {
      deletes.push(item.id);
      continue;
    }
    let amount = item.amount;
    if (amount != null) {
      const removed = own.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
      amount = round(Number(amount) - removed);
      if (amount <= 0) amount = null;
    }
    updates.push({ id: item.id, amount, sources: rest });
  }
  return { updates, deletes };
}

// Rezepte, die auf der Liste vorkommen, je einmal.
export function recipesOnList(items) {
  const seen = new Map();
  for (const item of items) {
    for (const s of item.sources ?? []) if (!seen.has(s.recipe_id)) seen.set(s.recipe_id, s.title);
  }
  return [...seen].map(([recipe_id, title]) => ({ recipe_id, title }));
}

// Plan-Einträge, deren Zutaten schon auf einer Liste stehen.
export function plannedIds(items) {
  return new Set(items.flatMap((item) => (item.sources ?? []).map((s) => s.plan_id).filter(Boolean)));
}

// Anzeige der Menge; große Mengen in kg bzw. l.
export function formatItemQuantity(item) {
  let amount = item.amount == null ? null : Number(item.amount);
  let unit = item.unit ?? '';
  if (amount != null && amount >= 1000 && (unit === 'g' || unit === 'ml')) {
    amount /= 1000;
    unit = unit === 'g' ? 'kg' : 'l';
  }
  return [amount == null ? '' : formatAmount(amount), unit].filter(Boolean).join(' ');
}
