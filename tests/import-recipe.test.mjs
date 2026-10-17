import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractRecipe, parseDuration, parseYield, isAllowedUrl, splitNotes,
} from '../supabase/functions/import-recipe/index.ts';
import * as fn from '../supabase/functions/import-recipe/index.ts';

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

test('liest Nährwerte aus schema.org', async () => {
  const { parseNutrition } = await import('../supabase/functions/import-recipe/index.ts');
  assert.deepEqual(parseNutrition({
    '@type': 'NutritionInformation', servingSize: '1', calories: '542 kcal',
    proteinContent: '25,42g', fatContent: '27,71 g', carbohydrateContent: '46,65g',
  }), { per: 'Portion', kcal: 542, protein: 25.4, fat: 27.7, carbs: 46.7 });
  assert.deepEqual(parseNutrition({ servingSize: '100 g', calories: '1000 kJ', sodiumContent: '400 mg' }),
    { per: '100 g', kcal: 239, salt: 1 });
  assert.equal(parseNutrition({ servingSize: '1' }), null);
  assert.equal(parseNutrition('550 kcal'), null);
});

test('Rezept-Seiten liefern Nährwerte mit', () => {
  const html = `<script type="application/ld+json">{"@type":"Recipe","name":"Suppe","recipeIngredient":["1 l Wasser"],
    "nutrition":{"@type":"NutritionInformation","calories":"120 kcal","fatContent":"3 g"}}</script>`;
  assert.deepEqual(extractRecipe(html, 'https://x.de/suppe').nutrition, { per: 'Portion', kcal: 120, fat: 3 });
});

test('prüft Fotos für den Import', async () => {
  const { photoParts, aiPrompt } = await import('../supabase/functions/import-recipe/index.ts');
  assert.deepEqual(photoParts(['data:image/jpeg;base64,AAAA']), [{ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } }]);
  assert.equal(typeof photoParts([]), 'string');
  assert.equal(typeof photoParts(['data:text/html;base64,AAAA']), 'string');
  assert.equal(typeof photoParts(Array(7).fill('data:image/png;base64,AA')), 'string');
  assert.match(aiPrompt(null, 'images'), /handschriftlich/);
  assert.doesNotMatch(aiPrompt(null, 'images'), /Titel:/);
});

test('hochgeladene Videos und eingefügter Text', async () => {
  const { isVideoPath, aiPrompt, uploadToGemini } = await import('../supabase/functions/import-recipe/index.ts');
  const uid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.ok(isVideoPath(`${uid}/a1b2-c3.mp4`));
  assert.ok(isVideoPath(`${uid}/clip.MOV`));
  assert.ok(!isVideoPath(`${uid}/../anderer/clip.mp4`));
  assert.ok(!isVideoPath(`${uid}/clip.exe`));
  assert.ok(!isVideoPath('clip.mp4'));

  const paste = aiPrompt({ title: '', description: '200 g Mehl, 2 Eier verrühren', tags: [], thumbnail: null, seconds: null }, 'paste');
  assert.match(paste, /Kommentar/);
  assert.match(paste, /Text:\n200 g Mehl/);
  assert.doesNotMatch(paste, /Titel:/);

  // Files-API von Gemini: Upload starten, Datei senden, auf ACTIVE warten.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init.method ?? 'GET', init.headers]);
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
    if (String(url) === 'https://upload.example/session') return Response.json({ file: { name: 'files/abc', uri: 'https://g/files/abc', state: 'ACTIVE' } });
    return new Response('nope', { status: 500 });
  };
  try {
    const file = await uploadToGemini('KEY', new Uint8Array([1, 2, 3]), 'video/mp4', Date.now() + 10_000);
    assert.equal(file.uri, 'https://g/files/abc');
    assert.equal(calls[0][2]['X-Goog-Upload-Header-Content-Length'], '3');
    assert.equal(calls[1][2]['X-Goog-Upload-Command'], 'upload, finalize');

    globalThis.fetch = async (url) => (String(url).endsWith('/upload/v1beta/files')
      ? new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } })
      : Response.json({ file: { name: 'files/x', uri: 'u', state: 'FAILED' } }));
    await assert.rejects(uploadToGemini('KEY', new Uint8Array([1]), 'video/mp4', Date.now() + 10_000), /nicht verarbeiten/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- TikTok: Untertitel und Foto-Posts ----------

const tiktokPage = (payload, id = '__UNIVERSAL_DATA_FOR_REHYDRATION__') =>
  `<!doctype html><html><head><title>TikTok</title></head><body>
   <script id="${id}" type="application/json">${JSON.stringify(payload)}</script></body></html>`;

test('liest Untertitel und Dauer aus der TikTok-Seite', () => {
  const html = tiktokPage({
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        itemInfo: {
          itemStruct: {
            id: '7234567890123456789',
            desc: 'Bester Nudelauflauf #pasta',
            video: {
              duration: 42,
              subtitleInfos: [
                { LanguageCodeName: 'eng-US', Format: 'webvtt', Url: 'https://v16-webapp.tiktok.com/sub/eng.vtt' },
                { LanguageCodeName: 'deu-DE', Format: 'webvtt', Url: 'https://v16-webapp.tiktok.com/sub/deu.vtt' },
                { LanguageCodeName: 'deu-DE', Format: 'creator_caption', Url: 'https://v16-webapp.tiktok.com/sub/deu.json' },
              ],
            },
          },
        },
      },
    },
  });
  const post = fn.parseTikTokPage(html);
  assert.equal(post.caption, 'Bester Nudelauflauf #pasta');
  assert.equal(post.seconds, 42);
  assert.deepEqual(post.subtitles.map((x) => x.language), ['eng-US', 'deu-DE']); // creator_caption fällt weg
  // Deutsch wird bevorzugt.
  assert.equal(fn.pickSubtitle(post.subtitles), 'https://v16-webapp.tiktok.com/sub/deu.vtt');
  assert.deepEqual(post.images, []);
});

