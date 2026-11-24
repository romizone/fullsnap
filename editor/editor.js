import { getCapture } from '../lib/db.js';
import { canvasToPdf } from '../lib/pdf.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const stage = $('stage');
const wrap = $('wrap');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const textInput = $('text-input');
const colorInput = $('color');
const sizeInput = $('size');

let meta = null;
let base = null; // ImageBitmap | HTMLCanvasElement – gambar dasar tanpa anotasi
let ops = []; // anotasi di atas gambar dasar
let baseStep = 0; // nomor langkah terakhir yang sudah "dipanggang" ke gambar dasar (setelah crop)
let undoStack = [];
let redoStack = [];

let tool = 'hand';
let zoom = 1; // piksel layar per piksel gambar
let k = 1; // piksel gambar per piksel CSS halaman asli (devicePixelRatio saat menangkap)
let drag = null;
let cropRect = null;
let textPos = null;
const settings = { askLocation: false };

wrap.hidden = true;
init();

// ---------------------------------------------------------------------------
// Memuat tangkapan
// ---------------------------------------------------------------------------

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  try {
    const record = id ? await getCapture(id) : null;
    if (!record) throw new Error('Tangkapan tidak ditemukan. Mungkin sudah terhapus (hanya 15 tangkapan terakhir yang disimpan).');
    meta = record;
    k = record.scale || 1;
    base = await createImageBitmap(record.blob);
  } catch (err) {
    $('status').textContent = err.message;
    return;
  }

  $('status').hidden = true;
  wrap.hidden = false;
  document.title = `FullSnap – ${meta.title || 'Screenshot'}`;

  const link = $('page-link');
  link.textContent = meta.title || meta.url;
  if (/^(https?|file):/i.test(meta.url)) link.href = meta.url;
  link.title = meta.url;
  const notes = [];
  if (meta.truncated) notes.push('Halaman sangat panjang – hanya sebagian yang ditangkap.');
  if (meta.stopped) notes.push('Penangkapan dihentikan – hanya bagian yang sudah ditangkap.');
  if (meta.failed) notes.push(`Penangkapan terputus (${meta.failed}) – hanya bagian yang sudah ditangkap.`);
  if (meta.downscaled) notes.push('Gambar diperkecil agar muat batas ukuran browser.');
  $('notice').textContent = notes.join(' ');

  try {
    Object.assign(settings, await chrome.storage.local.get({ askLocation: false }));
  } catch {}
  $('ask-location').checked = settings.askLocation;

  fullRender();
  fitZoom();
  runRequestedAction();
}

