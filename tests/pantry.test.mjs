import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termMatches, isAvailable, suggestRecipes } from '../js/pantry.js';

test('Singular, Plural und Umlaute passen zusammen', () => {
  assert.ok(termMatches('Tomaten', 'Tomate'));
  assert.ok(termMatches('Zwiebel', 'rote Zwiebeln'));
  assert.ok(termMatches('Eier', 'Ei'));
  assert.ok(termMatches('Apfel', 'Äpfel'));
  assert.ok(termMatches('Kartoffeln', 'Kartoffel(n), festkochend'));
});

test('zusammengesetzte Wörter und Zusätze', () => {
  assert.ok(termMatches('Mehl', 'Weizenmehl Type 405'));
  assert.ok(termMatches('Parmesan', 'Parmesan, frisch gerieben'));
  assert.ok(termMatches('rote Linsen', 'rote Linsen'));
  assert.ok(!termMatches('rote Linsen', 'Linsen'));
});

test('keine falschen Treffer', () => {
  assert.ok(!termMatches('Reis', 'Reibekäse'));
  assert.ok(!termMatches('Ei', 'Reis'));
  assert.ok(!termMatches('Ei', 'Eisbergsalat'));
  assert.ok(!termMatches('Tomaten', 'Kartoffeln'));
});

test('oder/und in Zutatennamen', () => {
  assert.ok(isAvailable('Butter oder Margarine', ['Margarine']));
  assert.ok(!isAvailable('Salz und Pfeffer', ['Salz']));
  assert.ok(isAvailable('Salz und Pfeffer', ['Salz', 'Pfeffer']));
});

const r = (title, ...names) => ({ title, ingredients: names.map((name) => ({ name })) });
const recipes = [
  r('Carbonara', 'Spaghetti', 'Eigelb', 'Pancetta', 'Parmesan', 'Salz', 'Pfeffer'),
  r('Tomatensoße', 'Tomaten', 'Zwiebel', 'Knoblauch', 'Olivenöl', 'Salz'),
  r('Pasta Pomodoro', 'Spaghetti', 'Tomaten', 'Basilikum', 'Salz'),
  r('Pfannkuchen', 'Mehl', 'Milch', 'Eier', 'Zucker'),
];

test('schlägt Rezepte vor, vollständige zuerst', () => {
  const out = suggestRecipes(recipes, ['Spaghetti', 'Tomaten', 'Basilikum']);
  assert.deepEqual(out.map((x) => [x.recipe.title, x.missing]), [
    ['Pasta Pomodoro', []],
    ['Tomatensoße', ['Zwiebel', 'Knoblauch']],
    ['Carbonara', ['Eigelb', 'Pancetta', 'Parmesan']],
  ]);
});

test('Grundzutaten lassen sich abschalten', () => {
  const out = suggestRecipes(recipes, ['Mehl', 'Milch', 'Eier'], { useStaples: false });
  assert.deepEqual(out.map((x) => [x.recipe.title, x.missing]), [['Pfannkuchen', ['Zucker']]]);
  assert.deepEqual(suggestRecipes(recipes, ['Mehl', 'Milch', 'Eier'])[0].missing, []);
});

test('ohne eigene Zutaten keine Vorschläge', () => {
  assert.deepEqual(suggestRecipes(recipes, []), []);
});
