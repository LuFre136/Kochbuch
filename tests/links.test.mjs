import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify } from '../js/links.js';

test('macht Links anklickbar', () => {
  assert.equal(linkify('Siehe https://example.com/rezept.'),
    'Siehe <a href="https://example.com/rezept" target="_blank" rel="noopener noreferrer">https://example.com/rezept</a>.');
  assert.match(linkify('Tipp: www.chefkoch.de/x'), /href="https:\/\/www\.chefkoch\.de\/x"/);
  assert.match(linkify('(Video: https://youtu.be/abc)'), /href="https:\/\/youtu\.be\/abc"[^>]*>https:\/\/youtu\.be\/abc<\/a>\)$/);
  assert.match(linkify('https://de.wikipedia.org/wiki/Brot_(Begriff)'), /Brot_\(Begriff\)"/);
  assert.equal(linkify('Kein Link hier'), 'Kein Link hier');
});

test('maskiert alles andere', () => {
  assert.equal(linkify('<b>fett</b> & so'), '&lt;b&gt;fett&lt;/b&gt; &amp; so');
  assert.doesNotMatch(linkify('javascript:alert(1)'), /<a/);
  assert.match(linkify('https://x.de/?a=1&b="2"'), /href="https:\/\/x\.de\/\?a=1&amp;b=/);
});