test('liest die Bilder eines TikTok-Foto-Posts, auch aus dem älteren SIGI_STATE', () => {
  const post = fn.parseTikTokPage(tiktokPage({
    ItemModule: {
      7234567890123456789: {
        desc: 'Rezept in den Bildern',
        video: { duration: 0 },
        imagePost: {
          images: [
            { imageURL: { urlList: ['https://p16-sign.tiktokcdn.com/a.jpeg', 'https://p16-sign.tiktokcdn.com/a-2.jpeg'] } },
            { imageURL: { urlList: ['https://p16-sign.tiktokcdn.com/b.jpeg'] } },
          ],
        },
      },
    },
  }, 'SIGI_STATE'));
  // Je Bild nur die erste Adresse.
  assert.deepEqual(post.images, ['https://p16-sign.tiktokcdn.com/a.jpeg', 'https://p16-sign.tiktokcdn.com/b.jpeg']);
  assert.equal(post.caption, 'Rezept in den Bildern');
});

test('ohne verwertbares JSON gibt die TikTok-Seite nichts her', () => {
  assert.equal(fn.parseTikTokPage('<html><body>Bitte anmelden</body></html>'), null);
  assert.equal(fn.parseTikTokPage(tiktokPage({ ItemModule: {} })), null);
  assert.equal(fn.parseTikTokPage('<script id="SIGI_STATE" type="application/json">kein json</script>'), null);
});

test('macht aus WebVTT Zeilen mit Zeitangabe', () => {
  const vtt = `WEBVTT

1
00:00:02.000 --> 00:00:05.000
Zuerst <b>200 g Mehl</b> abwiegen.

2
00:00:05.000 --> 00:00:07.500
Zuerst 200 g Mehl abwiegen.

3
00:01:12.300 --> 00:01:15.000
Dann die Zwiebeln
anbraten.
`;
  assert.deepEqual(fn.subtitlesToLines(vtt), [
    '0:02 Zuerst 200 g Mehl abwiegen.', // Wiederholung fällt weg
    '1:12 Dann die Zwiebeln anbraten.',
  ]);
  assert.deepEqual(fn.subtitlesToLines('WEBVTT\n\n'), []);
  // Auch das kurze Format ohne Stunden.
  assert.deepEqual(fn.subtitlesToLines('WEBVTT\n\n00:09.000 --> 00:11.000\nSalzen.\n'), ['0:09 Salzen.']);
});

test('die Anweisung für Untertitel verlangt Zeitstempel aus den Zeilen', () => {
  const meta = { title: 'Nudelauflauf', description: 'lecker', tags: [], thumbnail: null, seconds: 42 };
  const prompt = fn.aiPrompt(meta, 'subtitles');
  assert.match(prompt, /Untertitel eines Kochvideos/);
  assert.match(prompt, /- start: die Zeit vom Anfang der Untertitel-Zeile/);
});
