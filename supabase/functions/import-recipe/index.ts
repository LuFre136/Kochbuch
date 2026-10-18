// Supabase Edge Function "import-recipe".
// Lädt eine Rezeptseite serverseitig (im Browser verhindert CORS das) und liest die
// strukturierten Rezeptdaten (schema.org/Recipe als JSON-LD) aus, die fast alle großen
// Rezeptseiten wie Chefkoch, Lecker oder Essen & Trinken mitliefern.
//
// Aufruf aus der App: supabase.functions.invoke('import-recipe', { body: { url } })
// Antwort: { title, description, tags, servings, total_minutes, cook_minutes,
//            ingredients: string[], steps: string[], notes, source, image } (image als data:-URL)
//
// Bei TikTok liest die Funktion zuerst die Videoseite: gibt es Untertitel (WebVTT), macht
// Gemini daraus ein Rezept mit Zeitstempeln; bei Foto-Posts wertet es die Bilder aus; sonst
// bleibt die Bildunterschrift. Welcher Weg es war, steht in ai_from.
//
// Videos (YouTube, YouTube Shorts, TikTok) wertet Google Gemini aus. Dann sind Schritte
// { text, t } mit t = Sekunden im Video, und die Antwort enthält zusätzlich
// video: { provider, id } und ai: 'ok' | 'none' | 'failed' (+ ai_error).
// Secrets in Supabase: GEMINI_API_KEY (nötig für Videos und Fotos), YOUTUBE_API_KEY (Titel und
// Beschreibung von YouTube), optional GEMINI_MODEL.
//
// Fotos von Rezepten (Kochbuchseiten, gedruckt oder handschriftlich):
// supabase.functions.invoke('import-recipe', { body: { images: ['data:image/jpeg;base64,…', …] } })
//
// Hochgeladene Videos (z. B. ein gespeichertes TikTok): die App legt die Datei in den privaten
// Speicherordner import-videos/<user-id>/… und ruft
// supabase.functions.invoke('import-recipe', { body: { video: { path, source? } } }) auf.
// Die Funktion reicht das Video an Gemini weiter und löscht es danach überall. source ist ein
// optionaler Link zum Video (TikTok, YouTube), damit Quelle, Bild und Springen funktionieren.
//
// Eingefügter Text (Kommentar, Nachricht, Notizen): { text: '…' }.
//
// Nährwerte kommen, wenn vorhanden, als nutrition: { kcal, protein, fat, carbs, sugar, fiber, salt, per }
// (Gramm bzw. kcal; per = 'Portion' oder '100 g').
//
// Nährwerte aus den Zutaten schätzen:
// supabase.functions.invoke('import-recipe', { body: { nutrition: { ingredients: ['200 g Mehl', …], servings } } })
// Antwort: { nutrition: { … per: 'Portion' } | null, missing: string[], counted, ingredients }.

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

export interface Nutrition {
  kcal?: number; protein?: number; fat?: number; carbs?: number; sugar?: number; fiber?: number; salt?: number;
  per: 'Portion' | '100 g';
}

const NUTRIENTS: [keyof Omit<Nutrition, 'per'>, string][] = [
  ['protein', 'proteinContent'], ['fat', 'fatContent'], ['carbs', 'carbohydrateContent'],
  ['sugar', 'sugarContent'], ['fiber', 'fiberContent'], ['salt', 'sodiumContent'],
];

