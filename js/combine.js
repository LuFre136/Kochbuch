// Rezepte kombinieren: aus den Schritten mehrerer Rezepte ein neues zusammenstellen.
// Die Zutaten kommen aus dem Hauptrezept; nennt ein gewählter Schritt eine Zutat seines
// Rezepts, die noch fehlt, kommt sie dazu.

import { nameWords } from './pantry.js';
import { stepText, stepTime, stepVideoKey } from './video.js';

// Vergleicht zwei Wörter so, wie es für Zutaten in einem Schritttext reicht:
// "Linsen" passt auf "Linsen", "Mehl" auch auf "Weizenmehl".
const wordHits = (word, part) => word === part
  || (part.length >= 4 && word.endsWith(part))
  || (word.length >= 4 && part.endsWith(word))
  || (part === 'ol' && word.endsWith('ol')); // Öl auch in Olivenöl

// Nennt ein Schritttext diese Zutat? Der Kopf des Namens genügt, damit „rote Linsen“
// auch in „Linsen abgießen“ erkannt wird.
export function mentionsIngredient(text, name) {
  const words = nameWords(text);
  const parts = nameWords(name);
  if (!words.length || !parts.length) return false;
  const head = parts[parts.length - 1];
  return words.some((w) => wordHits(w, head));
}

// Schlüssel zum Vergleichen zweier Zutaten: gleicher Name, egal ob Einzahl oder Mehrzahl.
export const ingredientKey = (ing) => nameWords(ing?.name ?? '').join(' ');

// Rechnet eine Zutat auf eine andere Personenzahl um.
export function scaleIngredient(ing, factor) {
  if (factor === 1 || ing.amount == null) return { ...ing };
  const round = (n) => (n == null ? null : Math.round(n * factor * 100) / 100);
  return { ...ing, amount: round(ing.amount), amountMax: round(ing.amountMax) };
}

// Die Zutaten eines Rezepts, die in diesem Schritt vorkommen und im neuen Rezept noch
// fehlen, umgerechnet auf die Personenzahl des neuen Rezepts.
export function ingredientsFromStep(text, recipe, have, servings) {
  const known = new Set(have.map(ingredientKey));
  const factor = servings / (recipe.servings || servings);
  return recipe.ingredients
    .filter((i) => i.name && !known.has(ingredientKey(i)) && mentionsIngredient(text, i.name))
    .map((i) => scaleIngredient(i, factor));
}

// Die restlichen Zutaten eines Rezepts: die, die in keinem seiner gewählten Schritte
// genannt werden oder dort nicht erkannt wurden. Zum Nachtragen von Hand.
export function remainingIngredients(recipe, have, servings) {
  const known = new Set(have.map(ingredientKey));
  const factor = servings / (recipe.servings || servings);
  return recipe.ingredients
    .filter((i) => i.name && !known.has(ingredientKey(i)))
    .map((i) => scaleIngredient(i, factor));
}

// Die Schritte eines Rezepts, wie sie zum Kombinieren gebraucht werden. Jeder Zeitstempel
// bekommt sein Video ausdrücklich mit, damit er im neuen Rezept nicht auf das Video eines
// anderen Rezepts rutscht.
export function stepsForCombine(recipe) {
  return recipe.steps.map((st, i) => ({
    i, text: stepText(st), t: stepTime(st), v: stepVideoKey(st, recipe.sources),
  }));
}

// Alle Bilder der beteiligten Rezepte, eigene zuerst in der Reihenfolge der Rezepte.
// Bilder aus geteilten Kochbüchern liegen nicht im eigenen Speicher und bleiben weg.
export function combinedImages(recipes) {
  return [...new Set(recipes.filter((r) => !r.from).flatMap((r) => r.images ?? []))];
}

// Titel des neuen Rezepts: „A + B“.
export const combinedTitle = (titles) => titles.filter(Boolean).join(' + ').slice(0, 200);
