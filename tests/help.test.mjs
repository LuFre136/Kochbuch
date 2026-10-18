import test from 'node:test';
import assert from 'node:assert/strict';

import { HELP, helpFor, helpTopic } from '../js/help.js';

test('jedes Hilfethema hat eine Kennung, einen Titel und Zeilen', () => {
  const ids = new Set();
  for (const topic of HELP) {
    assert.match(topic.id, /^[a-z]+$/);
    assert.ok(!ids.has(topic.id), `Kennung doppelt: ${topic.id}`);
    ids.add(topic.id);
    assert.ok(topic.title.length > 3, topic.id);
    assert.ok(topic.lines.length >= 3, `${topic.id} hat zu wenig Zeilen`);
    for (const line of topic.lines) assert.ok(line.trim().length > 20, `${topic.id}: ${line}`);
  }
});

test('der Hilfe-Knopf findet zu jeder Seite das passende Thema', () => {
  assert.equal(helpFor('').id, 'rezepte');
  assert.equal(helpFor('r', 'abc').id, 'rezepte');
  assert.equal(helpFor('r', 'bearbeiten').id, 'importieren');   // im Formular geht es um den Import
  assert.equal(helpFor('neu').id, 'importieren');
  assert.equal(helpFor('kochen').id, 'kochen');
  assert.equal(helpFor('saison').id, 'saison');
  assert.equal(helpFor('plan').id, 'plan');
  assert.equal(helpFor('einkauf').id, 'einkauf');
  assert.equal(helpFor('geteilt').id, 'teilen');
  assert.equal(helpFor('kochbuch').id, 'teilen');
  assert.equal(helpFor('kombinieren').id, 'alternativen');
  // Seiten ohne eigenes Thema zeigen keinen Knopf.
  assert.equal(helpFor('verwalten'), null);
  assert.equal(helpFor('hilfe'), null);
});

test('jede Seite mit Knopf hat genau ein Thema, und jede route gehört zu einer Seite', () => {
  const routes = HELP.flatMap((t) => t.routes ?? []);
  assert.equal(routes.length, new Set(routes).size, 'eine Seite ist zwei Themen zugeordnet');
  assert.equal(helpTopic('naehrwerte').routes, undefined);      // steht nur auf der Hilfeseite
  assert.equal(helpTopic('gibtesnicht'), null);
});