function amountOf(v: unknown): number | null {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// schema.org NutritionInformation, z. B. { calories: "542 kcal", proteinContent: "25,4 g" }.
export function parseNutrition(raw: unknown): Nutrition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  const out: Nutrition = { per: /100\s*g/i.test(String(n.servingSize ?? '')) ? '100 g' : 'Portion' };
  const cal = String(n.calories ?? '');
  const calValue = amountOf(cal);
  if (calValue != null) out.kcal = Math.round(/kj/i.test(cal) && !/kcal/i.test(cal) ? calValue / 4.184 : calValue);
  for (const [key, prop] of NUTRIENTS) {
    let value = amountOf(n[prop]);
    if (value == null) continue;
    if (key === 'salt') {
      // Natrium in Salz umrechnen (1 g Natrium ≈ 2,5 g Salz); mg berücksichtigen.
      if (/mg/i.test(String(n[prop]))) value /= 1000;
      value *= 2.5;
    }
    out[key] = Math.round(value * 10) / 10;
  }
  return Object.keys(out).length > 1 ? out : null;
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
  nutrition: Nutrition | null;
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
      nutrition: null,
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
    nutrition: parseNutrition(recipe.nutrition),
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

const MAX_PHOTOS = 6;

// ---------- TikTok: Untertitel und Foto-Posts von der Videoseite ----------

// Die TikTok-Videoseite bringt ihre Daten als JSON in einem <script> mit. Je nach Version
// heißt es __UNIVERSAL_DATA_FOR_REHYDRATION__ oder SIGI_STATE; beide werden gelesen.
const TIKTOK_SCRIPTS = /<script[^>]+id="(?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE)"[^>]*>([\s\S]*?)<\/script>/g;

export interface TikTokPost {
  caption: string;
  seconds: number | null;
  subtitles: { url: string; language: string }[];
  images: string[];
}

// Sucht im JSON der Seite das Objekt mit den Angaben zum Beitrag. Gesucht wird nach Inhalt
// (desc plus video oder imagePost), nicht nach einem festen Pfad, damit kleine Umbauten der
// Seite den Import nicht gleich lahmlegen.
function findPost(data: unknown, depth = 0): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || depth > 12) return null;
  const node = data as Record<string, unknown>;
  if (typeof node.desc === 'string' && (node.video || node.imagePost)) return node;
  for (const value of Object.values(node)) {
    const found = findPost(value, depth + 1);
    if (found) return found;
  }
  return null;
}

const urlList = (v: unknown): string[] => (Array.isArray((v as Record<string, unknown>)?.urlList)
  ? ((v as Record<string, unknown>).urlList as unknown[]).map(String).filter(isAllowedUrl)
  : []);

// Liest Bildunterschrift, Untertitel-Dateien und (bei Foto-Posts) die Bilder aus der Seite.
export function parseTikTokPage(html: string): TikTokPost | null {
  for (const m of html.matchAll(TIKTOK_SCRIPTS)) {
    let data: unknown;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const post = findPost(data);
    if (!post) continue;
    const video = (post.video ?? {}) as Record<string, unknown>;
    const infos = Array.isArray(video.subtitleInfos) ? video.subtitleInfos as Record<string, unknown>[] : [];
    const subtitles = infos
      // WebVTT lässt sich lesen; andere Formate (z. B. creator_caption als JSON) werden übergangen.
      .filter((i) => /webvtt|vtt/i.test(String(i.Format ?? i.format ?? '')) || /\.vtt/i.test(String(i.Url ?? i.url ?? '')))
      .map((i) => ({ url: String(i.Url ?? i.url ?? ''), language: String(i.LanguageCodeName ?? i.languageCodeName ?? '') }))
      .filter((i) => isAllowedUrl(i.url));
    const post2 = (post.imagePost ?? {}) as Record<string, unknown>;
    const images = (Array.isArray(post2.images) ? post2.images as Record<string, unknown>[] : [])
      .flatMap((img) => urlList(img.imageURL ?? img.imageUrl).slice(0, 1));
    return {
      caption: cleanText(post.desc),
      // TikTok gibt die Länge als Sekunden-Zahl an.
      seconds: parseTimestamp(video.duration) || null,
      subtitles,
      images,
    };
  }
  return null;
}

// Deutsch zuerst, dann Englisch, dann der Rest: so steht das Rezept möglichst in der
// Sprache, in der es gesprochen wurde.
export function pickSubtitle(subtitles: { url: string; language: string }[]): string | null {
  const rank = (l: string) => (/^de/i.test(l) ? 0 : /^en/i.test(l) ? 1 : 2);
  return [...subtitles].sort((a, b) => rank(a.language) - rank(b.language))[0]?.url ?? null;
}

const VTT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*-->/;

