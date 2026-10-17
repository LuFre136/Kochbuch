import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mentionsIngredient, ingredientKey, scaleIngredient, ingredientsFromStep,
  remainingIngredients, combinedTitle,
} from '../js/combine.js';
import { parseIngredientText } from '../js/ingredients.js';

const recipe = (servings, lines) => ({ servings, ingredients: parseIngredientText(lines.join('\n')) });

test('erkennt Zutaten im Schritttext', () => {
  assert.ok(mentionsIngredient('Die Zwiebel fein würfeln.', 'Zwiebeln'));
  assert.ok(mentionsIngredient('Linsen abgießen und dazugeben.', 'rote Linsen'));
  assert.ok(mentionsIngredient('Mit Olivenöl anbraten.', 'Öl'));
  assert.ok(mentionsIngredient('Das Mehl dazugeben.', 'Weizenmehl'));
  assert.ok(!mentionsIngredient('Alles gut verrühren.', 'Zwiebeln'));
  assert.ok(!mentionsIngredient('Den Teig ruhen lassen.', 'Tomaten'));
  assert.ok(!mentionsIngredient('', 'Mehl'));
  assert.ok(!mentionsIngredient('Mehl dazugeben', ''));
});

test('vergleicht Zutaten unabhängig von Einzahl und Mehrzahl', () => {
  assert.equal(ingredientKey({ name: 'Zwiebeln' }), ingredientKey({ name: 'Zwiebel' }));
  assert.notEqual(ingredientKey({ name: 'Zwiebeln' }), ingredientKey({ name: 'Knoblauch' }));
});

test('rechnet Mengen auf die Personenzahl um', () => {
  assert.deepEqual(scaleIngredient({ amount: 200, amountMax: null, unit: 'g', name: 'Mehl' }, 2),
    { amount: 400, amountMax: null, unit: 'g', name: 'Mehl' });
  assert.deepEqual(scaleIngredient({ amount: 2, amountMax: 3, unit: 'Zehen', name: 'Knoblauch' }, 0.5),
    { amount: 1, amountMax: 1.5, unit: 'Zehen', name: 'Knoblauch' });
  // Ohne Menge („etwas Salz“) bleibt die Zutat, wie sie ist.
  assert.deepEqual(scaleIngredient({ amount: null, unit: null, name: 'Salz' }, 3),
    { amount: null, unit: null, name: 'Salz' });
});

test('holt die im Schritt genannten Zutaten, umgerechnet und ohne Doppelte', () => {
  const b = recipe(2, ['100 g Mehl', '1 Zwiebel', '1 Prise Salz']);
  const have = [{ name: 'Mehl', amount: 200, unit: 'g' }];
  const found = ingredientsFromStep('Zwiebel würfeln und mit Mehl bestäuben.', b, have, 4);
  assert.deepEqual(found.map((i) => [i.name, i.amount]), [['Zwiebel', 2]]);
  assert.deepEqual(ingredientsFromStep('Alles verrühren.', b, have, 4), []);
});

test('listet die restlichen Zutaten eines Rezepts zum Nachtragen', () => {
  const b = recipe(2, ['100 g Mehl', '1 Zwiebel']);
  const rest = remainingIngredients(b, [{ name: 'Zwiebeln' }], 4);
  assert.deepEqual(rest.map((i) => [i.name, i.amount]), [['Mehl', 200]]);
});

test('setzt den Titel aus den Rezepten zusammen', () => {
  assert.equal(combinedTitle(['Lasagne', 'Salat']), 'Lasagne + Salat');
  assert.equal(combinedTitle(['Lasagne', '']), 'Lasagne');
});
