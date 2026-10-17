import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairOf, alternativeIds, isLinked, alternativeGroup, suggestAlternatives,
} from '../js/alternatives.js';

const compare = new Intl.Collator('de', { sensitivity: 'base' }).compare;

const recipe = (id, title, tags = []) => ({ id, title, tags });

test('speichert ein Paar immer in der gleichen Reihenfolge', () => {
  assert.deepEqual(pairOf('b', 'a'), { recipe_a: 'a', recipe_b: 'b' });
  assert.deepEqual(pairOf('a', 'b'), { recipe_a: 'a', recipe_b: 'b' });
});

test('findet die Alternativen in beide Richtungen', () => {
  const links = [pairOf('a', 'b'), pairOf('c', 'a')];
  assert.deepEqual(alternativeIds(links, 'a'), ['b', 'c']);
  assert.deepEqual(alternativeIds(links, 'b'), ['a']);
  assert.deepEqual(alternativeIds(links, 'x'), []);
  assert.equal(isLinked(links, 'b', 'a'), true);
  assert.equal(isLinked(links, 'b', 'c'), false);
});

test('das aufgerufene Rezept steht vorne, die Alternativen nach Titel', () => {
  const recipes = [recipe('a', 'Lasagne'), recipe('b', 'Chili'), recipe('c', 'Auflauf')];
  const group = alternativeGroup(recipes[0], [pairOf('a', 'b'), pairOf('a', 'c')], recipes, compare);
  assert.deepEqual(group.map((r) => r.title), ['Lasagne', 'Auflauf', 'Chili']);
});

test('übergeht Alternativen, die es nicht mehr gibt', () => {
  const recipes = [recipe('a', 'Lasagne')];
  const group = alternativeGroup(recipes[0], [pairOf('a', 'weg')], recipes, compare);
  assert.deepEqual(group.map((r) => r.id), ['a']);
});

test('schlägt Rezepte mit gemeinsamen Tags vor, die meisten zuerst', () => {
  const base = recipe('a', 'Lasagne', ['Nudeln', 'Ofen']);
  const candidates = [
    recipe('b', 'Auflauf', ['nudeln', 'ofen']),
    recipe('c', 'Spaghetti', ['Nudeln']),
    recipe('d', 'Salat', ['Schnell']),
  ];
  const found = suggestAlternatives(base, candidates, [], { compare });
  assert.deepEqual(found.map((r) => r.id), ['b', 'c']);
});

test('schlägt sich selbst und schon Verknüpftes nicht vor', () => {
  const base = recipe('a', 'Lasagne', ['Nudeln']);
  const candidates = [base, recipe('b', 'Auflauf', ['Nudeln']), recipe('c', 'Spaghetti', ['Nudeln'])];
  const found = suggestAlternatives(base, candidates, [pairOf('a', 'b')], { compare });
  assert.deepEqual(found.map((r) => r.id), ['c']);
});

test('ohne eigene Tags gibt es keine Vorschläge', () => {
  const found = suggestAlternatives(recipe('a', 'Lasagne'), [recipe('b', 'Auflauf', ['Ofen'])], [], { compare });
  assert.deepEqual(found, []);
});