// Macht aus einer WebVTT-Datei Zeilen wie "0:12 Zwiebeln anbraten", damit die KI daraus
// Schritte mit Zeitstempeln bauen kann. Wiederholungen (TikTok zeigt Untertitel oft
// mehrfach) fallen weg.
export function subtitlesToLines(vtt: string, maxLines = 400): string[] {
  const lines: string[] = [];
  let time: number | null = null;
  let text: string[] = [];
  const flush = () => {
    const t = cleanText(text.join(' '));
    if (time != null && t && lines[lines.length - 1]?.endsWith(t) !== true) {
      const m = Math.floor(time / 60);
      lines.push(`${m}:${String(time % 60).padStart(2, '0')} ${t}`);
    }
    time = null;
    text = [];
  };
  for (const raw of String(vtt).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(VTT_TIME);
    if (m) {
      flush();
      time = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    } else if (!line || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line) || /^\d+$/.test(line)) {
      if (!line) flush();
    } else if (time != null) {
      text.push(decodeEntities(line.replace(/<[^>]*>/g, ' ')));
    }
    if (lines.length >= maxLines) break;
  }
  flush();
  return lines;
}

const MAX_VTT_BYTES = 400_000;

async function fetchText(url: string, limit: number): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return new TextDecoder().decode(await readLimited(res, limit));
}

// Holt die Videoseite von TikTok. Scheitert das (TikTok sperrt Abrufe aus Rechenzentren
// zeitweise), bleibt es beim Import aus der Bildunterschrift.
async function tiktokPost(url: string): Promise<TikTokPost | null> {
  try {
    return parseTikTokPage(await fetchText(url, MAX_PAGE_BYTES));
  } catch {
    return null;
  }
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
    nutrition: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        kcal: { type: 'NUMBER', nullable: true }, protein: { type: 'NUMBER', nullable: true },
        fat: { type: 'NUMBER', nullable: true }, carbs: { type: 'NUMBER', nullable: true },
        sugar: { type: 'NUMBER', nullable: true }, fiber: { type: 'NUMBER', nullable: true },
        salt: { type: 'NUMBER', nullable: true }, per_100g: { type: 'BOOLEAN', nullable: true },
      },
    },
  },
  required: ['is_recipe', 'title', 'ingredients', 'steps'],
};

export type AiSource = 'video' | 'text' | 'images' | 'paste' | 'subtitles';

const AI_INTRO: Record<AiSource, string> = {
  video: 'Du bekommst ein Kochvideo samt Titel und Beschreibung. Schau dir das ganze Video an (Bild, Ton und eingeblendete Texte) und schreibe das Rezept auf.',
  text: 'Du bekommst Titel und Beschreibung eines Kochvideos. Schreibe das Rezept auf, das darin steht.',
  paste: 'Du bekommst einen Text, in dem ein Rezept steht, z. B. einen Kommentar, eine Nachricht oder Notizen. Schreibe das Rezept auf.',
  images: 'Du bekommst ein oder mehrere Fotos eines Rezepts, z. B. Seiten aus einem Kochbuch oder eine handschriftliche Rezeptkarte. Lies das Rezept vollständig ab (auch Handschrift; mehrere Fotos gehören zu einem Rezept) und schreibe es auf.',
  subtitles: 'Du bekommst die Untertitel eines Kochvideos, jede Zeile mit der Stelle im Video, dazu Titel und Bildunterschrift. Schreibe das Rezept auf, das darin gesprochen wird.',
};

