import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCE, seasonOf, inSeason, usesProduce, seasonalRecipes } from '../js/season.js';

const find = (name) => PRODUCE.find((p) => p.name === name);
const recipe = (title, tags, ...names) => ({ title, tags, ingredients: names.map((name) => ({ name })) });

test('Saisonzeiten, auch über den Jahreswechsel', () => {
  assert.equal(seasonOf(find('Spargel'), 5), 'fresh');
  assert.equal(seasonOf(find('Spargel'), 8), null);
  assert.equal(seasonOf(find('Grünkohl'), 1), 'fresh');
  assert.equal(seasonOf(find('Grünkohl'), 12), 'fresh');
  assert.equal(seasonOf(find('Äpfel'), 3), 'store');
  assert.ok(inSeason(6).some((p) => p.name === 'Erdbeeren'));
  assert.ok(!inSeason(1).some((p) => p.name === 'Äpfel'));
  assert.ok(inSeason(1, { storage: true }).some((p) => p.name === 'Äpfel'));
  for (const p of PRODUCE) assert.ok(p.fresh.length, p.name);
});

test('Zutaten werden mit Synonymen und Plural erkannt', () => {
  assert.ok(usesProduce(recipe('', [], 'Äpfel, säuerlich'), find('Äpfel')));
  assert.ok(usesProduce(recipe('', [], '2 Karotten'), find('Möhren')));
  assert.ok(usesProduce(recipe('', [], 'Zwetschgen'), find('Pflaumen')));
  assert.ok(usesProduce(recipe('', [], 'Walnüsse, gehackt'), find('Walnüsse')));
  assert.ok(usesProduce(recipe('', [], 'Kirschtomaten'), find('Tomaten')));
  assert.ok(!usesProduce(recipe('', [], 'Knoblauchzehen'), find('Lauch')));
  assert.ok(!usesProduce(recipe('', [], 'Paprikapulver, edelsüß'), find('Paprika')));
  assert.ok(usesProduce(recipe('', [], 'rote Paprikaschoten'), find('Paprika')));
  assert.ok(usesProduce(recipe('', [], 'Paprika, rot'), find('Paprika')));
  assert.ok(!usesProduce(recipe('', [], 'Bananen'), find('Äpfel')));
});

test('passende Rezepte: Treffer zählen, Grundzutaten ignorieren, nach Tags filtern', () => {
  const recipes = [
    recipe('Bananenbrot', ['Backen'], 'Bananen', 'Apfel', 'Walnüsse'),
    recipe('Kürbissuppe', ['Suppe'], 'Hokkaido-Kürbis', 'Zwiebel', 'Möhren'),
    recipe('Nudeln', ['Pasta'], 'Spaghetti', 'Zwiebel', 'Knoblauch'),
  ];
  const october = inSeason(10);
  const all = seasonalRecipes(recipes, october);
  assert.deepEqual(all.map((h) => h.recipe.title), ['Bananenbrot', 'Kürbissuppe']);
  assert.deepEqual(all[1].matches.map((p) => p.name), ['Möhren', 'Kürbis']);
  assert.deepEqual(seasonalRecipes(recipes, october, ['Suppe']).map((h) => h.recipe.title), ['Kürbissuppe']);
  assert.deepEqual(seasonalRecipes(recipes, [find('Äpfel')]).map((h) => h.recipe.title), ['Bananenbrot']);
});
