import { putCapture } from './lib/db.js';

// Chrome membatasi captureVisibleTab ± 2 kali per detik.
const CAPTURE_INTERVAL_MS = 550;
// Batas aman ukuran canvas Chrome. Batas luas dijaga jauh di bawah batas Chrome (±268 jt piksel):
// gambar disusun di service worker lalu dimuat ulang di editor, dan tiap salinan memakai 4 byte/piksel.
const MAX_CANVAS_DIM = 32000;
const MAX_CANVAS_AREA = 120_000_000;
// Batas jumlah potongan layar agar halaman "infinite scroll" tidak berjalan selamanya.
const MAX_TILES = 150;
const PAGE_TIMEOUT_MS = 20000;
// Harus sama dengan VERSION di content/page-helper.js.
const HELPER_VERSION = 9;
// Gulir awal untuk memuat konten "infinite scroll" / lazy-load sebelum menangkap.
const DEFAULT_PRELOAD_SCROLLS = 7;
const MAX_PRELOAD_SCROLLS = 50;

// Aksi setelah tangkap: edit | image | pdf | copy | print
const AFTER_ACTIONS = ['edit', 'image', 'pdf', 'copy', 'print'];

let busy = false;
let phase = null; // 'load' | 'capture' selama tangkapan seluruh halaman berjalan
// Tombol "Berhenti" di popup: saat memuat → lewati sisa pemuatan; saat menangkap → susun yang sudah ada.
let stopRequested = false;
let lastCaptureAt = 0;
const pendingSelectionAfter = new Map(); // tabId → aksi untuk mode area pilihan

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Entry points: popup, shortcut keyboard, menu klik kanan
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'frame', 'selection', 'link', 'image', 'video'];
    chrome.contextMenus.create({ id: 'fullsnap-root', title: 'FullSnap', contexts });
    chrome.contextMenus.create({ id: 'full', parentId: 'fullsnap-root', title: 'Tangkap seluruh halaman', contexts });
    chrome.contextMenus.create({ id: 'visible', parentId: 'fullsnap-root', title: 'Tangkap area terlihat', contexts });
    chrome.contextMenus.create({ id: 'selection', parentId: 'fullsnap-root', title: 'Tangkap area pilihan', contexts });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab) startCapture(info.menuItemId, tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = { 'capture-full': 'full', 'capture-visible': 'visible', 'capture-selection': 'selection' }[command];
  if (!mode) return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) startCapture(mode, tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'fullsnap-start') {
    chrome.tabs.get(msg.tabId).then((tab) => startCapture(msg.mode, tab, msg.after)).catch(reportError);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'fullsnap-status') {
    sendResponse({ busy, phase, stopping: stopRequested });
    return false;
  }
  if (msg?.type === 'fullsnap-stop') {
    if (busy && phase) stopRequested = true;
    sendResponse({ ok: busy });
    return false;
  }
  if (msg?.type === 'fullsnap-region' && sender.tab) {
    const after = pendingSelectionAfter.get(sender.tab.id) || 'edit';
    pendingSelectionAfter.delete(sender.tab.id);
    if (busy) notify('Masih memproses tangkapan sebelumnya. Pilih area lagi setelah selesai.');
    else runExclusive(sender.tab, () => captureRegion(sender.tab, msg.rect, msg.viewWidth), after);
    return false;
  }
  return false;
});

// ---------------------------------------------------------------------------

async function startCapture(mode, tab, after) {
  if (!AFTER_ACTIONS.includes(after)) {
    const stored = await chrome.storage.local.get({ defaultAfter: 'edit' }).catch(() => ({}));
    after = AFTER_ACTIONS.includes(stored.defaultAfter) ? stored.defaultAfter : 'edit';
  }
  if (busy) {
    notify('Masih memproses tangkapan sebelumnya, tunggu sebentar.');
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    notify('Halaman ini dilindungi browser (mis. chrome://, Chrome Web Store) dan tidak bisa ditangkap.');
    broadcast({ type: 'fullsnap-error', message: 'Halaman ini tidak bisa ditangkap.' });
    return;
  }
  if (mode === 'selection') {
    // Overlay pemilihan; hasilnya datang lewat pesan 'fullsnap-region'.
    pendingSelectionAfter.set(tab.id, after);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/select-overlay.js'] });
    } catch (err) {
      reportError(err);
    }
    return;
  }
  const task = mode === 'full' ? () => captureFullPage(tab) : () => captureVisibleArea(tab);
  runExclusive(tab, task, after);
}

