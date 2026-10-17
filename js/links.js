// Macht Links in freiem Text (z. B. Notizen) anklickbar. Liefert sicheres HTML: alles
// außer den Links wird maskiert, und es entstehen nur http(s)-Links.

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function linkify(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    // Satzzeichen am Ende gehören meist zum Satz, nicht zum Link; schließende Klammer nur ohne öffnende.
    for (;;) {
      const end = url.at(-1);
      if (/[.,;:!?…"'»“]/.test(end) || (end === ')' && !url.includes('('))) url = url.slice(0, -1);
      else break;
    }
    let href;
    try {
      href = new URL(/^www\./i.test(url) ? `https://${url}` : url).href;
    } catch {
      continue;
    }
    out += escapeHtml(s.slice(last, m.index));
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeHtml(s.slice(last));
}