export function aiPrompt(meta: VideoMeta | null, source: AiSource): string {
  return [
    AI_INTRO[source],
    'Regeln:',
    '- Alles auf Deutsch. Titel kurz und ohne Emojis oder Hashtags. Beschreibung höchstens zwei Sätze.',
    '- Zutaten: eine pro Eintrag, Menge zuerst, metrische Einheiten (z. B. "200 g Mehl", "1 EL Olivenöl", "2 Knoblauchzehen", "Salz"). Zusätze wie die Mehlsorte in Klammern dahinter ("200 g Mehl (Type 405)"). Nur Mengen nennen, die vorkommen; nichts erfinden.',
    source === 'images'
      ? '- Schritte: in der Reihenfolge der Vorlage, jeweils ein bis drei kurze Sätze, keine Nummerierung. Unleserliches nicht raten, sondern mit "[unleserlich]" kennzeichnen.'
      : '- Schritte: in der Reihenfolge des Videos, jeweils ein bis drei kurze Sätze, keine Nummerierung.',
    source === 'video'
      ? '- start: Zeitpunkt im Video im Format M:SS, an dem der Schritt beginnt. Wenn unklar, null.'
      : source === 'subtitles'
        ? '- start: die Zeit vom Anfang der Untertitel-Zeile, in der der Schritt beginnt, im Format M:SS. Wenn unklar, null.'
        : '- start: immer null.',
    '- servings, total_minutes, cook_minutes nur, wenn sie genannt werden oder sich klar ergeben, sonst null.',
    '- tags: höchstens fünf kurze deutsche Stichworte (z. B. "vegetarisch", "Pasta", "schnell").',
    '- notes: Tipps und Varianten, sonst leer.',
    '- nutrition: nur, wenn Nährwerte ausdrücklich angegeben sind (kcal und Gramm; per_100g = true, wenn sie für 100 g gelten, sonst pro Portion). Nicht schätzen; sonst null.',
    '- Ist es kein Rezept, setze is_recipe auf false und lass Zutaten und Schritte leer.',
    ...(meta && source === 'paste' ? ['', `Text:\n${meta.description.slice(0, MAX_TEXT)}`]
      : meta ? ['', `Titel: ${meta.title}`, `Beschreibung:\n${meta.description.slice(0, 8000) || '(keine)'}`] : []),
  ].join('\n');
}

// Modelle in der Reihenfolge, in der sie versucht werden; GEMINI_MODEL kommt davor.
// Google schaltet alte Modelle ab ("no longer available to new users"), deshalb steht das
// aktuelle Flash-Modell zuerst und ein älteres sowie der "latest"-Alias als Rückfall dahinter.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

const RETRY_STATUS = new Set([404, 429, 500, 503]);

// deno-lint-ignore no-explicit-any
async function askGemini(key: string, parts: any[], lowResolution = true, timeoutMs = 110_000, schema: unknown = AI_SCHEMA): Promise<Record<string, unknown>> {
  const models = [...new Set([env('GEMINI_MODEL'), ...GEMINI_MODELS].filter(Boolean))] as string[];
  const failed: string[] = [];
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: schema,
          // Videos in niedriger Auflösung (spart Kontingent); Fotos voll, damit auch Handschrift lesbar ist.
          ...(lowResolution ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini hat keine Antwort geliefert.');
      return JSON.parse(text);
    }
    let detail = '';
    try { detail = (await res.json()).error?.message ?? ''; } catch { /* keine JSON-Antwort */ }
    failed.push(`${model}: Fehler ${res.status}${detail ? ` (${detail})` : ''}`);
    if (!RETRY_STATUS.has(res.status)) break;
  }
  // Alle Modelle nennen, damit man in der Meldung sieht, was wirklich schiefgeht.
  throw new Error(`Gemini — ${failed.join(' | ')}`);
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
    nutrition: aiNutrition(ai.nutrition),
  };
}

function aiNutrition(raw: unknown): Nutrition | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const out: Nutrition = { per: n.per_100g ? '100 g' : 'Portion' };
  for (const key of ['kcal', 'protein', 'fat', 'carbs', 'sugar', 'fiber', 'salt'] as const) {
    const v = Number(n[key]);
    if (n[key] != null && Number.isFinite(v) && v >= 0 && v < 100000) out[key] = key === 'kcal' ? Math.round(v) : Math.round(v * 10) / 10;
  }
  return Object.keys(out).length > 1 ? out : null;
}

// Nährwerte aus den Zutaten ermitteln (Knopf im Bearbeiten-Formular): Gemini schätzt für jede
// Zutatenzeile die Werte der genannten Menge, hier werden sie summiert und auf eine Portion
// heruntergerechnet. Zeilen ohne Menge ("Salz", "Öl zum Braten") oder unbekannte Lebensmittel
// kommen als missing zurück, damit die App darauf hinweisen kann.
export const NUTRITION_KEYS = ['kcal', 'protein', 'fat', 'carbs', 'sugar', 'fiber', 'salt'] as const;