// Aksi yang dipilih di popup ("…lalu Simpan gambar / PDF / Salin / Cetak").
function runRequestedAction() {
  const action = new URLSearchParams(location.search).get('do');
  // Hapus parameter agar me-refresh halaman tidak mengulang aksi.
  if (action) history.replaceState(null, '', location.pathname + `?id=${encodeURIComponent(meta.id)}`);
  if (action === 'image') save('png');
  else if (action === 'pdf') save('pdf-a4');
  else if (action === 'copy') copyImage();
  else if (action === 'print') printImage();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function fullRender() {
  if (canvas.width !== base.width || canvas.height !== base.height) {
    canvas.width = base.width;
    canvas.height = base.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  for (const op of ops) drawOp(ctx, op);
  overlay.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  $('dims').textContent = `${canvas.width} × ${canvas.height} px`;
  applyZoom();
  updateHistoryButtons();
}

function drawOp(c, op) {
  c.save();
  switch (op.type) {
    case 'rect':
      c.strokeStyle = op.color;
      c.lineWidth = op.width;
      c.lineJoin = 'round';
      c.strokeRect(op.x, op.y, op.w, op.h);
      break;
    case 'arrow': {
      const g = arrowGeometry(op.x1, op.y1, op.x2, op.y2, op.width);
      c.strokeStyle = c.fillStyle = op.color;
      c.lineWidth = op.width;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(g.x1, g.y1);
      c.lineTo(g.bx, g.by);
      c.stroke();
      c.beginPath();
      c.moveTo(...g.head[0]);
      c.lineTo(...g.head[1]);
      c.lineTo(...g.head[2]);
      c.closePath();
      c.fill();
      break;
    }
    case 'pen':
      c.strokeStyle = op.color;
      c.lineWidth = op.width;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      op.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      if (op.points.length === 1) c.lineTo(op.points[0][0] + 0.01, op.points[0][1]);
      c.stroke();
      break;
    case 'ellipse':
      c.strokeStyle = op.color;
      c.lineWidth = op.width;
      c.beginPath();
      c.ellipse(op.x + op.w / 2, op.y + op.h / 2, op.w / 2, op.h / 2, 0, 0, Math.PI * 2);
      c.stroke();
      break;
    case 'step':
      drawStep(c, op);
      break;
    case 'highlight':
      c.globalAlpha = 0.4;
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = op.color;
      c.fillRect(op.x, op.y, op.w, op.h);
      break;
    case 'text':
      drawText(c, op);
      break;
    case 'blur':
      pixelate(c, op);
      break;
  }
  c.restore();
}

function drawText(c, op) {
  c.font = `600 ${op.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.textBaseline = 'top';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, op.size * 0.16);
  c.strokeStyle = isDark(op.color) ? 'rgba(255,255,255,.92)' : 'rgba(15,23,42,.8)';
  c.fillStyle = op.color;
  const lineHeight = op.size * 1.25;
  op.text.split('\n').forEach((line, i) => {
    const y = op.y + i * lineHeight + op.size * 0.125;
    c.strokeText(line, op.x, y);
    c.fillText(line, op.x, y);
  });
}

// Lingkaran bernomor (1, 2, 3…) untuk menandai urutan langkah.
function drawStep(c, op) {
  c.beginPath();
  c.arc(op.x, op.y, op.r, 0, Math.PI * 2);
  c.fillStyle = op.color;
  c.shadowColor = 'rgba(0,0,0,.35)';
  c.shadowBlur = op.r * 0.35;
  c.shadowOffsetY = op.r * 0.08;
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = Math.max(1.5, op.r * 0.12);
  c.strokeStyle = '#fff';
  c.stroke();
  c.fillStyle = isDark(op.color) ? '#fff' : '#0f172a';
  c.font = `700 ${op.r * (op.n > 9 ? 0.95 : 1.15)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(op.n), op.x, op.y + op.r * 0.05);
}

function maxStep() {
  return ops.reduce((m, op) => (op.type === 'step' ? Math.max(m, op.n) : m), baseStep);
}

function pixelate(c, op) {
  const x = Math.max(0, Math.round(op.x));
  const y = Math.max(0, Math.round(op.y));
  const w = Math.min(c.canvas.width - x, Math.round(op.w));
  const h = Math.min(c.canvas.height - y, Math.round(op.h));
  if (w < 1 || h < 1) return;
  const block = Math.max(3, op.block);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const sctx = small.getContext('2d');
  sctx.drawImage(c.canvas, x, y, w, h, 0, 0, small.width, small.height);
  c.imageSmoothingEnabled = false;
  c.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
}

function arrowGeometry(x1, y1, x2, y2, width) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const head = Math.min(len * 0.6, Math.max(12, width * 4.5));
  const spread = Math.PI / 7;
  return {
    x1, y1,
    bx: x2 - head * 0.75 * Math.cos(angle),
    by: y2 - head * 0.75 * Math.sin(angle),
    head: [
      [x2, y2],
      [x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread)],
      [x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread)],
    ],
  };
}

function isDark(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

// ---------------------------------------------------------------------------
// Riwayat (urungkan / ulangi)
// ---------------------------------------------------------------------------

function snapshot() {
  return { base, ops: ops.slice(), baseStep };
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}

function commitOp(op) {
  pushUndo();
  ops.push(op);
  drawOp(ctx, op);
  updateHistoryButtons();
}

function undo() {
  commitText();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  ({ base, ops, baseStep } = undoStack.pop());
  cancelCrop();
  fullRender();
}

function redo() {
  commitText();
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  ({ base, ops, baseStep } = redoStack.pop());
  cancelCrop();
  fullRender();
}

function updateHistoryButtons() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}

// ---------------------------------------------------------------------------
// Alat & interaksi pointer
// ---------------------------------------------------------------------------

function setTool(next) {
  commitText();
  if (next !== 'crop') cancelCrop();
  tool = next;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
  stage.className = `tool-${next}`;
}

document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

const strokeWidth = () => Number(sizeInput.value) * k;
const fontSize = () => (Number(sizeInput.value) * 4 + 10) * k;

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / zoom, 0, canvas.width),
    y: clamp((e.clientY - r.top) / zoom, 0, canvas.height),
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

wrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target === textInput) return;
  if (!textInput.hidden) {
    commitText();
    if (tool === 'text') return; // klik di luar kotak teks hanya menyelesaikan teks
  }
  const p = toImage(e);
  e.preventDefault();

  if (tool === 'hand') {
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add('panning');
  } else if (tool === 'text') {
    openText(p);
    return;
  } else if (tool === 'step') {
    const r = (Number(sizeInput.value) * 1.5 + 11) * k;
    commitOp({ type: 'step', x: p.x, y: p.y, r, n: maxStep() + 1, color: colorInput.value });
    return;
  } else {
    if (tool === 'crop') cancelCrop();
    drag = { type: tool, start: p, cur: p, points: [[p.x, p.y]] };
  }
  wrap.setPointerCapture(e.pointerId);
});

wrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.type === 'pan') {
    stage.scrollLeft = drag.left - (e.clientX - drag.sx);
    stage.scrollTop = drag.top - (e.clientY - drag.sy);
    return;
  }
  drag.cur = toImage(e);
  if (drag.type === 'pen') {
    const [lx, ly] = drag.points[drag.points.length - 1];
    if (Math.hypot(drag.cur.x - lx, drag.cur.y - ly) >= 2 / zoom) drag.points.push([drag.cur.x, drag.cur.y]);
  }
  drawPreview();
});

wrap.addEventListener('pointerup', finishDrag);
wrap.addEventListener('pointercancel', finishDrag);

function finishDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  stage.classList.remove('panning');
  if (d.type === 'pan') return;
  overlay.replaceChildren();

  const color = colorInput.value;
  const width = strokeWidth();
  const r = rectFrom(d.start, d.cur);
  const big = r.w >= 3 && r.h >= 3;

  switch (d.type) {
    case 'crop':
      if (big) showCrop(r);
      break;
    case 'rect':
      if (big) commitOp({ type: 'rect', ...r, color, width });
      break;
    case 'ellipse':
      if (big) commitOp({ type: 'ellipse', ...r, color, width });
      break;
    case 'highlight':
      if (big) commitOp({ type: 'highlight', ...r, color });
      break;
    case 'blur':
      if (big) commitOp({ type: 'blur', ...r, block: Number(sizeInput.value) * 2.5 * k });
      break;
    case 'arrow':
      if (Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y) >= 6)
        commitOp({ type: 'arrow', x1: d.start.x, y1: d.start.y, x2: d.cur.x, y2: d.cur.y, color, width });
      break;
    case 'pen':
      commitOp({ type: 'pen', points: d.points, color, width });
      break;
  }
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  overlay.appendChild(el);
  return el;
}

