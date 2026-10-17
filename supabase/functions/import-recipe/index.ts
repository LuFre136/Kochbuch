// Supabase Edge Function "import-recipe".
// Lädt eine Rezeptseite serverseitig (im Browser verhindert CORS das) und liest die
// strukturierten Rezeptdaten (schema.org/Recipe als JSON-LD) aus, die fast alle großen
// Rezeptseiten wie Chefkoch, Lecker oder Essen & Trinken mitliefern.
//
// Aufruf aus der App: supabase.functions.invoke('import-recipe', { body: { url } })
// Antwort: { title, description, tags, servings, total_minutes, cook_minutes,
//            ingredients: string[], steps: string[], notes, source, image } (image als data:-URL)
//
// Videos (YouTube, YouTube Shorts, TikTok) wertet Google Gemini aus. Dann sind Schritte
// { text, t } mit t = Sekunden im Video, und die Antwort enthält zusätzlich
// video: { provider, id } und ai: 'ok' | 'none' | 'failed' (+ ai_error).
// Secrets in Supabase: GEMINI_API_KEY (nötig für Videos), YOUTUBE_API_KEY (Titel und
// Beschreibung von YouTube), optional GEMINI_MODEL.

const MAX_PAGE_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 8_000_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', frac12: '½', frac14: '¼', frac34: '¾',
  ndash: '–', mdash: '—', deg: '°', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function cleanText(s: unknown): string {
  if (s == null) return '';
  return decodeEntities(String(s))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// ISO-8601-Dauer wie "PT1H30M" oder "P0DT0H20M" in Minuten.
export function parseDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const minutes = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Math.round(Number(m[4] || 0) / 60);
  return minutes > 0 ? minutes : null;
}

export function parseYield(y: unknown): number | null {
  const values = Array.isArray(y) ? y : [y];
  for (const v of values) {
    const m = String(v ?? '').match(/\d+/);
    if (m) {
      const n = Number(m[0]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

function types(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).map((x) => String(x));
}

// Sucht in beliebig verschachteltem JSON-LD (Arrays, @graph, mainEntity) das Recipe-Objekt.
export function findRecipe(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipe(item);
      if (found) return found;
    }
    return null;
  }
  if (data && typeof data === 'object') {
    const node = data as Record<string, unknown>;
    if (types(node).some((t) => t === 'Recipe' || t.endsWith('/Recipe'))) return node;
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
      const found = findRecipe(node[key]);
      if (found) return found;
    }
  }
  return null;
}

const SECTION_FILLER = /^(zubereitung|anleitung|instructions?|directions?|method)\s*:?$/i;

export function extractInstructions(raw: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (x == null) return;
    if (typeof x === 'string') {
      cleanText(x).split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
    } else if (Array.isArray(x)) {
      x.forEach(walk);
    } else if (typeof x === 'object') {
      const node = x as Record<string, unknown>;
      if (node.itemListElement) {
        // Abschnittsnamen wie "Teig" oder "Füllung" behalten, ein bloßes "Zubereitung" ist überflüssig.
        const name = cleanText(node.name);
        if (name && types(node).includes('HowToSection') && !SECTION_FILLER.test(name)) out.push(`${name}:`);
        walk(node.itemListElement);
      } else {
        walk(node.text ?? node.name);
      }
    }
  };
  walk(raw);
  return out;
}

// Viele Seiten (z. B. Chefkoch) hängen Tipps der Autorin an die Zubereitung an.
// Ab einer Zeile wie "Tipps und Varianten …:" gehört der Rest in die Notizen.
const NOTES_HEADING = /^(tipps?|tricks?|hinweise?|anmerkungen?|varianten?|notizen?|serviervorschlag|aufbewahrung)\b/i;

// Auch mitten in einer Zeile, falls die Seite den Absatz nicht umbricht ("… abkühlen lassen. Tipps und Varianten …").
const NOTES_INLINE = /(?<=[.!?:)]\s*)(tipps?\s+(?:und|&)\s+varianten|tipps?\s+(?:von\s+)?(?:der|des)\s+rezeptautor)/i;