export const NUTRITION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ingredients: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          found: { type: 'BOOLEAN' },
          kcal: { type: 'NUMBER', nullable: true }, protein: { type: 'NUMBER', nullable: true },
          fat: { type: 'NUMBER', nullable: true }, carbs: { type: 'NUMBER', nullable: true },
          sugar: { type: 'NUMBER', nullable: true }, fiber: { type: 'NUMBER', nullable: true },
          salt: { type: 'NUMBER', nullable: true },
        },
        required: ['name', 'found'],
      },
    },
  },
  required: ['ingredients'],
};

export function nutritionPrompt(ingredients: string[]): string {
  return [
    'Du bekommst die Zutatenliste eines Rezepts. Gib für jede Zeile die Nährwerte der dort genannten Menge an, nicht pro 100 g.',
    'Regeln:',
    '- Eine Antwort pro Zeile, in derselben Reihenfolge; name genau wie in der Liste.',
    '- kcal in Kilokalorien, alles andere in Gramm; salt als Kochsalz.',
    '- Haushaltsmaße umrechnen (1 EL Öl ≈ 14 g, 1 TL ≈ 5 g, 1 Ei ≈ 55 g, 1 Knoblauchzehe ≈ 3 g, 1 Zwiebel ≈ 110 g, 1 Tasse Mehl ≈ 120 g).',
    '- Nimm die übliche Zusammensetzung des Lebensmittels aus einer Nährwerttabelle; eine gute Schätzung reicht.',
    '- found = false und alle Werte null, wenn die Menge fehlt oder offen ist ("Salz", "etwas Öl zum Braten", "Deko") oder das Lebensmittel unbekannt ist. Nicht raten.',
    '- Zutaten, die nicht mitgegessen werden (Öl zum Einfetten, Wasser zum Kochen), ebenfalls found = false.',
    '',
    'Zutaten:',
    ...ingredients.map((x, i) => `${i + 1}. ${x}`),
  ].join('\n');
}

export function sumNutrition(raw: unknown, servings: number): { nutrition: Nutrition | null; missing: string[]; counted: number } {
  const list = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(list.ingredients) ? list.ingredients : [];
  const total: Record<string, number> = {};
  const missing: string[] = [];
  let counted = 0;
  for (const entry of items) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const name = cleanText(item.name);
    const values: Record<string, number> = {};
    for (const key of NUTRITION_KEYS) {
      const v = Number(item[key]);
      if (item[key] != null && Number.isFinite(v) && v >= 0 && v < 100_000) values[key] = v;
    }
    // Ohne kcal ist die Zutat nicht verwertbar, auch wenn die KI found = true meldet.
    if (item.found !== true || values.kcal == null) {
      if (name) missing.push(name);
      continue;
    }
    counted += 1;
    for (const [key, v] of Object.entries(values)) total[key] = (total[key] ?? 0) + v;
  }
  if (!counted) return { nutrition: null, missing, counted };
  const portions = Math.max(1, Math.round(servings) || 1);
  const nutrition: Nutrition = { per: 'Portion' };
  for (const key of NUTRITION_KEYS) {
    if (total[key] == null) continue;
    const v = total[key] / portions;
    nutrition[key] = key === 'kcal' ? Math.round(v) : Math.round(v * 10) / 10;
  }
  return { nutrition, missing, counted };
}

export const MAX_NUTRITION_INGREDIENTS = 60;

