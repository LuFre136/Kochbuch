// "Was kann ich kochen?": vergleicht die Zutaten, die man im Haus hat, mit den Rezepten.

// Diese Zutaten gelten auf Wunsch immer als vorhanden.
export const STAPLES = ['Salz', 'Pfeffer', 'Wasser', 'Öl', 'Zucker'];

// Bezeichnungen, die nur Zubereitung oder Qualität beschreiben und beim Vergleich nicht zählen.
const FILLER = new Set([
  'frisch', 'frische', 'frischer', 'frischen', 'gehackt', 'gehackte', 'gerieben', 'geriebener', 'geriebene',
  'klein', 'kleine', 'kleiner', 'groß', 'große', 'großer', 'mittelgroß', 'mittelgroße', 'fein', 'feine', 'grob',
  'etwas', 'evtl', 'nach', 'belieben', 'geschmack', 'zum', 'für', 'die', 'den', 'der', 'das', 'aus', 'in', 'mit',
  'tk', 'bio', 'dose', 'dosen', 'gewürfelt', 'gewürfelte', 'geschält', 'geschälte', 'weich', 'kalt', 'warm',
  'zimmerwarm', 'gemahlen', 'gemahlener', 'getrocknet', 'getrocknete', 'reif', 'reife', 'ca', 'z', 'b',
]);

export function normalizeWord(w) {
  let s = w.toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
  // Einfache Plural-/Endungsbehandlung: Tomaten→tomat, Tomate→tomat, Eier→ei, Zwiebeln→zwiebel.
  const stripped = s.replace(/(en|er|n|s|e)$/, '');
  if (stripped.length >= 2) s = stripped;
  return s;
}

export function nameWords(text) {
  return String(text)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter((w) => w && !FILLER.has(w.toLowerCase()))
    .map(normalizeWord)
    .filter((w) => w.length >= 2);
}

function wordMatches(have, word) {
  if (have === word) return true;
  if (word.startsWith(have) && word.length - have.length <= 2) return true;
  if (have.startsWith(word) && have.length - word.length <= 2) return true;
  // Zusammengesetzte Wörter: "Weizenmehl" ist auch "Mehl", "Cocktailtomaten" auch "Tomaten".
  // Kurze Wörter nur bei Öl ("Olivenöl"), sonst passt z. B. "Ei" auf "Brei".
  return (have.length >= 4 || have === 'ol') && word.endsWith(have);
}

// Ein Begriff des Nutzers (auch mehrere Wörter wie "rote Linsen") passt auf einen Zutatennamen,
// wenn jedes seiner Wörter zu einem Wort im Namen passt.
export function termMatches(term, ingredientName) {
  const termWords = nameWords(term);
  const nameList = nameWords(ingredientName);
  if (!termWords.length || !nameList.length) return false;
  return termWords.every((t) => nameList.some((w) => wordMatches(t, w)));
}

// Zerlegt einen Zutatennamen in Alternativen: "Butter oder Margarine" → eine davon reicht.
// "Salz und Pfeffer" → beides wird gebraucht.
function requirements(name) {
  const main = String(name).split(',')[0];
  return main.split(/\s+(?:und|&|\+)\s+/i).map((part) => part.split(/\s+(?:oder|bzw\.?)\s+|\//i));
}

export function isAvailable(name, haveTerms) {
  return requirements(name).every((alternatives) => (
    alternatives.some((alt) => haveTerms.some((t) => termMatches(t, alt)))
  ));
}

// Liefert passende Rezepte, sortiert: zuerst die, bei denen nichts fehlt, dann nach Anzahl fehlender Zutaten.
// Vorgeschlagen wird jedes Rezept, das mindestens eine der eigenen Zutaten verwendet.
export function suggestRecipes(recipes, have, { useStaples = true, maxMissing = Infinity } = {}) {
  const own = have.map((t) => t.trim()).filter(Boolean);
  if (!own.length) return [];
  const terms = useStaples ? [...own, ...STAPLES] : own;
  const results = [];
  for (const recipe of recipes) {
    const names = recipe.ingredients.map((i) => i.name).filter(Boolean);
    if (!names.length) continue;
    const missing = names.filter((n) => !isAvailable(n, terms));
    const usesOwn = names.some((n) => own.some((t) => termMatches(t, n)));
    if (!usesOwn || missing.length > maxMissing) continue;
    results.push({ recipe, missing, total: names.length });
  }
  return results.sort((a, b) => a.missing.length - b.missing.length
    || (b.total - b.missing.length) - (a.total - a.missing.length)
    || a.recipe.title.localeCompare(b.recipe.title, 'de'));
}