export function splitNotes(lines: string[]): { steps: string[]; notes: string } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && NOTES_HEADING.test(line.replace(/^[\s*•#_–-]+/, ''))) {
      return { steps: lines.slice(0, i), notes: lines.slice(i).join('\n') };
    }
    const m = line.match(NOTES_INLINE);
    if (m && m.index) {
      const before = line.slice(0, m.index).trim();
      return {
        steps: [...lines.slice(0, i), ...(before ? [before] : [])],
        notes: [line.slice(m.index).trim(), ...lines.slice(i + 1)].join('\n'),
      };
    }
  }
  return { steps: lines, notes: '' };
}

function firstImageUrl(img: unknown): string | null {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) {
    for (const i of img) {
      const u = firstImageUrl(i);
      if (u) return u;
    }
    return null;
  }
  if (typeof img === 'object') {
    const o = img as Record<string, unknown>;
    return firstImageUrl(o.url ?? o.contentUrl);
  }
  return null;
}

function listOf(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(listOf);
  return String(v).split(',').map((s) => cleanText(s)).filter(Boolean);
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? cleanText(content) : null;
}

export interface ImportedRecipe {
  title: string;
  description: string;
  tags: string[];
  servings: number | null;
  total_minutes: number | null;
  cook_minutes: number | null;
  ingredients: string[];
  steps: string[];
  notes: string;
  imageUrl: string | null;
  structured: boolean;
}

export function extractRecipe(html: string, pageUrl: string): ImportedRecipe {
  let recipe: Record<string, unknown> | null = null;
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, json] of scripts) {
    try {
      recipe = findRecipe(JSON.parse(json.trim()));
    } catch {
      // Manche Seiten liefern kaputtes JSON-LD; dann einfach den nächsten Block versuchen.
    }
    if (recipe) break;
  }

  const absolute = (u: string | null) => {
    if (!u) return null;
    try { return new URL(u, pageUrl).href; } catch { return null; }
  };

  if (!recipe) {
    return {
      title: metaContent(html, 'og:title') ?? cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
      description: metaContent(html, 'og:description') ?? metaContent(html, 'description') ?? '',
      tags: [], servings: null, total_minutes: null, cook_minutes: null, ingredients: [], steps: [], notes: '',
      imageUrl: absolute(metaContent(html, 'og:image')),
      structured: false,
    };
  }

  let description = cleanText(recipe.description);
  // Chefkoch & Co. hängen gern Werbeformeln an ("… ► Portionsrechner ► Kochbuch").
  description = description.split('►')[0].trim();

  const tags = [...new Set([
    ...listOf(recipe.recipeCategory), ...listOf(recipe.recipeCuisine), ...listOf(recipe.keywords),
  ])].slice(0, 6);

  const prep = parseDuration(recipe.prepTime);
  const cook = parseDuration(recipe.cookTime);
  const total = parseDuration(recipe.totalTime) ?? (prep || cook ? (prep ?? 0) + (cook ?? 0) : null);

  return {
    title: cleanText(recipe.name) || metaContent(html, 'og:title') || '',
    description,
    tags,
    servings: parseYield(recipe.recipeYield),
    total_minutes: total,
    cook_minutes: cook,
    ingredients: listOfLines(recipe.recipeIngredient ?? recipe.ingredients),
    ...splitNotes(extractInstructions(recipe.recipeInstructions)),
    imageUrl: absolute(firstImageUrl(recipe.image) ?? metaContent(html, 'og:image')),
    structured: true,
  };
}

function listOfLines(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((s) => cleanText(s)).filter(Boolean);
}

// Nur öffentliche http(s)-Adressen abrufen, keine internen Hosts.
export function isAllowedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false; // IP-Adressen
  return host.includes('.');
}

// ---------- Videos ----------

export interface VideoRef { provider: 'youtube' | 'tiktok'; id: string; }