async function estimateNutrition(body: unknown) {
  const req = (body ?? {}) as Record<string, unknown>;
  const list = (Array.isArray(req.ingredients) ? req.ingredients : []).map((x) => cleanText(x)).filter(Boolean);
  if (!list.length) return json({ error: 'Für die Nährwerte fehlen die Zutaten.' }, 400);
  if (list.length > MAX_NUTRITION_INGREDIENTS) {
    return json({ error: `Nährwerte gehen bis ${MAX_NUTRITION_INGREDIENTS} Zutaten.` }, 400);
  }
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ error: 'Für die Nährwerte fehlt in Supabase das Secret GEMINI_API_KEY (siehe README).' }, 400);
  const servings = Number(req.servings);
  try {
    const ai = await askGemini(key, [{ text: nutritionPrompt(list) }], true, 60_000, NUTRITION_SCHEMA);
    const { nutrition, missing, counted } = sumNutrition(ai, Number.isFinite(servings) ? servings : 1);
    return json({ nutrition, missing, counted, ingredients: list.length });
  } catch (err) {
    return json({ error: `Die Nährwerte konnten nicht ermittelt werden: ${(err as Error).message}` }, 502);
  }
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
  let from = '';
  if (key) {
    // Mehrere Wege, der beste zuerst; der nächste kommt nur, wenn der vorige scheitert.
    // deno-lint-ignore no-explicit-any
    const tries: { parts: any[]; withTimes: boolean; from: string }[] = [];
    if (video.provider === 'youtube') {
      tries.push({
        parts: [{ file_data: { file_uri: `https://www.youtube.com/watch?v=${video.id}` } }, { text: aiPrompt(meta, 'video') }],
        withTimes: true,
        from: 'video',
      });
    }
    if (video.provider === 'tiktok') {
      // Von der TikTok-Seite kommen Untertitel (mit Zeiten) und bei Foto-Posts die Bilder.
      const post = await tiktokPost(source);
      if (post) {
        if (post.seconds) meta.seconds = post.seconds;
        if (post.caption && !meta.description) meta.description = post.caption;
        const vtt = pickSubtitle(post.subtitles);
        if (vtt) {
          try {
            const lines = subtitlesToLines(await fetchText(vtt, MAX_VTT_BYTES));
            if (lines.length) {
              tries.push({
                parts: [{ text: `${aiPrompt(meta, 'subtitles')}\n\nUntertitel:\n${lines.join('\n')}` }],
                withTimes: true,
                from: 'subtitles',
              });
            }
          } catch { /* ohne Untertitel geht es mit der Bildunterschrift weiter */ }
        }
        if (post.images.length) {
          const photos = (await Promise.all(post.images.slice(0, MAX_PHOTOS).map(fetchImage))).filter(Boolean);
          const parts = photos.length ? photoParts(photos) : 'keine';
          // Foto-Posts (mehrere Bilder statt Video) liest Gemini wie Fotos vom Kochbuch.
          if (typeof parts !== 'string') tries.push({ parts: [...parts, { text: aiPrompt(meta, 'images') }], withTimes: false, from: 'photos' });
        }
      }
    }
    if (meta.description) tries.push({ parts: [{ text: aiPrompt(meta, 'text') }], withTimes: false, from: 'description' });
    for (const t of tries) {
      try {
        ai = normalizeAiRecipe(await askGemini(key, t.parts, t.from !== 'photos'), meta.seconds, t.withTimes);
        if (ai.is_recipe && ai.ingredients.length) { from = t.from; break; }
        // Kein Rezept gefunden: den nächsten Weg versuchen, aber das Ergebnis behalten.
        if (!from) from = t.from;
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
    nutrition: found ? ai!.nutrition : null,
    structured: Boolean(found),
    source,
    image,
    video,
    ai: !key ? 'none' : ai ? 'ok' : 'failed',
    ...(found && from ? { ai_from: from } : {}),
    ...(ai ? {} : aiError ? { ai_error: aiError } : {}),
  };
}

const MAX_PHOTO_BYTES = 12_000_000; // Summe der Fotos als Base64

// Prüft die Fotos aus der App: data:-URLs von JPEG, PNG, WebP oder HEIC.
export function photoParts(images: unknown): { inline_data: { mime_type: string; data: string } }[] | string {
  if (!Array.isArray(images) || !images.length) return 'Bitte mindestens ein Foto auswählen.';
  if (images.length > MAX_PHOTOS) return `Bitte höchstens ${MAX_PHOTOS} Fotos auf einmal.`;
  let total = 0;
  const parts = [];
  for (const img of images) {
    const m = String(img).match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return 'Das Format eines Fotos wird nicht unterstützt.';
    total += m[2].length;
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  if (total > MAX_PHOTO_BYTES) return 'Die Fotos sind zu groß.';
  return parts;
}

async function importPhotos(images: unknown) {
  const parts = photoParts(images);
  if (typeof parts === 'string') return json({ error: parts }, 400);
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ error: 'Für Fotos fehlt in Supabase das Secret GEMINI_API_KEY.' }, 400);
  let ai: ReturnType<typeof normalizeAiRecipe>;
  try {
    ai = normalizeAiRecipe(await askGemini(key, [...parts, { text: aiPrompt(null, 'images') }], false), null, false);
  } catch (err) {
    return json({ error: `Die Fotos konnten nicht ausgewertet werden: ${(err as Error).message}` }, 502);
  }
  return json({ ...aiResult(ai), source: '', image: null, photos: true });
}