async function runExclusive(tab, task, after = 'edit') {
  busy = true;
  stopRequested = false;
  try {
    const record = await task();
    if (record) {
      await putCapture(record);
      await chrome.tabs.create({
        // Untuk aksi selain 'edit', editor langsung menjalankannya setelah gambar dimuat.
        url: chrome.runtime.getURL(
          `editor/editor.html?id=${encodeURIComponent(record.id)}${after !== 'edit' ? `&do=${after}` : ''}`
        ),
        index: tab.index + 1,
        openerTabId: tab.id,
      });
    }
    broadcast({ type: 'fullsnap-done' });
  } catch (err) {
    reportError(err);
  } finally {
    busy = false;
    phase = null;
    stopRequested = false;
    setBadge(tab.id, '');
  }
}

// ---------------------------------------------------------------------------
// Mode tangkapan
// ---------------------------------------------------------------------------

async function captureVisibleArea(tab) {
  const bitmap = await dataUrlToBitmap(await captureTab(tab));
  const viewWidth = await runInPage(tab.id, () => window.innerWidth).catch(() => bitmap.width);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return makeRecord(tab, canvas, 'visible', canvas.width / (viewWidth || canvas.width));
}

async function captureRegion(tab, rect, viewWidth) {
  const bitmap = await dataUrlToBitmap(await captureTab(tab));
  const scale = bitmap.width / viewWidth;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale));
  if (sw < 1 || sh < 1) throw new Error('Area pilihan terlalu kecil.');
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return makeRecord(tab, canvas, 'selection', scale);
}

