import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCategory, categoryKey, categoryRank, CATEGORIES, OTHER } from '../js/categories.js';
import { additionsFromPlan } from '../js/shopping.js';

test('schlägt sinnvolle Kategorien vor', () => {
  const cases = {
    Tomaten: 'Gemüse', Kirschtomaten: 'Gemüse', Tomatenmark: 'Konserven & Gläser', 'Ei(er)': 'Milchprodukte & Eier',
    Hähnchenbrustfilet: 'Fleisch & Wurst', Lachs: 'Fisch & Meeresfrüchte', Spaghetti: 'Nudeln, Reis & Getreide',
    'Mehl (Type 405)': 'Backzutaten', Olivenöl: 'Öl, Essig & Saucen', Paprikapulver: 'Gewürze', Paprika: 'Gemüse',
    Petersilie: 'Kräuter', Banane: 'Obst', 'Parmesan, gerieben': 'Milchprodukte & Eier', Baguette: 'Brot & Backwaren',
    Walnüsse: 'Nüsse & Trockenfrüchte', Knoblauchzehe: 'Gemüse', Weißwein: 'Getränke', Blätterteig: 'Tiefkühl',
  };
  for (const [name, category] of Object.entries(cases)) assert.equal(guessCategory(name), category, name);
  assert.equal(guessCategory('Etwas Seltsames'), OTHER);
  assert.equal(guessCategory(''), OTHER);
});

test('gleiche Zutat, gleicher Schlüssel', () => {
  assert.equal(categoryKey('Zwiebeln'), categoryKey('Zwiebel, gehackt'));
  assert.equal(categoryKey('Ei(er)'), categoryKey('Eier'));
  assert.equal(categoryKey('Mehl (Type 405)'), categoryKey('Mehl'));
  assert.equal(categoryKey(''), '');
});

test('Reihenfolge der Kategorien', () => {
  assert.ok(categoryRank('Obst') < categoryRank('Getränke'));
  assert.equal(categoryRank('Unbekannt'), CATEGORIES.length - 1);
});

test('auf die Einkaufsliste kommt die Zutat ohne Anmerkung', () => {
  const recipe = {
    id: 'r', title: 'Kuchen', servings: 2,
    ingredients: [{ amount: 200, unit: 'g', name: 'Mehl', note: 'Type 405' }, { amount: 2, unit: '', name: 'Ei(er) (Größe M)' }],
  };
  assert.deepEqual(additionsFromPlan([{ plan_id: 'p', recipe, servings: 2 }]).map((a) => a.name), ['Mehl', 'Ei']);
});
