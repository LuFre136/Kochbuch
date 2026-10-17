// Videos von YouTube (auch Shorts) und TikTok: Links erkennen, einbetten und
// Zeitstempel bei den Zubereitungsschritten verwalten.

// Erkennt einen Video-Link und liefert { provider, id, vertical? } oder null (vertical: Hochformat wie Shorts und TikTok).
export function parseVideoUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const path = u.pathname;
  const ytId = (s) => (/^[\w-]{11}$/.test(s ?? '') ? s : null);
  if (host === 'youtu.be') {
    const id = ytId(path.split('/')[1]);
    return id && { provider: 'youtube', id };
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const m = path.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    const id = ytId(m ? m[2] : path === '/watch' ? u.searchParams.get('v') : null);
    if (!id) return null;
    return m?.[1] === 'shorts' ? { provider: 'youtube', id, vertical: true } : { provider: 'youtube', id };
  }
  if (host === 'tiktok.com') {
    const m = path.match(/\/(?:video|v)\/(\d{8,25})/) || path.match(/^\/player\/v1\/(\d{8,25})/);
    return m && { provider: 'tiktok', id: m[1], vertical: true };
  }
  return null;
}

// Erster Video-Link unter den Quellen eines Rezepts.
export function videoOf(sources) {
  for (const s of sources ?? []) {
    const v = parseVideoUrl(s);
    if (v) return v;
  }
  return null;
}

export function embedUrl(video, origin) {
  if (video.provider === 'youtube') {
    const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0' });
    if (origin) params.set('origin', origin);
    return `https://www.youtube-nocookie.com/embed/${video.id}?${params}`;
  }
  return `https://www.tiktok.com/player/v1/${video.id}?rel=0&description=0&music_info=0`;
}

// Springt im eingebetteten Player an eine Stelle und startet die Wiedergabe.
export function seekTo(iframe, video, seconds) {
  const win = iframe?.contentWindow;
  if (!win) return;
  if (video.provider === 'youtube') {
    const send = (func, args = []) => win.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
    send('seekTo', [seconds, true]);
    send('playVideo');
  } else {
    const send = (type, value) => win.postMessage({ type, value, 'x-tiktok-player': true }, '*');
    send('seekTo', seconds);
    send('play');
  }
}

// Ein Schritt ist entweder ein Text (alte Rezepte) oder { text, t } mit Sekunden im Video.
export const stepText = (s) => (typeof s === 'string' ? s : String(s?.text ?? ''));
export function stepTime(s) {
  const t = typeof s === 'object' && s && s.t != null && s.t !== '' ? Number(s.t) : NaN;
  return Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
}
export const makeStep = (text, t) => (t == null ? text : { text, t });

export function formatTime(seconds) {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// "2:15", "1:02:03" oder "135" in Sekunden; leer oder ungültig → null.
export function parseTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return null;
  return s.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}