// Ergebnis der KI als Antwort für die App (Fotos, hochgeladene Videos, eingefügter Text).
function aiResult(ai: ReturnType<typeof normalizeAiRecipe>) {
  const found = ai.is_recipe && (ai.ingredients.length > 0 || ai.steps.length > 0);
  return {
    title: ai.title,
    description: found ? ai.description : '',
    tags: found ? ai.tags : [],
    servings: found ? ai.servings : null,
    total_minutes: found ? ai.total_minutes : null,
    cook_minutes: found ? ai.cook_minutes : null,
    ingredients: found ? ai.ingredients : [],
    steps: found ? ai.steps : [],
    notes: found ? ai.notes : '',
    nutrition: found ? ai.nutrition : null,
    structured: found,
  };
}

const MAX_TEXT = 20_000;

async function importText(text: unknown) {
  const t = String(text ?? '').trim();
  if (t.length < 20) return json({ error: 'Bitte einen längeren Text mit dem Rezept einfügen.' }, 400);
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ error: 'Für Texte fehlt in Supabase das Secret GEMINI_API_KEY.' }, 400);
  try {
    const meta = { title: '', description: t, tags: [], thumbnail: null, seconds: null };
    const ai = normalizeAiRecipe(await askGemini(key, [{ text: aiPrompt(meta, 'paste') }]), null, false);
    return json({ ...aiResult(ai), source: '', image: null, pasted: true });
  } catch (err) {
    return json({ error: `Der Text konnte nicht ausgewertet werden: ${(err as Error).message}` }, 502);
  }
}

export const VIDEO_BUCKET = 'import-videos';
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp'];

// Pfad im Speicherordner: <user-id>/<datei>; die Zugriffsregeln erlauben nur den eigenen Ordner.
export const isVideoPath = (p: unknown): p is string =>
  typeof p === 'string' && /^[0-9a-f-]{36}\/[\w-]{1,80}\.(mp4|mov|webm|m4v|3gp)$/i.test(p);

const GEMINI = 'https://generativelanguage.googleapis.com';

// Lädt ein Video über die Files-API zu Gemini und wartet, bis es verarbeitet ist.
export async function uploadToGemini(key: string, bytes: Uint8Array, mimeType: string, deadline: number) {
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'kochbuch-import' } }),
    signal: AbortSignal.timeout(20_000),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`Gemini: Hochladen fehlgeschlagen (${start.status})`);
  const done = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!done.ok) throw new Error(`Gemini: Hochladen fehlgeschlagen (${done.status})`);
  let file = (await done.json()).file as { name: string; uri: string; mimeType?: string; state?: string };
  // Gemini muss das Video erst verarbeiten (state PROCESSING), bevor es Fragen dazu beantwortet.
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Gemini braucht zu lange für dieses Video. Versuche ein kürzeres.');
    await new Promise((r) => setTimeout(r, 2000));
    file = await getJson(`${GEMINI}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } }) as typeof file;
  }
  if (file.state === 'FAILED') throw new Error('Gemini konnte das Video nicht verarbeiten.');
  return file;
}

async function deleteGeminiFile(key: string, name: string) {
  try {
    await fetch(`${GEMINI}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) });
  } catch { /* Gemini löscht hochgeladene Dateien ohnehin nach 48 Stunden */ }
}

// Löst Kurzlinks von TikTok auf.
async function resolveUrl(url: string): Promise<string> {
  if (!isTikTokShortLink(url)) return url;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return res.url || url;
}

