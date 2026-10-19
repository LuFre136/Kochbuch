import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRecipes, formatCooked, cookedFromPlan, SORTS } from '../js/sorting.js';

const LIST = [
  { id: 'a', title: 'Brot', rating: 3, created_at: '2026-01-02T10:00:00Z', last_cooked: '2026-10-01' },
  { id: 'b', title: 'Auflauf', rating: 5, created_at: '2026-03-02T10:00:00Z', last_cooked: null },
  { id: 'c', title: 'Curry', rating: null, created_at: '2026-02-02T10:00:00Z', last_cooked: '2026-10-10' },
];

test('sortRecipes sortiert nach Titel, Bewertung, Erstelldatum und zuletzt gekocht', () => {
  assert.deepEqual(sortRecipes(LIST, 'name').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(sortRecipes(LIST, 'rating').map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(sortRecipes(LIST, 'created').map((r) => r.id), ['b', 'c', 'a']);
  // Zuletzt gekocht: das jüngste Datum zuerst, noch nie Gekochtes hinten.
  assert.deepEqual(sortRecipes(LIST, 'cooked').map((r) => r.id), ['c', 'a', 'b']);
  // Die Liste selbst bleibt unverändert.
  assert.deepEqual(LIST.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(SORTS.map(([k]) => k), ['name', 'rating', 'created', 'cooked']);
});

test('formatCooked schreibt kurze Angaben', () => {
  assert.equal(formatCooked('2026-10-17', '2026-10-17'), 'heute');
  assert.equal(formatCooked('2026-10-16', '2026-10-17'), 'gestern');
  assert.equal(formatCooked('2026-10-14', '2026-10-17'), 'vor 3 Tagen');
  assert.equal(formatCooked('2026-09-01', '2026-10-17'), '1. September 2026');
  assert.equal(formatCooked(null, '2026-10-17'), '');
});

test('cookedFromPlan nimmt je Rezept das späteste Datum', () => {
  const rows = [
    { recipe_id: 'a', planned_for: '2026-10-01' },
    { recipe_id: 'a', planned_for: '2026-10-05' },
    { recipe_id: 'b', planned_for: '2026-10-03' },
    { recipe_id: null, planned_for: '2026-10-09' },
  ];
  assert.deepEqual([...cookedFromPlan(rows)], [['a', '2026-10-05'], ['b', '2026-10-03']]);
  assert.equal(cookedFromPlan(undefined).size, 0);
});

import { filterByTime, recipeMinutes } from '../js/sorting.js';

test('Filter nach Zeit nimmt die Gesamtzeit, sonst die Kochzeit', () => {
  const list = [
    { title: 'A', total_minutes: 10 }, { title: 'B', total_minutes: 45, cook_minutes: 20 },
    { title: 'C', cook_minutes: 25 }, { title: 'D' }, { title: 'E', total_minutes: null, cook_minutes: null },
  ];
  assert.equal(recipeMinutes(list[1]), 45);
  assert.equal(recipeMinutes(list[2]), 25);
  const names = (r) => r.shown.map((x) => x.title).join('');
  assert.deepEqual({ t: names(filterByTime(list, 30)), u: filterByTime(list, 30).unknown }, { t: 'AC', u: 2 });
  assert.equal(names(filterByTime(list, 45)), 'ABC');
  assert.equal(names(filterByTime(list, 'none')), 'DE');
  assert.equal(names(filterByTime(list, null)), 'ABCDE');
  // Für Trefferlisten mit { recipe }
  assert.equal(filterByTime([{ recipe: list[0] }, { recipe: list[3] }], 15, (h) => h.recipe).shown.length, 1);
});