function drawPreview() {
  overlay.replaceChildren();
  const d = drag;
  const color = colorInput.value;
  const width = strokeWidth();
  const r = rectFrom(d.start, d.cur);
  switch (d.type) {
    case 'rect':
      svg('rect', { ...rectAttrs(r), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' });
      break;
    case 'ellipse':
      svg('ellipse', { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2, fill: 'none', stroke: color, 'stroke-width': width });
      break;
    case 'highlight':
      svg('rect', { ...rectAttrs(r), fill: color, 'fill-opacity': 0.4 });
      break;
    case 'blur':
      svg('rect', {
        ...rectAttrs(r), fill: 'rgba(100,116,139,.35)', stroke: '#fff', 'stroke-width': 1.5,
        'stroke-dasharray': '5 4', 'vector-effect': 'non-scaling-stroke',
      });
      break;
    case 'crop':
      drawCropMask(r);
      break;
    case 'arrow': {
      const g = arrowGeometry(d.start.x, d.start.y, d.cur.x, d.cur.y, width);
      svg('line', { x1: g.x1, y1: g.y1, x2: g.bx, y2: g.by, stroke: color, 'stroke-width': width, 'stroke-linecap': 'round' });
      svg('polygon', { points: g.head.map((p) => p.join(',')).join(' '), fill: color });
      break;
    }
    case 'pen':
      svg('polyline', {
        points: d.points.map((p) => p.join(',')).join(' '), fill: 'none', stroke: color,
        'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      });
      break;
  }
}

const rectAttrs = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

function drawCropMask(r) {
  const W = canvas.width, H = canvas.height;
  svg('path', {
    d: `M0 0H${W}V${H}H0Z M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`,
    fill: 'rgba(2,6,23,.55)', 'fill-rule': 'evenodd',
  });
  svg('rect', {
    ...rectAttrs(r), fill: 'none', stroke: '#fff', 'stroke-width': 1.5,
    'stroke-dasharray': '6 4', 'vector-effect': 'non-scaling-stroke',
  });
}

function showCrop(r) {
  cropRect = {
    x: Math.round(r.x), y: Math.round(r.y),
    w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)),
  };
  overlay.replaceChildren();
  drawCropMask(cropRect);
  $('crop-size').textContent = `${cropRect.w} × ${cropRect.h} px`;
  $('crop-bar').hidden = false;
}

function cancelCrop() {
  if (!cropRect) return;
  cropRect = null;
  overlay.replaceChildren();
  $('crop-bar').hidden = true;
}

function applyCrop() {
  if (!cropRect) return;
  const r = cropRect;
  const out = document.createElement('canvas');
  out.width = r.w;
  out.height = r.h;
  out.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  pushUndo();
  baseStep = maxStep(); // nomor berikutnya tetap berlanjut setelah crop
  base = out;
  ops = [];
  cancelCrop();
  fullRender();
  fitZoom();
  toast('Gambar dipotong');
}

$('crop-apply').addEventListener('click', applyCrop);
$('crop-cancel').addEventListener('click', cancelCrop);

// ---------------------------------------------------------------------------
// Teks
// ---------------------------------------------------------------------------

function openText(p) {
  textPos = p;
  textInput.value = '';
  textInput.hidden = false;
  textInput.style.color = colorInput.value;
  positionTextInput();
  textInput.focus({ preventScroll: true });
}

function positionTextInput() {
  if (textInput.hidden || !textPos) return;
  textInput.style.left = `${textPos.x * zoom}px`;
  textInput.style.top = `${textPos.y * zoom}px`;
  textInput.style.fontSize = `${fontSize() * zoom}px`;
  autosizeText();
}

function autosizeText() {
  textInput.style.width = '0px';
  textInput.style.height = '0px';
  textInput.style.width = `${Math.max(40, textInput.scrollWidth + 8)}px`;
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function commitText() {
  if (textInput.hidden) return;
  const text = textInput.value.replace(/\s+$/, '');
  textInput.hidden = true;
  if (text) commitOp({ type: 'text', x: textPos.x, y: textPos.y, text, color: colorInput.value, size: fontSize() });
  textPos = null;
}

textInput.addEventListener('input', autosizeText);
textInput.addEventListener('blur', commitText);
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitText();
  } else if (e.key === 'Escape') {
    textInput.value = '';
    commitText();
  }
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function applyZoom() {
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
  $('zoom-label').textContent = `${Math.round(zoom * k * 100)}%`;
  positionTextInput();
}

function fitZoom() {
  const available = stage.clientWidth - 48;
  zoom = Math.min(1 / k, available / canvas.width);
  applyZoom();
}

function setZoom(next, anchorX, anchorY) {
  next = clamp(next, 0.05 / k, 8 / k);
  const rect = stage.getBoundingClientRect();
  const ax = anchorX ?? rect.left + stage.clientWidth / 2;
  const ay = anchorY ?? rect.top + stage.clientHeight / 2;
  const cr = canvas.getBoundingClientRect();
  const ix = (ax - cr.left) / zoom;
  const iy = (ay - cr.top) / zoom;
  zoom = next;
  applyZoom();
  const nr = canvas.getBoundingClientRect();
  stage.scrollLeft += nr.left + ix * zoom - ax;
  stage.scrollTop += nr.top + iy * zoom - ay;
}

$('zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('zoom-label').addEventListener('click', () => {
  const fit = Math.min(1 / k, (stage.clientWidth - 48) / canvas.width);
  if (Math.abs(zoom - fit) < 1e-6) setZoom(1 / k);
  else fitZoom();
});
stage.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || !base) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Ekspor: simpan, salin, cetak
// ---------------------------------------------------------------------------

function canvasBlob(type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal membuat gambar.'))), type, quality)
  );
}

