import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemKey, unitsCompatible, convert, additionsFromPlan, findConflict, mergeInto, removeRecipe,
  recipesOnList, plannedIds, formatItemQuantity, removePlanEntry,
} from '../js/shopping.js';

const brot = {
  id: 'r1', title: 'Bananenbrot', servings: 4,
  ingredients: [
    { amount: 3, amountMax: null, unit: '', name: 'Bananen, reif' },
    { amount: 250, amountMax: null, unit: 'g', name: 'Mehl' },
    { amount: 2, amountMax: 3, unit: '', name: 'Eier' },
    { amount: null, amountMax: null, unit: '', name: 'Zimt' },
  ],
};
const kuchen = {
  id: 'r2', title: 'Kuchen', servings: 2,
  ingredients: [
    { amount: 0.5, amountMax: null, unit: 'kg', name: 'Weizenmehl' },
    { amount: 100, amountMax: null, unit: 'g', name: 'Mehl' },
    { amount: 1, amountMax: null, unit: 'Stück', name: 'Ei' },
    { amount: 1, amountMax: null, unit: 'EL', name: 'Zucker' },
  ],
};

test('gleiche Zutaten werden erkannt, Zusätze ignoriert', () => {
  assert.equal(itemKey('Zwiebel(n), gewürfelt'), itemKey('Zwiebeln'));
  assert.equal(itemKey('Eier'), itemKey('Ei'));
  assert.notEqual(itemKey('Mehl'), itemKey('Weizenmehl'));
});

test('Einheiten: umrechenbar oder gleich', () => {
  assert.ok(unitsCompatible('g', 'kg'));
  assert.ok(unitsCompatible('l', 'ml'));
  assert.ok(unitsCompatible('', 'Stück'));
  assert.ok(unitsCompatible('Zehe', 'Zehen'));
  assert.ok(!unitsCompatible('g', 'EL'));
  assert.ok(!unitsCompatible('', 'g'));
  assert.equal(convert(0.5, 'kg', 'g'), 500);
  assert.equal(convert(250, 'ml', 'l'), 0.25);
});

test('Zutaten aus dem Plan auf die Personenzahl umrechnen', () => {
  const adds = additionsFromPlan([{ plan_id: 'p1', recipe: brot, servings: 8 }]);
  const by = Object.fromEntries(adds.map((a) => [a.name, a]));
  assert.equal(by.Bananen.amount, 6);
  assert.equal(by.Mehl.amount, 500);
  assert.equal(by.Mehl.unit, 'g');
  assert.equal(by.Eier.amount, 6, 'bei Spannen die obere Menge');
  assert.equal(by.Zimt.amount, null);
  assert.deepEqual(by.Mehl.sources, [{ recipe_id: 'r1', plan_id: 'p1', title: 'Bananenbrot', amount: 500 }]);
});

test('gleiche Zutaten mehrerer Rezepte werden zusammengefasst', () => {
  const adds = additionsFromPlan([
    { plan_id: 'p1', recipe: brot, servings: 4 },
    { plan_id: 'p2', recipe: kuchen, servings: 2 },
  ]);
  const mehl = adds.find((a) => a.name === 'Mehl');
  assert.equal(mehl.amount, 350);
  assert.equal(mehl.sources.length, 2);
  assert.ok(adds.find((a) => a.name === 'Weizenmehl'), 'Weizenmehl bleibt eigener Eintrag');
  const eier = adds.find((a) => a.name === 'Eier');
  assert.equal(eier.amount, 4);
  assert.deepEqual(eier.sources.map((s) => s.title), ['Bananenbrot', 'Kuchen']);
});

test('Konflikt nur bei offenem Eintrag mit passender Einheit', () => {
  const add = { name: 'Mehl', amount: 0.2, unit: 'kg', sources: [{ recipe_id: 'r2', plan_id: 'p2', title: 'Kuchen', amount: 0.2 }] };
  const items = [
    { id: 'a', name: 'Mehl', amount: 300, unit: 'EL', checked: false, sources: [] },
    { id: 'b', name: 'Mehl', amount: 300, unit: 'g', checked: true, sources: [] },
    { id: 'c', name: 'Mehl', amount: 300, unit: 'g', checked: false, sources: [{ recipe_id: 'r1', title: 'Bananenbrot', amount: 300 }] },
  ];
  const hit = findConflict(add, items);
  assert.equal(hit.id, 'c');
  assert.deepEqual(mergeInto(hit, add), {
    amount: 500,
    sources: [
      { recipe_id: 'r1', title: 'Bananenbrot', amount: 300 },
      { recipe_id: 'r2', plan_id: 'p2', title: 'Kuchen', amount: 200 },
    ],
  });
  assert.equal(findConflict({ ...add, name: 'Zucker' }, items), null);
});

