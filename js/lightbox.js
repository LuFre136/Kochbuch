// Bilder im Vollbild: wischen zum Blättern, mit zwei Fingern oder Doppeltippen vergrößern,
// nach unten ziehen, X oder Tippen neben das Bild zum Schließen. Am Rechner gibt es Pfeile,
// die Pfeiltasten und Esc.
//
// Die Gesten laufen über Pointer Events mit touch-action: none, damit Safari auf dem
// iPhone weder die Seite zoomt noch dahinter scrollt.

const MAX_SCALE = 5;
const TAP_ZOOM = 2.5;

// onClose bekommt die Nummer des zuletzt gezeigten Bildes.
export function openLightbox(urls, start = 0, { onClose } = {}) {
  if (!urls.length) return null;
  let index = Math.max(0, Math.min(urls.length - 1, start));
  const multi = urls.length > 1;

  const dialog = document.createElement('dialog');
  dialog.className = 'lightbox';
  dialog.setAttribute('aria-label', 'Bild in groß');
  dialog.innerHTML = `
    <div class="lb-stage" tabindex="-1" autofocus>
      <div class="lb-track">${urls.map((u) => `<div class="lb-slide"><img src="${attr(u)}" alt="" draggable="false"></div>`).join('')}</div>
    </div>
    <div class="lb-bar">
      <button type="button" class="lb-btn lb-close" aria-label="Schließen">×</button>
      ${multi ? `<span class="lb-count" aria-live="polite"></span>` : ''}
    </div>
    ${multi ? `<button type="button" class="lb-btn lb-arrow lb-prev" aria-label="Vorheriges Bild">‹</button>
      <button type="button" class="lb-btn lb-arrow lb-next" aria-label="Nächstes Bild">›</button>` : ''}`;
  document.body.append(dialog);
  document.documentElement.classList.add('sheet-open');

  const stage = dialog.querySelector('.lb-stage');
  const track = dialog.querySelector('.lb-track');
  const imgs = [...dialog.querySelectorAll('.lb-slide img')];
  const count = dialog.querySelector('.lb-count');

  // Vergrößerung gilt nur für das aktuelle Bild; beim Blättern wird zurückgesetzt.
  let scale = 1, tx = 0, ty = 0;
  const width = () => stage.clientWidth;

  const applyZoom = (animate = false) => {
    const img = imgs[index];
    img.style.transition = animate ? 'transform 0.2s ease' : 'none';
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    dialog.classList.toggle('zoomed', scale > 1);
  };
  // Hält das vergrößerte Bild so, dass kein schwarzer Rand ins Bild gezogen werden kann.
  const clampPan = () => {
    const img = imgs[index];
    const maxX = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2);
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  };
  const resetZoom = (animate = false) => { scale = 1; tx = 0; ty = 0; applyZoom(animate); };
  // Vergrößert so, dass der Punkt (x, y) auf dem Bildschirm an seiner Stelle bleibt.
  const zoomAt = (newScale, x, y, from = { scale, tx, ty }) => {
    const r = stage.getBoundingClientRect();
    // Mitte des Bildes ohne Verschiebung (es steht mittig in der Fläche)
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const qx = (x - cx - from.tx) / from.scale, qy = (y - cy - from.ty) / from.scale;
    scale = Math.max(1, Math.min(MAX_SCALE, newScale));
    tx = x - cx - scale * qx;
    ty = y - cy - scale * qy;
    if (scale === 1) { tx = 0; ty = 0; }
  };

  const place = (dx = 0, animate = true) => {
    track.style.transition = animate ? 'transform 0.28s ease' : 'none';
    track.style.transform = `translateX(${-index * width() + dx}px)`;
  };
  const show = (i, animate = true) => {
    const next = Math.max(0, Math.min(urls.length - 1, i));
    if (next !== index) resetZoom();
    index = next;
    place(0, animate);
    if (count) count.textContent = `${index + 1} / ${urls.length}`;
    dialog.querySelector('.lb-prev')?.toggleAttribute('disabled', index === 0);
    dialog.querySelector('.lb-next')?.toggleAttribute('disabled', index === urls.length - 1);
  };

  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => {
    window.removeEventListener('resize', onResize);
    dialog.remove();
    if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
    onClose?.(index);
  });
  const onResize = () => { resetZoom(); place(0, false); };
  window.addEventListener('resize', onResize);

  dialog.querySelector('.lb-close').onclick = close;
  const prev = dialog.querySelector('.lb-prev');
  const next = dialog.querySelector('.lb-next');
  if (prev) prev.onclick = () => show(index - 1);
  if (next) next.onclick = () => show(index + 1);
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
  });
  // Safari zoomt sonst trotz touch-action mit eigenen Gesten-Ereignissen.
  for (const type of ['gesturestart', 'gesturechange']) stage.addEventListener(type, (e) => e.preventDefault());

  // ---- Gesten ----
  const pointers = new Map();
  let mode = null;           // 'tap' | 'swipe' | 'dismiss' | 'pan' | 'pinch'
  let startX = 0, startY = 0, startTime = 0, startTarget = null;
  let pinchStart = null;     // { dist, scale, tx, ty }
  let panStart = null;       // { x, y, tx, ty }
  let lastTap = null;        // { time, x, y }

  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const startPan = (p) => { mode = 'pan'; panStart = { x: p.x, y: p.y, tx, ty }; };

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // Zweiter Finger: Wischen abbrechen, ab jetzt wird vergrößert.
      if (mode === 'swipe') place(0);
      if (mode === 'dismiss') resetDismiss();
      const m = twoFinger();
      mode = 'pinch';
      pinchStart = { dist: m.dist, scale, tx, ty };
      return;
    }
    if (pointers.size > 2) return;
    startX = e.clientX; startY = e.clientY; startTime = e.timeStamp; startTarget = e.target;
    if (scale > 1) startPan({ x: e.clientX, y: e.clientY });
    else mode = 'tap';
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pointers.size >= 2) {
      const m = twoFinger();
      zoomAt(pinchStart.scale * (m.dist / pinchStart.dist), m.x, m.y, pinchStart);
      applyZoom();
      return;
    }
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (mode === 'tap' && Math.hypot(dx, dy) > 8) mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'dismiss';
    if (mode === 'swipe') {
      // Am ersten und letzten Bild gibt die Leiste nur ein Stück nach.
      const edge = (index === 0 && dx > 0) || (index === urls.length - 1 && dx < 0);
      place(edge ? dx / 3 : dx, false);
    } else if (mode === 'dismiss') {
      const down = Math.max(0, dy);
      stage.style.transition = 'none';
      stage.style.transform = `translateY(${down}px)`;
      dialog.style.setProperty('--lb-fade', String(Math.max(0.3, 1 - down / 400)));
    } else if (mode === 'pan') {
      tx = panStart.tx + (e.clientX - panStart.x);
      ty = panStart.ty + (e.clientY - panStart.y);
      clampPan();
      applyZoom();
    }
  });

  const resetDismiss = () => {
    stage.style.transition = 'transform 0.2s ease';
    stage.style.transform = '';
    dialog.style.removeProperty('--lb-fade');
  };

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const cancelled = e.type === 'pointercancel';
    if (mode === 'pinch') {
      if (pointers.size === 1) { startPan([...pointers.values()][0]); return; }
      if (pointers.size === 0) {
        if (scale < 1.05) resetZoom(true); else { clampPan(); applyZoom(true); }
        mode = null;
      }
      return;
    }
    if (pointers.size) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const dt = Math.max(1, e.timeStamp - startTime);
    if (mode === 'swipe') {
      const flick = Math.abs(dx) / dt > 0.5;
      if (!cancelled && (dx < -width() * 0.18 || (flick && dx < 0))) show(index + 1);
      else if (!cancelled && (dx > width() * 0.18 || (flick && dx > 0))) show(index - 1);
      else place(0);
    } else if (mode === 'dismiss') {
      if (!cancelled && (dy > 110 || (dy > 40 && dy / dt > 0.5))) close();
      else resetDismiss();
    } else if (mode === 'pan') {
      clampPan(); applyZoom(true);
      if (!cancelled && Math.hypot(dx, dy) < 8) tap(e);
    } else if (mode === 'tap' && !cancelled) {
      tap(e);
    }
    mode = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // Doppeltippen vergrößert (an der Stelle) oder setzt zurück. Einmal neben das Bild
  // tippen schließt; auf dem Bild selbst passiert nichts, damit Doppeltippen klappt.
  const tap = (e) => {
    const now = e.timeStamp;
    if (lastTap && now - lastTap.time < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = null;
      if (scale > 1) resetZoom(true);
      else { zoomAt(TAP_ZOOM, e.clientX, e.clientY); clampPan(); applyZoom(true); }
      return;
    }
    lastTap = { time: now, x: e.clientX, y: e.clientY };
    if (scale === 1 && !(startTarget instanceof HTMLImageElement)) close();
  };

  // Am Rechner: Mausrad mit Strg (oder Trackpad-Spreizen) vergrößert.
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAt(scale * Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
    clampPan();
    applyZoom();
  }, { passive: false });

  dialog.showModal();
  show(index, false);
  return dialog;
}

function attr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
