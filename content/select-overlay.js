// Overlay untuk memilih area layar dengan menyeret mouse.
(() => {
  if (window.__fullsnapSelecting) return;
  window.__fullsnapSelecting = true;

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(15, 23, 42, 0.35);
               user-select: none; -webkit-user-select: none; }
      .layer.dragging { background: transparent; }
      .box { position: fixed; display: none; border: 1.5px solid #3b82f6;
             box-shadow: 0 0 0 100vmax rgba(15, 23, 42, 0.45); pointer-events: none; }
      .size { position: absolute; left: 0; top: -26px; padding: 3px 7px; border-radius: 4px;
              background: #1e293b; color: #fff; font: 12px/1.3 system-ui, sans-serif; white-space: nowrap; }
      .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px;
              border-radius: 8px; background: #1e293b; color: #f8fafc; font: 13px/1.4 system-ui, sans-serif;
              box-shadow: 0 4px 16px rgba(0,0,0,.3); pointer-events: none; }
      .hint b { color: #93c5fd; font-weight: 600; }
    </style>
    <div class="layer"></div>
    <div class="box"><span class="size"></span></div>
    <div class="hint">Seret untuk memilih area · <b>Esc</b> untuk batal</div>`;
  document.documentElement.appendChild(host);

  const layer = root.querySelector('.layer');
  const box = root.querySelector('.box');
  const sizeLabel = root.querySelector('.size');
  const hint = root.querySelector('.hint');

  let start = null;
  let rect = null;

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    delete window.__fullsnapSelecting;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId); // tetap terima event walau mouse keluar jendela
    start = { x: e.clientX, y: e.clientY };
    rect = { x: start.x, y: start.y, w: 0, h: 0 };
    layer.classList.add('dragging');
    box.style.display = 'block';
    hint.style.display = 'none';
    update();
  });

  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight));
    rect = {
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      w: Math.abs(x - start.x),
      h: Math.abs(y - start.y),
    };
    update();
  });

  layer.addEventListener('pointerup', async () => {
    if (!start) return;
    const selected = rect;
    start = null;
    if (!selected || selected.w < 5 || selected.h < 5) {
      // klik tanpa seret → batal memilih, kembali ke mode awal
      layer.classList.remove('dragging');
      box.style.display = 'none';
      hint.style.display = 'block';
      return;
    }
    cleanup();
    // Tunggu overlay benar-benar hilang dari layar sebelum ditangkap.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 60));
    chrome.runtime.sendMessage({ type: 'fullsnap-region', rect: selected, viewWidth: window.innerWidth }).catch(() => {});
  });

  function update() {
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.w}px`;
    box.style.height = `${rect.h}px`;
    sizeLabel.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    sizeLabel.style.top = rect.y < 30 ? '4px' : '-26px';
    sizeLabel.style.left = rect.y < 30 ? '4px' : '0';
  }

  window.addEventListener('keydown', onKey, true);
})();
