import { getLatestId } from '../lib/db.js';

const rows = document.querySelectorAll('.row');
const submenu = document.getElementById('submenu');
const progress = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const errorBox = document.getElementById('error');
const defaultAfter = document.getElementById('default-after');
const preloadScrolls = document.getElementById('preload-scrolls');
const stopBtn = document.getElementById('stop');

let openRow = null;

function setBusy(isBusy) {
  document.querySelectorAll('.main, .more, .chips button').forEach((b) => (b.disabled = isBusy));
  progress.hidden = !isBusy;
  if (isBusy) closeSubmenu();
  else stopBtn.hidden = true;
}

// Tombol berhenti hanya untuk "seluruh halaman". Saat memuat: lewati sisa pemuatan.
// Saat menangkap: berhenti dan susun bagian yang sudah ditangkap.
let stopPhase = null;
function setStopPhase(phase, stopping = false) {
  if (!phase) return;
  if (phase !== stopPhase) {
    stopPhase = phase;
    stopBtn.disabled = false;
  }
  stopBtn.hidden = false;
  stopBtn.textContent = phase === 'load' ? 'Lewati, tangkap sekarang' : 'Berhenti & simpan';
  if (stopping) {
    stopBtn.disabled = true;
    stopBtn.textContent = phase === 'load' ? 'Melewati…' : 'Menyusun gambar…';
  }
}

stopBtn.addEventListener('click', () => {
  setStopPhase(stopPhase, true);
  chrome.runtime.sendMessage({ type: 'fullsnap-stop' }).catch(() => {});
});

function showError(message) {
  setBusy(false);
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function start(mode, after) {
  errorBox.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (mode === 'full') {
    // Tampilkan progres sebelum pesan dikirim agar error cepat tidak tertimpa.
    setBusy(true);
    progressText.textContent = 'Menyiapkan halaman…';
  }
  await chrome.runtime.sendMessage({ type: 'fullsnap-start', mode, tabId: tab.id, after });
  // Area terlihat & pilihan: tutup popup agar tidak menghalangi halaman.
  if (mode !== 'full') window.close();
}

function closeSubmenu() {
  submenu.hidden = true;
  if (openRow) {
    openRow.classList.remove('open');
    openRow.querySelector('.more').setAttribute('aria-expanded', 'false');
  }
  openRow = null;
}

rows.forEach((row) => {
  // Klik baris = tangkap dengan aksi default (seperti menu aslinya).
  row.querySelector('.main').addEventListener('click', () => start(row.dataset.mode, defaultAfter.value));

  // Panah ▸ = buka pilihan "…lalu Edit / Simpan / Salin / Cetak".
  row.querySelector('.more').addEventListener('click', () => {
    if (openRow === row) return closeSubmenu();
    closeSubmenu();
    openRow = row;
    row.classList.add('open');
    row.querySelector('.more').setAttribute('aria-expanded', 'true');
    row.after(submenu);
    submenu.hidden = false;
  });
});

submenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-after]');
  if (btn && openRow) start(openRow.dataset.mode, btn.dataset.after);
});

document.getElementById('open-last').addEventListener('click', async () => {
  const id = await getLatestId().catch(() => null);
  if (!id) {
    errorBox.textContent = 'Belum ada tangkapan.';
    errorBox.hidden = false;
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${encodeURIComponent(id)}`) });
  window.close();
});

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

defaultAfter.addEventListener('change', () => {
  chrome.storage.local.set({ defaultAfter: defaultAfter.value });
});
preloadScrolls.addEventListener('change', () => {
  chrome.storage.local.set({ preloadScrolls: Number(preloadScrolls.value) });
});
chrome.storage.local.get({ defaultAfter: 'edit', preloadScrolls: 7 }).then((s) => {
  defaultAfter.value = s.defaultAfter;
  preloadScrolls.value = String(s.preloadScrolls);
  if (!preloadScrolls.value) preloadScrolls.value = '7';
});

// Tampilkan shortcut yang benar-benar terpasang (pengguna bisa mengubahnya).
chrome.commands.getAll().then((commands) => {
  const map = { 'capture-full': 'full', 'capture-visible': 'visible', 'capture-selection': 'selection' };
  for (const c of commands) {
    const row = document.querySelector(`.row[data-mode="${map[c.name]}"] kbd`);
    if (row) row.textContent = c.shortcut || '';
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'fullsnap-progress') {
    const pct = Math.round((msg.done / msg.total) * 100);
    progressText.textContent =
      msg.phase === 'load'
        ? `Menggulir untuk memuat konten (${msg.done}/${msg.total})…`
        : `Menangkap ${msg.done} dari ${msg.total} bagian…`;
    progressFill.style.width = `${pct}%`;
    if (stopBtn.disabled && msg.phase === stopPhase) return; // permintaan berhenti sedang diproses
    setStopPhase(msg.phase);
  } else if (msg.type === 'fullsnap-error') {
    showError(msg.message);
  } else if (msg.type === 'fullsnap-done') {
    window.close();
  }
});

chrome.runtime.sendMessage({ type: 'fullsnap-status' }).then((res) => {
  if (res?.busy) {
    setBusy(true);
    progressText.textContent = 'Sedang menangkap…';
    setStopPhase(res.phase, res.stopping);
  }
});