export function parseVideoUrl(raw: string): VideoRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const path = u.pathname;
  const ytId = (s: string | null | undefined) => (s && /^[\w-]{11}$/.test(s) ? s : null);
  if (host === 'youtu.be') {
    const id = ytId(path.split('/')[1]);
    return id ? { provider: 'youtube', id } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    const id = ytId(m ? m[1] : path === '/watch' ? u.searchParams.get('v') : null);
    return id ? { provider: 'youtube', id } : null;
  }
  if (host === 'tiktok.com') {
    const m = path.match(/\/(?:video|v)\/(\d{8,25})/) || path.match(/^\/player\/v1\/(\d{8,25})/);
    return m ? { provider: 'tiktok', id: m[1] } : null;
  }
  return null;
}

// Kurzlinks aus der TikTok-App (vm.tiktok.com/…) leiten auf die eigentliche Video-Seite weiter.
export const isTikTokShortLink = (raw: string) => /^https?:\/\/(vm|vt)\.tiktok\.com\//i.test(raw.trim());

export function videoSource(video: VideoRef, original: string): string {
  if (video.provider === 'youtube') {
    return /\/shorts\//.test(original) ? `https://www.youtube.com/shorts/${video.id}` : `https://www.youtube.com/watch?v=${video.id}`;
  }
  const u = new URL(original);
  return `https://www.tiktok.com${u.pathname}`;
}

// ISO-8601-Dauer wie "PT4M13S" in Sekunden (Videolänge).
export function durationSeconds(s: unknown): number | null {
  const m = String(s ?? '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const sec = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return sec > 0 ? sec : null;
}

// "2:15", "01:02:03", "135" oder "135s" in Sekunden.
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v ?? '').trim().replace(/s$/i, '');
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  return s.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

interface VideoMeta { title: string; description: string; tags: string[]; thumbnail: string | null; seconds: number | null; }

function env(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).Deno?.env.get(name) || undefined;
}

async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Fehler ${res.status}`);
  return await res.json();
}

async function youtubeMeta(id: string): Promise<VideoMeta> {
  const key = env('YOUTUBE_API_KEY');
  if (key) {
    try {
      const data = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${id}&key=${encodeURIComponent(key)}`);
      // deno-lint-ignore no-explicit-any
      const item = (data.items as any[])?.[0];
      if (item) {
        const t = item.snippet.thumbnails ?? {};
        const thumb = t.maxres ?? t.standard ?? t.high ?? t.medium ?? t.default;
        return {
          title: cleanText(item.snippet.title),
          description: String(item.snippet.description ?? '').trim(),
          tags: (item.snippet.tags ?? []).map((x: unknown) => cleanText(x)),
          thumbnail: thumb?.url ?? null,
          seconds: durationSeconds(item.contentDetails?.duration),
        };
      }
    } catch { /* weiter mit oEmbed */ }
  }
  const o = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  return { title: cleanText(o.title), description: '', tags: [], thumbnail: (o.thumbnail_url as string) ?? null, seconds: null };
}

async function tiktokMeta(url: string): Promise<VideoMeta> {
  const o = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { headers: { 'User-Agent': UA } });
  // Bei TikTok ist der oEmbed-Titel die komplette Bildunterschrift, oft mit dem Rezept darin.
  const caption = String(o.title ?? '').trim();
  const firstLine = cleanText(caption.split('\n')[0].replace(/#\S+/g, '')).slice(0, 120);
  return { title: firstLine || `TikTok von ${cleanText(o.author_name)}`, description: caption, tags: [], thumbnail: (o.thumbnail_url as string) ?? null, seconds: null };
}

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_recipe: { type: 'BOOLEAN' },
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    servings: { type: 'INTEGER', nullable: true },
    total_minutes: { type: 'INTEGER', nullable: true },
    cook_minutes: { type: 'INTEGER', nullable: true },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
    steps: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, start: { type: 'STRING', nullable: true } }, required: ['text'] },
    },
    notes: { type: 'STRING' },
  },
  required: ['is_recipe', 'title', 'ingredients', 'steps'],
};