async function captureFullPage(tab) {
  await withTimeout(
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/page-helper.js'] }),
    PAGE_TIMEOUT_MS
  );

  try {
    // prepare() ada di dalam try agar halaman selalu dipulihkan meski gagal di tengah jalan.
    const prep = await runInPage(
      tab.id,
      (v) => window.__fullsnap?.version === v && window.__fullsnap.prepare(),
      [HELPER_VERSION] // fungsi disalin ke halaman, jadi konstanta harus dikirim sebagai argumen
    );
    if (!prep) {
      throw new Error('Versi FullSnap tidak cocok. Buka chrome://extensions, klik reload ↻ pada FullSnap, lalu refresh halaman ini.');
    }

    await preloadContent(tab);

    const info = await runInPage(tab.id, () => window.__fullsnap.measure());
    if (!info?.region) throw new Error('Tidak bisa membaca ukuran halaman. Refresh halaman ini lalu coba lagi.');
    const region = info.region;
    // Chat (konten lama dimuat di atas): tangkap dari bawah ke atas. Selain itu: dari atas ke bawah.
    const bottomFirst = info.anchor === 'bottom';
    const dir = bottomFirst ? -1 : 1;
    const xs = scrollSteps(info.totalWidth, region.w);
    const estTotal = Math.min(MAX_TILES, xs.length * Math.max(1, Math.ceil(info.totalHeight / region.h)));

    // Setiap potongan ditempatkan relatif terhadap potongan sebelumnya, dari pergeseran isi yang
    // diukur di halaman. Gambar baru disusun setelah semua potongan selesai.
    const tiles = []; // { blob, x, y } — x/y: posisi kiri-atas area tangkap dalam piksel CSS
    const edge = bottomFirst ? 'top' : 'bottom'; // penanda dipilih di tepi ke arah gulir
    let rowY = 0;
    let truncated = false;
    let stopped = false;
    phase = 'capture';
    stopRequested = false; // permintaan "lewati pemuatan" sudah dipakai
    await runInPage(tab.id, (fb) => window.__fullsnap.start(fb), [bottomFirst]);
    // Panel (mis. chat) atau tangkapan dari bawah: label/tombol mengambang disembunyikan sejak awal.
    // Halaman biasa: header fixed tetap tampil sekali di potongan pertama.
    if (info.mode === 'element' || bottomFirst) await runInPage(tab.id, () => window.__fullsnap.hideOverlays());

    // Galat di tengah jalan (tab berpindah, halaman dimuat ulang/tidak merespons): susun bagian
    // yang sudah ditangkap alih-alih membuang semuanya.
    let failed = null;
    let completeTiles = 0; // jumlah potongan sampai baris lengkap terakhir
    try {
      for (let row = 0; ; row++) {
        let atEnd = false;
        for (let i = 0; i < xs.length; i++) {
          if (xs.length > 1 && i > 0) await runInPage(tab.id, (px) => window.__fullsnap.setX(px), [xs[i]]);
          await waitCaptureSlot();
          // Ukur posisi tepat sebelum foto (hanya pada kolom pertama tiap baris).
          const f =
            i === 0 ? await runInPage(tab.id, (e, max) => window.__fullsnap.freeze(e, max), [edge, row > 0 ? region.h : 0]) : null;
          if (i === 0 && !f) throw new Error('Halaman berubah atau dimuat ulang saat ditangkap.');
          if (f) {
            if (row > 0) rowY -= f.moved;
            atEnd = f.atEnd;
          }
          const x = xs.length > 1 ? xs[i] : f.x;
          const blob = await (await fetch(await grabTab(tab))).blob();
          tiles.push({ blob, x: x + region.offX, y: rowY + region.offY });
          const done = tiles.length;
          setBadge(tab.id, `${Math.min(99, Math.round((done / Math.max(done, estTotal)) * 100))}%`);
          broadcast({ type: 'fullsnap-progress', phase: 'capture', done, total: Math.max(done, estTotal) });
        }
        completeTiles = tiles.length;
        // Dihentikan pengguna: berhenti di akhir baris agar tidak ada kolom yang kosong.
        if (stopRequested && !atEnd) {
          stopped = true;
          break;
        }
        // Berhenti di ujung halaman. Batas cadangan 1,3× tinggi terukur: konten bisa memanjang saat
        // ditangkap (gambar termuat), tapi halaman yang terus memuat konten baru tidak boleh tanpa akhir.
        const covered = Math.abs(rowY) + region.h;
        if (atEnd || covered >= info.totalHeight * 1.3) break;
        if (tiles.length + xs.length > MAX_TILES) {
          truncated = true;
          break;
        }
        if (xs.length > 1) await runInPage(tab.id, (px) => window.__fullsnap.setX(px), [xs[0]]);
        const next = await runInPage(
          tab.id,
          (d, amount, hide) => window.__fullsnap.scrollStep(d, amount, hide),
          [dir, region.h, true]
        );
        if (!next || Math.abs(next.moved) < 1) break; // tidak bisa bergulir lagi
      }
    } catch (err) {
      if (xs.length > 1) tiles.length = completeTiles; // buang baris yang kolomnya belum lengkap
      if (!tiles.length) throw err;
      failed = friendlyError(err);
      console.warn('[FullSnap] Tangkapan terputus, menyusun bagian yang sudah ada:', err);
    }

    // Susun gambar akhir.
    const minY = Math.min(...tiles.map((t) => t.y));
    const maxY = Math.max(...tiles.map((t) => t.y + region.h));
    const minX = Math.min(...tiles.map((t) => t.x));
    const maxX = Math.max(...tiles.map((t) => t.x + region.w));
    let canvas = null;
    let ctx = null;
    let scale = 1; // piksel gambar per piksel CSS
    let fit = 1; // pengecilan jika halaman melebihi batas canvas
    // Urutan gambar: potongan pertama digambar terakhir agar bagian yang tumpang tindih
    // memakai tangkapan paling awal (sebelum halaman sempat berubah).
    for (const t of [...tiles].reverse()) {
      const bitmap = await createImageBitmap(t.blob);
      if (!canvas) {
        scale = bitmap.width / info.viewWidth;
        const w = (maxX - minX) * scale;
        const h = (maxY - minY) * scale;
        fit = Math.min(1, MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
        canvas = new OffscreenCanvas(Math.max(1, Math.round(w * fit)), Math.max(1, Math.round(h * fit)));
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
      }
      const k = scale * fit;
      ctx.drawImage(
        bitmap,
        region.x * scale, region.y * scale, region.w * scale, region.h * scale,
        (t.x - minX) * k, (t.y - minY) * k, region.w * k, region.h * k
      );
      bitmap.close();
      t.blob = null;
    }

    return makeRecord(tab, canvas, 'full', scale * fit, { truncated, stopped, failed, downscaled: fit < 1 });
  } finally {
    await runInPage(tab.id, () => window.__fullsnap && window.__fullsnap.restore()).catch(() => {});
  }
}

// Gulir ke dasar & ke puncak halaman beberapa kali agar konten berikutnya ikut dimuat
// (feed ke bawah, chat ke atas). Berhenti lebih awal jika halaman tidak bertambah lagi.
async function preloadContent(tab) {
  const stored = await chrome.storage.local.get({ preloadScrolls: DEFAULT_PRELOAD_SCROLLS }).catch(() => ({}));
  const rounds = Math.max(0, Math.min(MAX_PRELOAD_SCROLLS, Number(stored.preloadScrolls) || 0));
  phase = 'load';
  for (let i = 1; i <= rounds; i++) {
    if (stopRequested) break; // pengguna memilih "Lewati, tangkap sekarang"
    setBadge(tab.id, `↕${i}`);
    broadcast({ type: 'fullsnap-progress', phase: 'load', done: i, total: rounds });
    const res = await runInPage(tab.id, () => window.__fullsnap.loadMore());
    if (!res || res.done) break;
  }
}

// Posisi scroll: 0, v, 2v, ... lalu posisi terakhir dirapatkan ke ujung.
function scrollSteps(total, view) {
  const steps = [0];
  if (total <= view + 1) return steps;
  for (let p = view; p < total - view; p += view) steps.push(Math.round(p));
  steps.push(Math.round(total - view));
  return steps;
}

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

async function captureTab(tab) {
  await waitCaptureSlot();
  return grabTab(tab);
}

// Tunggu sampai boleh memotret lagi (batas Chrome ± 2 kali per detik).
async function waitCaptureSlot() {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

async function grabTab(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) throw new Error('Tab berpindah saat menangkap layar. Tetap di tab yang sama sampai selesai.');
  for (let attempt = 0; ; attempt++) {
    try {
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
    } catch (err) {
      if (attempt < 3 && /MAX_CAPTURE|quota|rate/i.test(String(err?.message))) {
        await sleep(800);
        continue;
      }
      throw err;
    }
  }
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function runInPage(tabId, func, args = []) {
  const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func, args }), PAGE_TIMEOUT_MS);
  return res?.result;
}

