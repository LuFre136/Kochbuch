import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessPlaces, DEFAULT_PLACES } from '../js/places.js';
import { guessCategory } from '../js/categories.js';

const guess = (name, ids) => guessPlaces(name, guessCategory(name), ids);

test('schlägt sinnvolle Orte vor', () => {
  assert.deepEqual(guess('Tomaten'), ['supermarkt', 'markt']);
  assert.deepEqual(guess('Petersilie'), ['supermarkt', 'markt']);
  assert.deepEqual(guess('Brötchen'), ['supermarkt', 'baecker']);
  assert.deepEqual(guess('Spaghetti'), ['supermarkt']);
  assert.deepEqual(guess('Etwas Seltsames'), ['supermarkt']);
  assert.deepEqual(guess('Zahnpasta'), ['drogerie']);
  assert.deepEqual(guess('Backpapier'), ['supermarkt', 'drogerie']);
  assert.deepEqual(guess('Bio-Spülmittel'), ['supermarkt', 'drogerie']);
  assert.deepEqual(guess('Grillkohle'), ['baumarkt']);
  assert.deepEqual(guess('Batterien (AA)'), ['baumarkt']);
});

test('nur Orte, die es noch gibt', () => {
  assert.deepEqual(guess('Tomaten', ['supermarkt', 'drogerie']), ['supermarkt']);
  assert.deepEqual(guess('Grillkohle', ['eigener', 'supermarkt']), ['eigener']);
  assert.deepEqual(guess('Grillkohle', []), []);
});

test('Standard-Orte', () => {
  assert.deepEqual(DEFAULT_PLACES.map((p) => p.name), ['Supermarkt', 'Drogeriemarkt', 'Markt', 'Bäcker', 'Baumarkt', 'Sonstige']);
});
