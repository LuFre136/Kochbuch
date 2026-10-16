import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractRecipe, parseDuration, parseYield, isAllowedUrl, splitNotes,
} from '../supabase/functions/import-recipe/index.ts';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('liest ein Chefkoch-Rezept aus', () => {
  const r = extractRecipe(fixture('chefkoch.html'), 'https://www.chefkoch.de/rezepte/123/x.html');
  assert.equal(r.title, 'Spaghetti Carbonara wie in Rom');
  assert.equal(r.description, 'Spaghetti Carbonara - original & ohne Sahne. Über 1000 Bewertungen');
  assert.deepEqual(r.tags, ['Hauptspeise', 'Pasta', 'Italien', 'Schnell']);
  assert.equal(r.servings, 4);
  assert.equal(r.total_minutes, 25);
  assert.equal(r.cook_minutes, 10);
  assert.deepEqual(r.ingredients, ['400 g Spaghetti', '150 g Pancetta', '4 Eigelb', '100 g Parmesan, gerieben', 'Salz und Pfeffer']);
  assert.deepEqual(r.steps, [
    'Die Spaghetti in Salzwasser bissfest kochen.',
    'Pancetta in Streifen schneiden und knusprig braten.',
    'Eigelb mit Parmesan verrühren.',
  ]);
  assert.equal(r.notes, 'Tipps und Varianten von der Rezeptautorin:\n- Statt Pancetta geht auch Guanciale.\n- Schmeckt auch mit Pecorino.');
  assert.equal(r.imageUrl, 'https://img.chefkoch-cdn.de/rezepte/123/bilder/456/crop-960x640/spaghetti-carbonara.jpg');
});

test('liest WordPress-Rezepte mit @graph und Abschnitten aus', () => {
  const r = extractRecipe(fixture('wordpress.html'), 'https://blog.example.de/dal/');
  assert.equal(r.title, 'Linsen-Dal');
  assert.equal(r.description, 'Cremig & würzig');
  assert.equal(r.servings, 2);
  assert.equal(r.total_minutes, 45);
  assert.equal(r.cook_minutes, null);
  assert.equal(r.notes, '');
  assert.deepEqual(r.tags, ['Indisch']);
  assert.deepEqual(r.steps, ['Vorbereitung:', 'Zwiebel würfeln.', 'Kochen:', 'Linsen 20 Minuten köcheln.', 'Mit Kokosmilch abschmecken.']);
  assert.equal(r.imageUrl, 'https://blog.example.de/wp-content/dal.jpg');
});

test('ohne Rezeptdaten bleiben wenigstens Titel, Beschreibung und Bild', () => {
  const html = '<title>Omas Kuchen</title><meta property="og:description" content="Der beste Kuchen"><meta property="og:image" content="https://x.de/k.jpg">';
  const r = extractRecipe(html, 'https://x.de/kuchen');
  assert.equal(r.structured, false);
  assert.equal(r.title, 'Omas Kuchen');
  assert.equal(r.description, 'Der beste Kuchen');
  assert.equal(r.imageUrl, 'https://x.de/k.jpg');
});

test('Hilfsfunktionen', () => {
  assert.equal(parseDuration('PT1H30M'), 90);
  assert.equal(parseDuration('P0DT0H20M'), 20);
  assert.equal(parseDuration('PT0S'), null);
  assert.equal(parseYield('6 Stück'), 6);
  assert.equal(parseYield(3), 3);
  assert.equal(parseYield('eine Form'), null);
  assert.ok(isAllowedUrl('https://www.chefkoch.de/rezepte/1'));
  assert.ok(!isAllowedUrl('http://localhost:54321'));
  assert.ok(!isAllowedUrl('http://169.254.169.254/latest'));
  assert.ok(!isAllowedUrl('file:///etc/passwd'));
});

test('Tipps der Autorin landen in den Notizen, auch ohne eigenen Absatz', () => {
  const tips = ['* In einer Dose hält das Brot ca. eine Woche.', '* Wer es lauwarm mag, kurz in die Mikrowelle.'];
  assert.deepEqual(splitNotes(['Ofen vorheizen.', 'Backen.', 'Tipps und Varianten von der Rezeptautorin:', ...tips]), {
    steps: ['Ofen vorheizen.', 'Backen.'],
    notes: ['Tipps und Varianten von der Rezeptautorin:', ...tips].join('\n'),
  });
  assert.deepEqual(splitNotes(['Ofen vorheizen.', 'Backen und abkühlen lassen. Tipps und Varianten von der Rezeptautorin: * In einer Dose …']), {
    steps: ['Ofen vorheizen.', 'Backen und abkühlen lassen.'],
    notes: 'Tipps und Varianten von der Rezeptautorin: * In einer Dose …',
  });
  assert.equal(splitNotes(['Teig rühren.', '**Tipp:** Mit Honig süßen.']).notes, '**Tipp:** Mit Honig süßen.');
  assert.equal(splitNotes(['Mit Tipps von Oma würzen.', 'Servieren.']).notes, '');
});

test('echtes Chefkoch-Bananenbrot: Tipps in die Notizen, kein Schritt „Zubereitung:“', () => {
  const r = extractRecipe(fixture('chefkoch-bananenbrot.html'), 'https://www.chefkoch.de/rezepte/2733891425739452/');
  assert.ok(r.steps.length >= 4);
  assert.ok(!r.steps.includes('Zubereitung:'));
  assert.ok(r.steps.every((s) => !/Tipps und Varianten|^- /.test(s)));
  assert.match(r.steps.at(-1), /kcal\.$/);
  assert.match(r.notes, /^Tipps und Varianten von der Rezeptautorin:\n- In einer Dose/);
  assert.match(r.notes, /\n- Ich backe es/);
});
