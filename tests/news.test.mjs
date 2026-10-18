import test from 'node:test';
import assert from 'node:assert/strict';

import { NEWS, newsSince, latestVersion } from '../js/news.js';

const LISTE = [{ version: 'c' }, { version: 'b' }, { version: 'a' }];

test('nach einem Update kommen nur die neuen Einträge', () => {
  assert.deepEqual(newsSince('b', LISTE), [{ version: 'c' }]);
  assert.deepEqual(newsSince('a', LISTE), [{ version: 'c' }, { version: 'b' }]);
  assert.deepEqual(newsSince('c', LISTE), []);                  // schon gesehen
});

test('beim allerersten Start zeigt die App nichts', () => {
  assert.deepEqual(newsSince(null, LISTE), []);
  assert.deepEqual(newsSince('', LISTE), []);
});

test('eine unbekannte gespeicherte Fassung zeigt höchstens drei Einträge', () => {
  const lang = ['e', 'd', 'c', 'b', 'a'].map((version) => ({ version }));
  assert.deepEqual(newsSince('weg', lang).map((n) => n.version), ['e', 'd', 'c']);
});

test('die echten Einträge sind brauchbar und eindeutig', () => {
  assert.equal(latestVersion(), NEWS[0].version);
  const versionen = NEWS.map((n) => n.version);
  assert.equal(versionen.length, new Set(versionen).size);
  for (const eintrag of NEWS) {
    assert.ok(eintrag.title.length > 3);
    assert.ok(eintrag.lines.length >= 1);
    for (const line of eintrag.lines) {
      assert.ok(line.text.trim().length > 20, line.text);
      if (line.ziel) assert.match(line.ziel, /^#\//);
    }
  }
});
