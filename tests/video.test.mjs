import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoUrl, videoOf, embedUrl, stepText, stepTime, makeStep, formatTime, parseTime,
} from '../js/video.js';
import * as fn from '../supabase/functions/import-recipe/index.ts';

const LINKS = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
  ['https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
  ['https://youtu.be/dQw4w9WgXcQ?si=abc', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
  ['https://youtube.com/shorts/aBcDeFgHiJk?feature=share', { provider: 'youtube', id: 'aBcDeFgHiJk', vertical: true }],
  ['https://www.tiktok.com/@koch.max/video/7234567890123456789?is_from_webapp=1', { provider: 'tiktok', id: '7234567890123456789', vertical: true }],
  ['https://www.tiktok.com/player/v1/7234567890123456789', { provider: 'tiktok', id: '7234567890123456789', vertical: true }],
];

test('erkennt Video-Links in der App', () => {
  for (const [url, expected] of LINKS) assert.deepEqual(parseVideoUrl(url), expected, url);
  assert.equal(parseVideoUrl('https://www.chefkoch.de/rezepte/123'), null);
  assert.equal(parseVideoUrl('https://www.youtube.com/@kanal'), null);
  assert.equal(parseVideoUrl('https://www.youtube.com/watch?v=kurz'), null);
  assert.equal(parseVideoUrl('javascript:alert(1)'), null);
  assert.deepEqual(videoOf(['https://www.chefkoch.de/x', 'https://youtu.be/dQw4w9WgXcQ']), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.equal(videoOf([]), null);
});

test('erkennt dieselben Links in der Edge Function', () => {
  for (const [url, expected] of LINKS) {
    const { vertical, ...ref } = expected;
    assert.deepEqual(fn.parseVideoUrl(url), ref, url);
  }
  assert.equal(fn.parseVideoUrl('https://www.chefkoch.de/rezepte/123'), null);
  assert.ok(fn.isTikTokShortLink('https://vm.tiktok.com/ZMabc123/'));
  assert.ok(!fn.isTikTokShortLink('https://www.tiktok.com/@a/video/1'));
  assert.equal(fn.videoSource({ provider: 'youtube', id: 'aBcDeFgHiJk' }, 'https://youtube.com/shorts/aBcDeFgHiJk?x=1'), 'https://www.youtube.com/shorts/aBcDeFgHiJk');
  assert.equal(fn.videoSource({ provider: 'youtube', id: 'dQw4w9WgXcQ' }, 'https://youtu.be/dQw4w9WgXcQ?si=1'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(fn.videoSource({ provider: 'tiktok', id: '7' }, 'https://www.tiktok.com/@a/video/7234567890123456789?lang=de'), 'https://www.tiktok.com/@a/video/7234567890123456789');
});

test('Einbett-Adressen', () => {
  assert.equal(embedUrl({ provider: 'youtube', id: 'dQw4w9WgXcQ' }, 'https://lufre136.github.io'),
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&playsinline=1&rel=0&origin=https%3A%2F%2Flufre136.github.io');
  assert.match(embedUrl({ provider: 'tiktok', id: '7234567890123456789' }), /^https:\/\/www\.tiktok\.com\/player\/v1\/7234567890123456789\?/);
});

test('Schritte mit und ohne Zeitstempel', () => {
  assert.equal(stepText('Zwiebel würfeln.'), 'Zwiebel würfeln.');
  assert.equal(stepTime('Zwiebel würfeln.'), null);
  assert.equal(stepText({ text: 'Anbraten', t: 75 }), 'Anbraten');
  assert.equal(stepTime({ text: 'Anbraten', t: 75 }), 75);
  assert.equal(stepTime({ text: 'Anbraten', t: null }), null);
  assert.equal(makeStep('Anbraten', null), 'Anbraten');
  assert.deepEqual(makeStep('Anbraten', 0), { text: 'Anbraten', t: 0 });
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(parseTime('2:15'), 135);
  assert.equal(parseTime(' 1:02:05 '), 3725);
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('2 Min'), null);
});

test('Zeitangaben aus Gemini und YouTube', () => {
  assert.equal(fn.parseTimestamp('2:15'), 135);
  assert.equal(fn.parseTimestamp('01:02:03'), 3723);
  assert.equal(fn.parseTimestamp('45s'), 45);
  assert.equal(fn.parseTimestamp(null), null);
  assert.equal(fn.parseTimestamp('etwa bei 2 Minuten'), null);
  assert.equal(fn.durationSeconds('PT4M13S'), 253);
  assert.equal(fn.durationSeconds('PT1H'), 3600);
  assert.equal(fn.durationSeconds('P0D'), null);
});

test('wandelt die Gemini-Antwort in ein Rezept um', () => {
  const ai = {
    is_recipe: true,
    title: ' One-Pot-Pasta ',
    description: 'Schnell & cremig.',
    servings: 2,
    total_minutes: 20,
    cook_minutes: null,
    tags: ['Pasta', 'schnell', 'vegetarisch', 'einfach', 'günstig', 'zu viel'],
    ingredients: ['250 g Spaghetti', '', '1 Zwiebel'],
    steps: [
      { text: 'Zwiebel würfeln.', start: '0:12' },
      { text: 'Alles in den Topf geben.', start: null },
      { text: 'Köcheln lassen.', start: '9:59' },
      { text: '  ', start: '1:00' },
    ],
    notes: '',
  };
  const r = fn.normalizeAiRecipe(ai, 300, true);
  assert.equal(r.title, 'One-Pot-Pasta');
  assert.equal(r.servings, 2);
  assert.equal(r.cook_minutes, null);
  assert.equal(r.tags.length, 5);
  assert.deepEqual(r.ingredients, ['250 g Spaghetti', '1 Zwiebel']);
  // Zeitstempel hinter dem Videoende werden verworfen, Schritte ohne Zeit bleiben Text.
  assert.deepEqual(r.steps, [{ text: 'Zwiebel würfeln.', t: 12 }, 'Alles in den Topf geben.', 'Köcheln lassen.']);

  const textOnly = fn.normalizeAiRecipe(ai, null, false);
  assert.deepEqual(textOnly.steps, ['Zwiebel würfeln.', 'Alles in den Topf geben.', 'Köcheln lassen.']);
  assert.equal(fn.normalizeAiRecipe({ is_recipe: false, ingredients: [], steps: [] }, null, true).is_recipe, false);
});

test('der Prompt enthält Titel, Beschreibung und die passende Zeitstempel-Regel', () => {
  const meta = { title: 'Pasta', description: 'Zutaten: 250 g Nudeln', tags: [], thumbnail: null, seconds: null };
  assert.match(fn.aiPrompt(meta, true), /M:SS/);
  assert.match(fn.aiPrompt(meta, false), /start: immer null/);
  assert.match(fn.aiPrompt(meta, false), /250 g Nudeln/);
});