async function importUploadedVideo(req: Request, input: { path?: unknown; source?: unknown }) {
  const started = Date.now();
  const path = input?.path;
  if (!isVideoPath(path)) return json({ error: 'Ungültige Videodatei.' }, 400);
  const base = env('SUPABASE_URL');
  // Mit der Anmeldung des Nutzers: Supabase lässt so nur Dateien aus dem eigenen Ordner zu.
  const storageHeaders = { Authorization: req.headers.get('authorization') ?? '', apikey: req.headers.get('apikey') ?? '' };
  const objectUrl = `${base}/storage/v1/object/${VIDEO_BUCKET}/${path}`;
  const removeUpload = () => fetch(objectUrl, { method: 'DELETE', headers: storageHeaders }).then((r) => r.body?.cancel()).catch(() => {});

  const key = env('GEMINI_API_KEY');
  if (!key) { await removeUpload(); return json({ error: 'Für Videos fehlt in Supabase das Secret GEMINI_API_KEY.' }, 400); }

  // Optionaler Link zum Video: Titel, Bild und Bildunterschrift dazu, und die Zeitstempel springen später im Player.
  let video: VideoRef | null = null;
  let source = '';
  let meta: VideoMeta | null = null;
  const sourceUrl = String(input?.source ?? '').trim();
  if (isAllowedUrl(sourceUrl)) {
    try {
      const resolved = await resolveUrl(sourceUrl);
      video = parseVideoUrl(resolved);
      if (video) {
        source = videoSource(video, resolved);
        meta = video.provider === 'youtube' ? await youtubeMeta(video.id) : await tiktokMeta(source);
      }
    } catch { /* ohne Zusatzangaben weiter */ }
  }

  let geminiFile: { name: string; uri: string } | null = null;
  try {
    const res = await fetch(objectUrl, { headers: storageHeaders, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return json({ error: `Das Video wurde im Speicher nicht gefunden (${res.status}).` }, 404);
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    // Gemini kennt iPhone-Videos (QuickTime) unter video/mov.
    const mimeType = type === 'video/quicktime' ? 'video/mov' : type === 'video/x-m4v' ? 'video/mp4' : VIDEO_TYPES.includes(type) ? type : 'video/mp4';
    const bytes = await readLimited(res, MAX_VIDEO_BYTES);
    // Die Funktion darf insgesamt etwa 150 Sekunden laufen; Puffer für die Antwort von Gemini lassen.
    geminiFile = await uploadToGemini(key, bytes, mimeType, started + 70_000);
    const parts = [
      { file_data: { mime_type: mimeType, file_uri: geminiFile.uri } },
      { text: aiPrompt(meta, 'video') },
    ];
    const timeLeft = Math.max(20_000, 140_000 - (Date.now() - started));
    const ai = normalizeAiRecipe(await askGemini(key, parts, true, timeLeft), meta?.seconds ?? null, true);
    const image = meta?.thumbnail ? await fetchImage(meta.thumbnail) : null;
    const result = aiResult(ai);
    return json({
      ...result,
      title: result.title || meta?.title || '',
      source,
      image,
      ...(video ? { video } : {}),
      uploaded: true,
    });
  } catch (err) {
    return json({ error: `Das Video konnte nicht ausgewertet werden: ${(err as Error).message}` }, 502);
  } finally {
    if (geminiFile) await deleteGeminiFile(key, geminiFile.name);
    await removeUpload();
  }
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
      throw new Error('Die Datei ist zu groß.');
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
    const body = await req.json();
    if (body.nutrition) return await estimateNutrition(body.nutrition);
    if (body.images) return await importPhotos(body.images);
    if (body.video) return await importUploadedVideo(req, body.video);
    if (body.text != null) return await importText(body.text);
    url = String(body.url ?? '').trim();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  if (!isAllowedUrl(url)) return json({ error: 'Bitte einen gültigen Link (https://…) eingeben.' }, 400);

  try {
    url = await resolveUrl(url);
  } catch {
    return json({ error: 'Der TikTok-Link konnte nicht aufgelöst werden.' }, 502);
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
