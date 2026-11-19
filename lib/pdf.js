// Penulis PDF minimal: setiap halaman berisi satu gambar JPEG (DCTDecode).
// Tanpa library eksternal (ekstensi MV3 tidak boleh memuat kode dari CDN).

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};
const PX_TO_PT = 0.75; // 96 dpi → 72 pt per inci
const MAX_PAGE_PT = 14400; // batas ukuran halaman PDF

/**
 * @param {HTMLCanvasElement} canvas  gambar akhir
 * @param {object} opts
 * @param {'a4'|'letter'|'single'} opts.pageSize
 * @param {number} opts.pixelRatio  piksel gambar per piksel CSS (untuk ukuran fisik yang wajar)
 * @param {number} [opts.quality]
 * @param {string} [opts.title]
 * @returns {Promise<Blob>}
 */
export async function canvasToPdf(canvas, { pageSize = 'a4', pixelRatio = 1, quality = 0.9, title = '' } = {}) {
  const W = canvas.width;
  const H = canvas.height;
  const pages = [];

  if (pageSize === 'single') {
    // Satu halaman panjang seukuran halaman web (dipecah jika melebihi batas PDF).
    const s = PX_TO_PT / pixelRatio;
    const pageW = W * s;
    const sliceH = Math.floor(MAX_PAGE_PT / s);
    for (let y = 0; y < H; y += sliceH) {
      const h = Math.min(sliceH, H - y);
      pages.push({ y, h, pageW, pageH: h * s, scale: s, margin: 0 });
    }
  } else {
    const [pageW, pageH] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    const margin = 24;
    const s = (pageW - margin * 2) / W;
    const sliceH = Math.max(1, Math.floor((pageH - margin * 2) / s));
    for (let y = 0; y < H; y += sliceH) {
      pages.push({ y, h: Math.min(sliceH, H - y), pageW, pageH, scale: s, margin });
    }
  }

  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  for (const p of pages) {
    tmp.width = W;
    tmp.height = p.h;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, W, p.h);
    tctx.drawImage(canvas, 0, p.y, W, p.h, 0, 0, W, p.h);
    const blob = await new Promise((r) => tmp.toBlob(r, 'image/jpeg', quality));
    p.jpeg = new Uint8Array(await blob.arrayBuffer());
    p.imgW = W;
    p.imgH = p.h;
  }
  tmp.width = tmp.height = 0;

  return new Blob([buildPdf(pages, title)], { type: 'application/pdf' });
}

function buildPdf(pages, title) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;

  const write = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObj = (num) => {
    offsets[num] = length;
    write(`${num} 0 obj\n`);
  };
  const n = (v) => (Math.round(v * 100) / 100).toString();

  // Nomor objek: 1 Catalog, 2 Pages, 3 Info, lalu per halaman: Page, Contents, Image.
  const pageObj = (i) => 4 + i * 3;
  const totalObjs = 4 + pages.length * 3;

  write('%PDF-1.4\n%âãÏÓ\n');

  beginObj(1);
  write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObj(2);
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  beginObj(3);
  write(`<< /Title ${pdfString(title)} /Producer (FullSnap) >>\nendobj\n`);

  pages.forEach((p, i) => {
    const pid = pageObj(i);
    const drawW = p.imgW * p.scale;
    const drawH = p.imgH * p.scale;
    const x = p.margin;
    const y = p.pageH - p.margin - drawH; // rapat ke atas halaman

    beginObj(pid);
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.pageW)} ${n(p.pageH)}] ` +
        `/Resources << /XObject << /Im0 ${pid + 2} 0 R >> >> /Contents ${pid + 1} 0 R >>\nendobj\n`
    );

    const content = `q ${n(drawW)} 0 0 ${n(drawH)} ${n(x)} ${n(y)} cm /Im0 Do Q`;
    beginObj(pid + 1);
    write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    beginObj(pid + 2);
    write(
      `<< /Type /XObject /Subtype /Image /Width ${p.imgW} /Height ${p.imgH} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    );
    write(p.jpeg);
    write('\nendstream\nendobj\n');
  });

  const xrefAt = length;
  let xref = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjs; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(`trailer\n<< /Size ${totalObjs} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// String PDF sebagai UTF-16BE heksadesimal agar judul non-ASCII tetap benar.
function pdfString(str) {
  let hex = 'FEFF';
  for (const ch of String(str).slice(0, 300)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}
