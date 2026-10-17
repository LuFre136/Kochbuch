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

// Kurze, eindeutige Kennung eines Videos, z. B. "youtube:dQw4w9WgXcQ". Sie steht an den
// Schritten und passt auch, wenn derselbe Clip mal als Shorts- und mal als normaler Link
// in den Quellen steht.
export const videoKey = (video) => (video ? `${video.provider}:${video.id}` : null);

// Alle Videos unter den Quellen eines Rezepts, in der Reihenfolge der Quellen und ohne Doppelte.
export function videosOf(sources) {
  const found = [];
  for (const s of sources ?? []) {
    const v = parseVideoUrl(s);
    if (v && !found.some((x) => videoKey(x) === videoKey(v))) found.push({ ...v, key: videoKey(v) });
  }
  return found;
}

// Erstes Video unter den Quellen eines Rezepts.
export function videoOf(sources) {
  return videosOf(sources)[0] ?? null;
}

// start: Sekunde, ab der abgespielt wird. YouTube kann das über die Adresse, bei TikTok
// springt stattdessen seekTo, sobald der Player geladen ist.
export function embedUrl(video, origin, start = null) {
  if (video.provider === 'youtube') {
    const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0' });
    if (origin) params.set('origin', origin);
    if (start != null) { params.set('start', String(start)); params.set('autoplay', '1'); }
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

// Ein Schritt ist entweder ein Text (alte Rezepte) oder { text, t, v }: t = Sekunden im
// Video, v = Kennung des Videos. Alte Schritte ohne v gehören zum ersten Video.
export const stepText = (s) => (typeof s === 'string' ? s : String(s?.text ?? ''));
export function stepTime(s) {
  const t = typeof s === 'object' && s && s.t != null && s.t !== '' ? Number(s.t) : NaN;
  return Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
}
export const makeStep = (text, t, v = null) => {
  if (t == null) return text;
  return v ? { text, t, v } : { text, t };
};

// Das Video, in dem der Zeitstempel eines Schritts liegt. Ohne Angabe (alte Rezepte)
// das erste Video des Rezepts.
export function stepVideo(step, videos) {
  if (!videos.length || stepTime(step) == null) return null;
  const key = typeof step === 'object' && step ? step.v : null;
  return (key && videos.find((v) => v.key === key)) || (key ? null : videos[0]);
}

// Schritte, deren Video es nicht mehr gibt, verlieren ihren Zeitstempel.
export function dropMissingTimes(steps, videos) {
  let dropped = 0;
  const kept = steps.map((s) => {
    if (stepTime(s) == null || stepVideo(s, videos)) return s;
    dropped += 1;
    return stepText(s);
  });
  return { steps: kept, dropped };
}

export function formatTime(seconds) {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