export function aiPrompt(meta: VideoMeta, withVideo: boolean): string {
  return [
    withVideo
      ? 'Du bekommst ein Kochvideo samt Titel und Beschreibung. Schau dir das ganze Video an (Bild, Ton und eingeblendete Texte) und schreibe das Rezept auf.'
      : 'Du bekommst Titel und Beschreibung eines Kochvideos. Schreibe das Rezept auf, das darin steht.',
    'Regeln:',
    '- Alles auf Deutsch. Titel kurz und ohne Emojis oder Hashtags. Beschreibung höchstens zwei Sätze.',
    '- Zutaten: eine pro Eintrag, Menge zuerst, metrische Einheiten (z. B. "200 g Mehl", "1 EL Olivenöl", "2 Knoblauchzehen", "Salz"). Nur Mengen nennen, die im Video oder Text vorkommen; nichts erfinden.',
    '- Schritte: in der Reihenfolge des Videos, jeweils ein bis drei kurze Sätze, keine Nummerierung.',
    withVideo
      ? '- start: Zeitpunkt im Video im Format M:SS, an dem der Schritt beginnt. Wenn unklar, null.'
      : '- start: immer null.',
    '- servings, total_minutes, cook_minutes nur, wenn sie genannt werden oder sich klar ergeben, sonst null.',
    '- tags: höchstens fünf kurze deutsche Stichworte (z. B. "vegetarisch", "Pasta", "schnell").',
    '- notes: Tipps und Varianten aus dem Video, sonst leer.',
    '- Ist es kein Rezept, setze is_recipe auf false und lass Zutaten und Schritte leer.',
    '',
    `Titel: ${meta.title}`,
    `Beschreibung:\n${meta.description.slice(0, 8000) || '(keine)'}`,
  ].join('\n');
}

const RETRY_STATUS = new Set([404, 429, 500, 503]);

// deno-lint-ignore no-explicit-any
async function askGemini(key: string, parts: any[]): Promise<Record<string, unknown>> {
  const models = [...new Set([env('GEMINI_MODEL'), 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean))] as string[];
  let lastError = '';
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: AI_SCHEMA,
          mediaResolution: 'MEDIA_RESOLUTION_LOW',
        },
      }),
      signal: AbortSignal.timeout(110_000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini hat keine Antwort geliefert.');
      return JSON.parse(text);
    }
    let detail = '';
    try { detail = (await res.json()).error?.message ?? ''; } catch { /* keine JSON-Antwort */ }
    lastError = `Gemini: Fehler ${res.status}${detail ? ` (${detail})` : ''}`;
    if (!RETRY_STATUS.has(res.status)) break;
  }
  throw new Error(lastError);
}

export function normalizeAiRecipe(ai: Record<string, unknown>, maxSeconds: number | null, withTimes: boolean) {
  const str = (v: unknown) => cleanText(v);
  const int = (v: unknown, max: number) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n >= 1 && n <= max ? Math.round(n) : null;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const steps = (Array.isArray(ai.steps) ? ai.steps : []).map((s: Record<string, unknown> | string) => {
    const text = str(typeof s === 'string' ? s : s?.text);
    let t = withTimes && typeof s === 'object' ? parseTimestamp(s?.start) : null;
    if (t != null && maxSeconds != null && t > maxSeconds) t = null;
    return { text, t };
  }).filter((s) => s.text).map((s) => (s.t == null ? s.text : s));
  return {
    is_recipe: ai.is_recipe !== false,
    title: str(ai.title),
    description: str(ai.description),
    tags: list(ai.tags).slice(0, 5),
    servings: int(ai.servings, 100),
    total_minutes: int(ai.total_minutes, 6000),
    cook_minutes: int(ai.cook_minutes, 6000),
    ingredients: list(ai.ingredients),
    steps,
    notes: str(ai.notes),
  };
}

