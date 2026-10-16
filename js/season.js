// Saisonkalender für Obst und Gemüse aus Deutschland (Freiland bzw. Lagerware).
// Monate sind 1–12; Bereiche wie [11, 3] gehen über den Jahreswechsel.
import { termMatches } from './pantry.js';

// name, Art, frische Saison, Lagerware, Suchbegriffe (Standard: der Name).
// basic: steckt in fast jedem Rezept und zählt deshalb nicht für „passende Rezepte“.
// Zutaten, die nur ähnlich heißen, schließt EXCLUDE aus („Knoblauch“ ist kein Lauch).
const DATA = [
  ['Bärlauch', 'Gemüse', [3, 4]],
  ['Spargel', 'Gemüse', [4, 6]],
  ['Rhabarber', 'Gemüse', [4, 6]],
  ['Radieschen', 'Gemüse', [4, 10]],
  ['Frühlingszwiebeln', 'Gemüse', [4, 10], null, ['Frühlingszwiebel', 'Lauchzwiebel']],
  ['Spinat', 'Gemüse', [3, 11]],
  ['Rucola', 'Gemüse', [5, 10]],
  ['Kopfsalat', 'Gemüse', [5, 10], null, ['Kopfsalat', 'Eisbergsalat', 'Römersalat', 'Pflücksalat']],
  ['Kohlrabi', 'Gemüse', [5, 10]],
  ['Erbsen', 'Gemüse', [6, 8], null, ['Erbse', 'Zuckerschoten']],
  ['Grüne Bohnen', 'Gemüse', [6, 10], null, ['grüne Bohnen', 'Buschbohnen', 'Stangenbohnen', 'Brechbohnen']],
  ['Zucchini', 'Gemüse', [6, 10]],
  ['Brokkoli', 'Gemüse', [6, 10], null, ['Brokkoli', 'Broccoli']],
  ['Blumenkohl', 'Gemüse', [6, 11]],
  ['Fenchel', 'Gemüse', [6, 10]],
  ['Mangold', 'Gemüse', [6, 10]],
  ['Gurken', 'Gemüse', [6, 9], null, ['Gurke', 'Salatgurke']],
  ['Tomaten', 'Gemüse', [7, 10], null, ['Tomate']],
  ['Paprika', 'Gemüse', [7, 10], null, ['Paprika', 'Paprikaschote', 'Spitzpaprika']],
  ['Auberginen', 'Gemüse', [7, 10], null, ['Aubergine']],
  ['Mais', 'Gemüse', [8, 10]],
  ['Möhren', 'Gemüse', [6, 11], [12, 5], ['Möhre', 'Karotte', 'Mohrrübe']],
  ['Kartoffeln', 'Gemüse', [6, 10], [11, 5], ['Kartoffel']],
  ['Zwiebeln', 'Gemüse', [7, 10], [11, 6], ['Zwiebel', 'Schalotte'], true],
  ['Knoblauch', 'Gemüse', [7, 9], [10, 3], null, true],
  ['Lauch', 'Gemüse', [8, 3], null, ['Lauch', 'Porree']],
  ['Kürbis', 'Gemüse', [8, 11], [12, 2], ['Kürbis', 'Hokkaido', 'Butternut']],
  ['Rote Bete', 'Gemüse', [7, 11], [12, 3], ['Rote Bete', 'Rote Beete', 'Rote Rübe']],
  ['Sellerie', 'Gemüse', [8, 11], [12, 4], ['Sellerie']],
  ['Chinakohl', 'Gemüse', [8, 11], [12, 2]],
  ['Rotkohl', 'Gemüse', [8, 11], [12, 4], ['Rotkohl', 'Blaukraut', 'Rotkraut']],
  ['Weißkohl', 'Gemüse', [8, 11], [12, 4], ['Weißkohl', 'Weißkraut', 'Spitzkohl', 'Sauerkraut']],
  ['Wirsing', 'Gemüse', [6, 12], [1, 3]],
  ['Rosenkohl', 'Gemüse', [10, 2]],
  ['Grünkohl', 'Gemüse', [11, 2]],
  ['Feldsalat', 'Gemüse', [10, 3]],
  ['Pastinaken', 'Gemüse', [10, 3], null, ['Pastinake']],
  ['Schwarzwurzeln', 'Gemüse', [10, 3], null, ['Schwarzwurzel']],
  ['Steckrüben', 'Gemüse', [10, 2], [3, 4], ['Steckrübe']],
  ['Topinambur', 'Gemüse', [10, 3]],

  ['Erdbeeren', 'Obst', [5, 7], null, ['Erdbeere']],
  ['Kirschen', 'Obst', [6, 8], null, ['Kirsche', 'Sauerkirsche']],
  ['Johannisbeeren', 'Obst', [6, 8], null, ['Johannisbeere']],
  ['Stachelbeeren', 'Obst', [6, 8], null, ['Stachelbeere']],
  ['Himbeeren', 'Obst', [6, 9], null, ['Himbeere']],
  ['Heidelbeeren', 'Obst', [7, 9], null, ['Heidelbeere', 'Blaubeere']],
  ['Brombeeren', 'Obst', [7, 9], null, ['Brombeere']],
  ['Aprikosen', 'Obst', [7, 8], null, ['Aprikose', 'Marille']],
  ['Pfirsiche', 'Obst', [7, 9], null, ['Pfirsich', 'Nektarine']],
  ['Pflaumen', 'Obst', [7, 10], null, ['Pflaume', 'Zwetschge', 'Zwetschke', 'Mirabelle']],
  ['Holunder', 'Obst', [8, 9]],
  ['Weintrauben', 'Obst', [8, 10], null, ['Weintraube', 'Trauben']],
  ['Äpfel', 'Obst', [8, 11], [12, 7], ['Apfel']],
  ['Birnen', 'Obst', [8, 11], [12, 3], ['Birne']],
  ['Quitten', 'Obst', [9, 11], null, ['Quitte']],
  ['Walnüsse', 'Obst', [9, 11], [12, 3], ['Walnuss']],
  ['Haselnüsse', 'Obst', [9, 10], [11, 2], ['Haselnuss']],
  ['Maronen', 'Obst', [10, 11], null, ['Marone', 'Esskastanie']],
];

