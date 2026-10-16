import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIngredientLine, parseNumber, formatAmount, formatQuantity, ingredientToLine,
} from '../js/ingredients.js';

test('parseNumber versteht Dezimalkomma, Brüche und Unicode-Brüche', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('1/2'), 0.5);
  assert.equal(parseNumber('1 1/2'), 1.5);
  assert.equal(parseNumber('½'), 0.5);
  assert.equal(parseNumber('1½'), 1.5);
  assert.equal(parseNumber('abc'), null);
});

test('parseIngredientLine trennt Menge, Einheit und Name', () => {
  assert.deepEqual(parseIngredientLine('200 g Mehl'), { amount: 200, amountMax: null, unit: 'g', name: 'Mehl' });
  assert.deepEqual(parseIngredientLine('200g Mehl'), { amount: 200, amountMax: null, unit: 'g', name: 'Mehl' });
  assert.deepEqual(parseIngredientLine('2 el Olivenöl'), { amount: 2, amountMax: null, unit: 'EL', name: 'Olivenöl' });
  assert.deepEqual(parseIngredientLine('2 Eier'), { amount: 2, amountMax: null, unit: '', name: 'Eier' });
  assert.deepEqual(parseIngredientLine('2-3 Zehen Knoblauch'), { amount: 2, amountMax: 3, unit: 'Zehen', name: 'Knoblauch' });
  assert.deepEqual(parseIngredientLine('Salz und Pfeffer'), { amount: null, amountMax: null, unit: '', name: 'Salz und Pfeffer' });
  assert.deepEqual(parseIngredientLine('½ Bund Petersilie'), { amount: 0.5, amountMax: null, unit: 'Bund', name: 'Petersilie' });
  assert.equal(parseIngredientLine('   '), null);
});

test('formatAmount rundet für die Anzeige', () => {
  assert.equal(formatAmount(0.5), '½');
  assert.equal(formatAmount(1.5), '1½');
  assert.equal(formatAmount(2), '2');
  assert.equal(formatAmount(1 / 3), '⅓');
  assert.equal(formatAmount(1.2), '1,2');
  assert.equal(formatAmount(333.33), '333');
  assert.equal(formatAmount(1.99), '2');
});

test('formatQuantity rechnet auf andere Personenzahl um', () => {
  const ing = parseIngredientLine('200 g Mehl');
  assert.equal(formatQuantity(ing, 6 / 4), '300 g');
  const eggs = parseIngredientLine('3 Eier');
  assert.equal(formatQuantity(eggs, 1 / 2), '1½');
  const range = parseIngredientLine('2-3 EL Öl');
  assert.equal(formatQuantity(range, 2), '4–6 EL');
});

test('ingredientToLine ergibt beim erneuten Parsen dieselbe Zutat', () => {
  for (const line of ['200 g Mehl', '½ Bund Petersilie', '1,25 l Milch', '2-3 Zehen Knoblauch', 'Salz', '⅓ TL Zimt']) {
    const ing = parseIngredientLine(line);
    assert.deepEqual(parseIngredientLine(ingredientToLine(ing)), ing, line);
  }
});