async function importVideo(video: VideoRef, url: string) {
  const source = videoSource(video, url);
  let meta: VideoMeta;
  try {
    meta = video.provider === 'youtube' ? await youtubeMeta(video.id) : await tiktokMeta(source);
  } catch {
    meta = { title: '', description: '', tags: [], thumbnail: null, seconds: null };
  }

  const key = env('GEMINI_API_KEY');
  let ai: ReturnType<typeof normalizeAiRecipe> | null = null;
  let aiError = '';
  if (key) {
    const tries: { withVideo: boolean }[] = [];
    if (video.provider === 'youtube') tries.push({ withVideo: true });
    if (meta.description) tries.push({ withVideo: false });
    for (const { withVideo } of tries) {
      try {
        const parts = [
          ...(withVideo ? [{ file_data: { file_uri: `https://www.youtube.com/watch?v=${video.id}` } }] : []),
          { text: aiPrompt(meta, withVideo) },
        ];
        ai = normalizeAiRecipe(await askGemini(key, parts), meta.seconds, withVideo);
        break;
      } catch (err) {
        aiError = (err as Error).message;
        if ((err as Error).name === 'TimeoutError') break; // kein zweiter Versuch, sonst läuft die Funktion zu lange
      }
    }
  }

  const found = ai?.is_recipe && ai.ingredients.length > 0;
  const image = meta.thumbnail ? await fetchImage(meta.thumbnail) : null;
  return {
    title: (found && ai!.title) || meta.title,
    description: found ? ai!.description : '',
    tags: found ? ai!.tags : [],
    servings: found ? ai!.servings : null,
    total_minutes: found ? ai!.total_minutes : null,
    cook_minutes: found ? ai!.cook_minutes : null,
    ingredients: found ? ai!.ingredients : [],
    steps: found ? ai!.steps : [],
    // Ohne Rezept aus der KI wenigstens die Video-Beschreibung als Notiz übernehmen.
    notes: found ? ai!.notes : meta.description.slice(0, 4000),
    structured: Boolean(found),
    source,
    image,
    video,
    ai: !key ? 'none' : ai ? 'ok' : 'failed',
    ...(ai ? {} : aiError ? { ai_error: aiError } : {}),
  };
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Die Seite ist zu groß.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function fetchImage(url: string): Promise<string | null> {
  if (!isAllowedUrl(url)) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const bytes = await readLimited(res, MAX_IMAGE_BYTES);
    return `data:${type.split(';')[0]};base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
});

// Nur angemeldete Nutzer der App dürfen importieren. Geprüft wird direkt bei Supabase Auth,
// das funktioniert unabhängig davon, ob "Verify JWT" für die Funktion an oder aus ist.
async function isSignedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization');
  const apikey = req.headers.get('apikey');
  // deno-lint-ignore no-explicit-any
  const base = (globalThis as any).Deno?.env.get('SUPABASE_URL');
  if (!auth || !apikey || !base) return false;
  const res = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  return res.ok;
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Nur POST erlaubt.' }, 405);
  if (!(await isSignedIn(req))) return json({ error: 'Bitte zuerst anmelden.' }, 401);

  let url: string;
  try {
    url = String((await req.json()).url ?? '').trim();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  if (!isAllowedUrl(url)) return json({ error: 'Bitte einen gültigen Link (https://…) eingeben.' }, 400);

  if (isTikTokShortLink(url)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      url = res.url || url;
    } catch {
      return json({ error: 'Der TikTok-Link konnte nicht aufgelöst werden.' }, 502);
    }
  }
  const video = parseVideoUrl(url);
  if (video) return json(await importVideo(video, url));

  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return json({ error: `Die Seite hat mit Fehler ${res.status} geantwortet.` }, 502);
    html = new TextDecoder().decode(await readLimited(res, MAX_PAGE_BYTES));
    url = res.url || url;
  } catch (err) {
    return json({ error: `Die Seite konnte nicht geladen werden: ${(err as Error).message}` }, 502);
  }

  const recipe = extractRecipe(html, url);
  const { imageUrl, ...rest } = recipe;
  const image = imageUrl ? await fetchImage(imageUrl) : null;
  return json({ ...rest, source: url, image });
}

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
if (g.Deno?.serve) g.Deno.serve(handle);
