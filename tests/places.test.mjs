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

import { categoryOrder, walkKey } from '../js/places.js';

test('Ladenweg: eigene Reihenfolge, Neues hinten, Unbekanntes fällt weg', () => {
  const all = ['Obst', 'Gemüse', 'Brot', 'Käse'];
  assert.deepEqual(categoryOrder(null, all), all);
  assert.deepEqual(categoryOrder(['Brot', 'Gibtsnicht', 'Obst', 'Brot'], all), ['Brot', 'Obst', 'Gemüse', 'Käse']);
});

test('Ladenweg: erst der Ort, dann die Kategorie in dessen Reihenfolge', () => {
  const orders = { supermarkt: ['Obst', 'Brot'], markt: ['Brot', 'Obst'] };
  const orderOf = (id) => orders[id] ?? [];
  const placeOrder = ['supermarkt', 'markt'];
  assert.deepEqual(walkKey(['markt'], 'Obst', placeOrder, orderOf), { place: 'markt', rank: [1, 1] });
  // Mehrere Orte: der erste in der Orte-Reihenfolge zählt.
  assert.deepEqual(walkKey(['markt', 'supermarkt'], 'Brot', placeOrder, orderOf), { place: 'supermarkt', rank: [0, 1] });
  // Mit Ort-Filter gilt dessen Reihenfolge.
  assert.deepEqual(walkKey(['markt', 'supermarkt'], 'Brot', placeOrder, orderOf, 'markt'), { place: 'markt', rank: [0, 0] });
  assert.deepEqual(walkKey([], 'Käse', placeOrder, orderOf).rank, [0, 2]);
});