function months([from, to]) {
  const out = [];
  for (let m = from; ; m = (m % 12) + 1) {
    out.push(m);
    if (m === to) return out;
  }
}

const EXCLUDE = {
  Lauch: ['Knoblauch'],
  Erbsen: ['Kichererbsen'],
  Gurken: ['Gewürzgurke', 'Essiggurke'],
  Paprika: ['Pulver', 'edelsüß', 'rosenscharf', 'geräuchert'],
};

export const PRODUCE = DATA.map(([name, kind, fresh, store, terms, basic]) => ({
  name,
  kind,
  fresh: months(fresh),
  store: store ? months(store) : [],
  terms: terms ?? [name],
  basic: Boolean(basic),
  exclude: EXCLUDE[name] ?? [],
}));

export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// 'fresh', 'store' oder null.
export function seasonOf(item, month) {
  if (item.fresh.includes(month)) return 'fresh';
  if (item.store.includes(month)) return 'store';
  return null;
}

export function inSeason(month, { storage = false } = {}) {
  return PRODUCE.filter((p) => seasonOf(p, month) === 'fresh' || (storage && seasonOf(p, month) === 'store'));
}

export function usesProduce(recipe, item) {
  return recipe.ingredients.some((ing) => ing.name
    && item.terms.some((t) => termMatches(t, ing.name))
    && !item.exclude.some((t) => termMatches(t, ing.name)));
}

// Rezepte mit Saison-Zutaten, die meisten Treffer zuerst. tags: Rezept braucht mindestens einen davon.
export function seasonalRecipes(recipes, produce, tags = []) {
  const counted = produce.filter((p) => !p.basic);
  return recipes
    .filter((r) => !tags.length || tags.some((t) => r.tags.includes(t)))
    .map((recipe) => ({ recipe, matches: counted.filter((p) => usesProduce(recipe, p)) }))
    .filter((hit) => hit.matches.length)
    .sort((a, b) => b.matches.length - a.matches.length || a.recipe.title.localeCompare(b.recipe.title, 'de'));
}