test('Rezept aus der Liste entfernen', () => {
  const items = [
    { id: '1', name: 'Mehl', amount: 500, unit: 'g', manual: false, sources: [
      { recipe_id: 'r1', title: 'Bananenbrot', amount: 300 }, { recipe_id: 'r2', title: 'Kuchen', amount: 200 }] },
    { id: '2', name: 'Bananen', amount: 3, unit: '', manual: false, sources: [{ recipe_id: 'r1', title: 'Bananenbrot', amount: 3 }] },
    { id: '3', name: 'Milch', amount: 1, unit: 'l', manual: true, sources: [] },
    { id: '4', name: 'Eier', amount: 10, unit: '', manual: true, sources: [{ recipe_id: 'r1', title: 'Bananenbrot', amount: 4 }] },
  ];
  assert.deepEqual(recipesOnList(items), [{ recipe_id: 'r1', title: 'Bananenbrot' }, { recipe_id: 'r2', title: 'Kuchen' }]);
  const { updates, deletes } = removeRecipe(items, 'r1');
  assert.deepEqual(deletes, ['2']);
  assert.deepEqual(updates, [
    { id: '1', amount: 200, sources: [{ recipe_id: 'r2', title: 'Kuchen', amount: 200 }] },
    { id: '4', amount: 6, sources: [] },
  ]);
});

test('Plan-Einträge auf der Liste und Anzeige', () => {
  assert.deepEqual([...plannedIds([{ sources: [{ plan_id: 'p1' }, { plan_id: null }] }, { sources: [{ plan_id: 'p2' }] }])], ['p1', 'p2']);
  assert.equal(formatItemQuantity({ amount: 1500, unit: 'g' }), '1½ kg');
  assert.equal(formatItemQuantity({ amount: 250, unit: 'ml' }), '250 ml');
  assert.equal(formatItemQuantity({ amount: null, unit: '' }), '');
  assert.equal(formatItemQuantity({ amount: '2', unit: '' }), '2');
});

test('Grundzutaten kommen nicht auf die Liste', () => {
  const r = { id: 'r9', title: 'Brot', servings: 1, ingredients: [
    { amount: 500, unit: 'g', name: 'Mehl' }, { amount: 1, unit: 'TL', name: 'Salz' },
    { amount: 300, unit: 'ml', name: 'Wasser, lauwarm' }, { amount: 2, unit: 'EL', name: 'Olivenöl' },
    { amount: null, unit: '', name: 'Salz und Pfeffer' }, { amount: 50, unit: 'g', name: 'Butter oder Öl' },
  ] };
  assert.deepEqual(additionsFromPlan([{ plan_id: 'p', recipe: r, servings: 1 }]).map((a) => a.name), ['Mehl']);
});

test('einen Plan-Eintrag von der Liste nehmen, andere Tage desselben Rezepts bleiben', () => {
  const items = [
    { id: '1', name: 'Mehl', amount: 500, unit: 'g', manual: false, sources: [
      { recipe_id: 'r1', plan_id: 'mo', title: 'Brot', amount: 250 }, { recipe_id: 'r1', plan_id: 'fr', title: 'Brot', amount: 250 }] },
    { id: '2', name: 'Hefe', amount: 1, unit: 'Würfel', manual: false, sources: [{ recipe_id: 'r1', plan_id: 'mo', title: 'Brot', amount: 1 }] },
  ];
  assert.deepEqual(removePlanEntry(items, 'mo'), {
    updates: [{ id: '1', amount: 250, sources: [{ recipe_id: 'r1', plan_id: 'fr', title: 'Brot', amount: 250 }] }],
    deletes: ['2'],
  });
});

import { frequentSuggestions } from '../js/shopping.js';

test('häufig gekauft: die meisten Käufe zuerst, ohne Offenes und Ausgeblendetes', () => {
  const key = (n) => n.toLowerCase();
  const frequent = [
    { key: 'milch', name: 'Milch', count: 5, last_bought: '2026-10-10' },
    { key: 'brot', name: 'Brot', count: 2, last_bought: '2026-10-12' },
    { key: 'eier', name: 'Eier', count: 5, last_bought: '2026-10-12' },
    { key: 'klopapier', name: 'Klopapier', count: 9, last_bought: '2026-10-01', hidden: true },
  ];
  const items = [{ name: 'Brot', checked: false }, { name: 'Milch', checked: true }];
  assert.deepEqual(frequentSuggestions(frequent, items, key).map((f) => f.name), ['Eier', 'Milch']);
  assert.deepEqual(frequentSuggestions(frequent, items, key, { limit: 1 }).map((f) => f.name), ['Eier']);
  assert.deepEqual(frequentSuggestions(frequent, [], key, { keep: (f) => f.name !== 'Eier' }).map((f) => f.name), ['Milch', 'Brot']);
});

test('häufig gekauft: ohne Zählung kommen die abgehakten Einträge', () => {
  const key = (n) => n.toLowerCase();
  const items = [{ name: 'Milch', checked: true, amount: 1, unit: 'l' }, { name: 'milch', checked: true }, { name: 'Brot', checked: false }];
  assert.deepEqual(frequentSuggestions([], items, key), [{ key: 'milch', name: 'Milch', amount: 1, unit: 'l' }]);
});
