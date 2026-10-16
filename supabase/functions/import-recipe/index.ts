// Supabase Edge Function "import-recipe".
// Lädt eine Rezeptseite serverseitig (im Browser verhindert CORS das) und liest die
// strukturierten Rezeptdaten (schema.org/Recipe als JSON-LD) aus, die fast alle großen
// Rezeptseiten wie Chefkoch, Lecker oder Essen & Trinken mitliefern.
//
// Aufruf aus der App: supabase.functions.invoke('import-recipe', { body: { url } })
// Antwort: { title, description, tags, servings, total_minutes, cook_minutes,
//            ingredients: string[], steps: string[], notes, source, image } (image als data:-URL)

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
        if (node.name && types(node).includes('HowToSection')) out.push(`${cleanText(node.name)}:`);
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