function fileBaseName() {
  const title = (meta.title || 'screenshot')
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || 'screenshot';
  const d = new Date(meta.time);
  const p = (n) => String(n).padStart(2, '0');
  return `${title} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

async function save(kind) {
  if (!base) return;
  commitText();
  closeMenu();
  toast('Menyiapkan file…', 0);
  try {
    let blob;
    let ext;
    if (kind === 'png') {
      blob = await canvasBlob('image/png');
      ext = 'png';
    } else if (kind === 'jpg') {
      blob = await canvasBlob('image/jpeg', 0.92);
      ext = 'jpg';
    } else {
      blob = await canvasToPdf(canvas, { pageSize: kind.replace('pdf-', ''), pixelRatio: k, title: meta.title });
      ext = 'pdf';
    }
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    try {
      await chrome.downloads.download({ url, filename: `${fileBaseName()}.${ext}`, saveAs: settings.askLocation });
      toast(settings.askLocation ? 'File disimpan' : 'File disimpan ke folder Unduhan');
    } catch (err) {
      if (/cancel/i.test(String(err?.message))) {
        toast('Penyimpanan dibatalkan');
        return;
      }
      // Cadangan jika API downloads gagal.
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBaseName()}.${ext}`;
      a.click();
      toast('File diunduh');
    }
  } catch (err) {
    console.error(err);
    toast(`Gagal menyimpan: ${err.message}`);
  }
}

async function copyImage() {
  if (!base) return;
  commitText();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob('image/png') })]);
    toast('Gambar disalin ke clipboard');
  } catch (err) {
    console.error(err);
    toast('Belum tersalin. Klik tombol Salin untuk menyalin gambar.');
  }
}

async function printImage() {
  if (!base) return;
  commitText();
  toast('Menyiapkan cetak…', 0);
  const area = $('print-area');
  area.replaceChildren();
  // Potong per halaman agar gambar panjang tidak terpotong di printer.
  const W = canvas.width;
  const sliceH = Math.floor(W * (277 / 190)); // area cetak A4 dengan margin 10 mm
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  const urls = [];
  for (let y = 0; y < canvas.height; y += sliceH) {
    const h = Math.min(sliceH, canvas.height - y);
    tmp.width = W;
    tmp.height = h;
    tctx.drawImage(canvas, 0, y, W, h, 0, 0, W, h);
    const blob = await new Promise((r) => tmp.toBlob(r, 'image/png'));
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const img = new Image();
    img.src = url;
    area.appendChild(img);
  }
  await Promise.all([...area.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  hideToast();
  window.addEventListener(
    'afterprint',
    () => {
      area.replaceChildren();
      urls.forEach(URL.revokeObjectURL);
    },
    { once: true }
  );
  window.print();
}

$('copy').addEventListener('click', copyImage);
$('print').addEventListener('click', printImage);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

// Tombol simpan (data-save) & menu dropdown format (data-menu)
function closeMenu() {
  document.querySelectorAll('.menu').forEach((m) => (m.hidden = true));
  document.querySelectorAll('[data-menu]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.querySelector('.actionbar').addEventListener('click', (e) => {
  const caret = e.target.closest('[data-menu]');
  if (caret) {
    e.stopPropagation();
    const menu = $(caret.dataset.menu);
    const willOpen = menu.hidden;
    closeMenu();
    menu.hidden = !willOpen;
    caret.setAttribute('aria-expanded', String(willOpen));
    return;
  }
  const kind = e.target.closest('[data-save]')?.dataset.save;
  if (kind) {
    e.stopPropagation();
    save(kind);
  }
});
document.addEventListener('click', closeMenu);
$('ask-location').addEventListener('change', (e) => {
  settings.askLocation = e.target.checked;
  chrome.storage.local.set({ askLocation: settings.askLocation }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const TOOL_KEYS = {
  v: 'hand', c: 'crop', r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', h: 'highlight', t: 'text', n: 'step', b: 'blur',
};

document.addEventListener('keydown', (e) => {
  if (e.target === textInput || e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;

  if (mod) {
    if (key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (key === 'y') {
      e.preventDefault();
      redo();
    } else if (key === 's') {
      e.preventDefault();
      save('png');
    } else if (key === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault();
      copyImage();
    } else if (key === 'p') {
      e.preventDefault();
      printImage();
    } else if (key === '=' || key === '+') {
      e.preventDefault();
      setZoom(zoom * 1.25);
    } else if (key === '-') {
      e.preventDefault();
      setZoom(zoom / 1.25);
    } else if (key === '0') {
      e.preventDefault();
      fitZoom();
    }
    return;
  }
  if (e.altKey) return;

  if (e.key === 'Enter' && cropRect) {
    e.preventDefault();
    applyCrop();
  } else if (e.key === 'Escape') {
    cancelCrop();
    closeMenu();
  } else if (TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(message, duration = 2400) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (duration) toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
  $('toast').classList.remove('show');
}