// Mencegah proses macet selamanya (mis. halaman sedang menampilkan dialog alert()).
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Halaman tidak merespons. Tutup dialog yang terbuka lalu coba lagi.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function makeRecord(tab, canvas, mode, scale, extra = {}) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    title: tab.title || '',
    url: tab.url || '',
    mode,
    width: canvas.width,
    height: canvas.height,
    scale,
    blob,
    ...extra,
  };
}

function isRestrictedUrl(url = '') {
  return (
    /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|devtools|view-source|chrome-search):/i.test(url) ||
    /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)
  );
}

function setBadge(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function reportError(err) {
  const message = friendlyError(err);
  console.error('[FullSnap]', err);
  broadcast({ type: 'fullsnap-error', message });
  notify(message);
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/file:\/\//i.test(msg)) {
    return 'Untuk file lokal, aktifkan "Allow access to file URLs" untuk FullSnap di chrome://extensions.';
  }
  if (/Cannot access|cannot be scripted|extensions gallery/i.test(msg)) {
    return 'Halaman ini tidak mengizinkan ekstensi menangkap layar.';
  }
  if (/activeTab|all_urls|permission/i.test(msg)) {
    return 'Izin habis. Klik ikon FullSnap lagi di halaman ini lalu coba ulang.';
  }
  return msg;
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'FullSnap',
    message,
  }).catch(() => {});
}
