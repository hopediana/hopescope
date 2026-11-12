// Shared local cursor. Each document tracks its own mouse without cross-frame messages.
(() => {
  'use strict';
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const markup = "<div id=\"ladybug-pointer\" aria-hidden=\"true\" hidden><svg viewBox=\"0 0 60 76\"><g transform=\"rotate(-24 30 38)\"><g stroke=\"#f0e5c9\" stroke-width=\"6\" stroke-linecap=\"round\"><g transform=\"translate(18 27)\"><path class=\"bug-leg phase-a\" d=\"M0 0L-10 -7\"/></g><g transform=\"translate(17 41)\"><path class=\"bug-leg phase-b\" d=\"M0 0L-12 2\"/></g><g transform=\"translate(21 55)\"><path class=\"bug-leg phase-a\" d=\"M0 0L-11 9\"/></g><g transform=\"translate(42 27)\"><path class=\"bug-leg phase-b\" d=\"M0 0L10 -7\"/></g><g transform=\"translate(43 41)\"><path class=\"bug-leg phase-a\" d=\"M0 0L12 2\"/></g><g transform=\"translate(39 55)\"><path class=\"bug-leg phase-b\" d=\"M0 0L11 9\"/></g></g><g fill=\"none\" stroke=\"#192030\" stroke-width=\"2.5\" stroke-linecap=\"round\"><g transform=\"translate(18 27)\"><path class=\"bug-leg phase-a\" d=\"M0 0L-10 -7\"/></g><g transform=\"translate(17 41)\"><path class=\"bug-leg phase-b\" d=\"M0 0L-12 2\"/></g><g transform=\"translate(21 55)\"><path class=\"bug-leg phase-a\" d=\"M0 0L-11 9\"/></g><g transform=\"translate(42 27)\"><path class=\"bug-leg phase-b\" d=\"M0 0L10 -7\"/></g><g transform=\"translate(43 41)\"><path class=\"bug-leg phase-a\" d=\"M0 0L12 2\"/></g><g transform=\"translate(39 55)\"><path class=\"bug-leg phase-b\" d=\"M0 0L11 9\"/></g><path d=\"M24 15 19 7m17 8 5-8\"/></g><ellipse cx=\"30\" cy=\"23\" rx=\"12\" ry=\"15\" fill=\"#192030\"/><ellipse cx=\"30\" cy=\"45\" rx=\"22\" ry=\"27\" fill=\"#a83442\" stroke=\"#f0e5c9\" stroke-width=\"2\"/><path d=\"M30 20v51\" stroke=\"#192030\" stroke-width=\"2\"/><g fill=\"#192030\"><circle cx=\"19\" cy=\"34\" r=\"4\"/><circle cx=\"41\" cy=\"34\" r=\"4\"/><circle cx=\"18\" cy=\"50\" r=\"4\"/><circle cx=\"42\" cy=\"50\" r=\"4\"/><circle cx=\"25\" cy=\"62\" r=\"3\"/><circle cx=\"37\" cy=\"63\" r=\"3\"/></g></g></svg></div>";
  let pointer = document.querySelector('#ladybug-pointer');
  if (!pointer) {
    document.body.insertAdjacentHTML('beforeend', markup);
    pointer = document.querySelector('#ladybug-pointer');
  }
  let frame = 0, idleTimer = 0, lastMove = 0, point = null, visible = false;
  function positionInDialog() {
    const dialogs = document.querySelectorAll('dialog[open]');
    const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    if (pointer.parentElement !== host) host.append(pointer);
  }
  function stopWalking() {
    idleTimer = 0;
    const remaining = 130 - (performance.now() - lastMove);
    if (visible && remaining > 0) idleTimer = setTimeout(stopWalking, remaining);
    else pointer.classList.remove('walking');
  }
  function hide() {
    if (frame) cancelAnimationFrame(frame);
    if (idleTimer) clearTimeout(idleTimer);
    frame = idleTimer = 0;
    point = null;
    visible = false;
    pointer.hidden = true;
    pointer.classList.remove('walking');
    root.classList.remove('custom-cursor');
  }
  function paint() {
    frame = 0;
    if (!point) return;
    // A transform write only: no frame geometry reads or synthetic pointer events.
    pointer.style.transform = `translate3d(${point.x - 5.93}px, ${point.y - 3.86}px, 0)`;
    if (!visible) {
      visible = true;
      pointer.hidden = false;
      root.classList.add('custom-cursor');
    }
    if (!reduced.matches) {
      pointer.classList.add('walking');
      if (!idleTimer) idleTimer = setTimeout(stopWalking, 130);
    }
  }
  window.addEventListener('pointermove', event => {
    if (!fine.matches || event.pointerType !== 'mouse') { hide(); return; }
    point = {x:event.clientX, y:event.clientY};
    lastMove = performance.now();
    if (!frame) frame = requestAnimationFrame(paint);
  }, {passive:true});
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget || event.relatedTarget.tagName === 'IFRAME') hide();
  });
  // Hand off to the iframe's own cursor instead of leaving the parent cursor visible.
  document.querySelectorAll('iframe').forEach(frame => frame.addEventListener('pointerenter', hide));
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  fine.addEventListener?.('change', hide);
  reduced.addEventListener?.('change', () => pointer.classList.remove('walking'));
  if ('MutationObserver' in window) {
    new MutationObserver(positionInDialog).observe(document.documentElement, {subtree:true,attributes:true,attributeFilter:['open']});
  }
  // Inactive tabs do not retain a cursor at their previous mouse position.
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.origin === location.origin && event.data?.type === 'hopescope-cursor-hide') hide();
  });
  positionInDialog();
})();
