// Disuntikkan ke halaman saat "Tangkap seluruh halaman".
// Menyediakan window.__fullsnap: prepare() → loadMore() (opsional) → measure() → scrollTo() berulang → restore().
(() => {
  const VERSION = 7;
  if (window.__fullsnap) {
    if (window.__fullsnap.version === VERSION) return;
    // Sisa versi lama (ekstensi baru diperbarui): pulihkan halaman lalu ganti.
    try { window.__fullsnap.restore(); } catch (_) {}
    delete window.__fullsnap;
  }

  const STYLE_ID = '__fullsnap_style__';
  const SCROLLER_ATTR = 'data-fullsnap-scroller';
  const HIDDEN_ATTR = 'data-fullsnap-hidden';

  let state = null;

  // requestAnimationFrame berhenti saat tab/jendela tersembunyi; pakai timer cadangan agar tidak macet.
  const raf = () =>
    new Promise((r) => {
      const t = setTimeout(r, 100);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      });
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStyle(el, prop, value) {
    state.inline.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, 'important');
  }

  function scrollWindow(x, y) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  function scrollElement(el, x, y) {
    el.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  // Cari elemen yang benar-benar menggulir (untuk aplikasi web yang body-nya tidak scroll).
  function findInnerScroller() {
    const minArea = window.innerWidth * window.innerHeight * 0.2;
    let best = null;
    let bestArea = 0;
    // 'body' ikut dicek: banyak situs memakai html{overflow:hidden} body{overflow:auto}.
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 50) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (!/(auto|scroll|overlay)/.test(overflowY)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return bestArea >= minArea ? best : null;
  }

  function viewportSize() {
    const de = document.documentElement;
    const quirks = document.compatMode === 'BackCompat' && document.body;
    const w = (quirks ? document.body.clientWidth : de.clientWidth) || window.innerWidth;
    const h = (quirks ? document.body.clientHeight : de.clientHeight) || window.innerHeight;
    return { w: Math.min(w, window.innerWidth), h: Math.min(h, window.innerHeight) };
  }

  // Elemen 'sticky' diubah jadi 'static' (tampil sekali di posisi aslinya),
  // elemen 'fixed' disembunyikan setelah potongan pertama agar tidak berulang.
  function neutralizeSticky() {
    for (const el of document.querySelectorAll('body *')) {
      if (getComputedStyle(el).position === 'sticky') setStyle(el, 'position', 'static');
    }
  }

  // Elemen absolute di LUAR panel yang menimpa panel (mis. label tanggal mengambang di chat).
  function overlapsScroller(el) {
    const sc = state.scroller;
    if (!sc || sc.contains(el) || el.contains(sc)) return false;
    const a = el.getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    return a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Catat bagian halaman yang berubah sejak pemeriksaan terakhir, supaya hideFloating() tidak perlu
  // memeriksa gaya SEMUA elemen di setiap langkah gulir (lambat di halaman besar seperti Gmail).
  function queueMutations(records) {
    if (!state) return;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n.nodeType === 1) state.floatQueue.add(n);
      } else if (r.target === document.body || r.target === document.documentElement) {
        // Kelas di <html>/<body> bisa mengubah posisi elemen mana pun (mis. body.scrolled header {position:fixed}).
        state.floatFull = true;
      } else {
        state.floatQueue.add(r.target);
      }
    }
  }

  function hideFloating() {
    // Kumpulkan dulu, baru ubah: mengubah gaya di tengah loop memaksa hitung ulang CSS berkali-kali.
    const targets = [];
    const seen = new Set();
    const consider = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (el.hasAttribute(HIDDEN_ATTR)) return;
      if (state.scroller && el.contains(state.scroller)) return; // pembungkus panel
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky' || (pos === 'absolute' && overlapsScroller(el))) targets.push(el);
    };

    if (state.floatObserver) queueMutations(state.floatObserver.takeRecords());
    if (!state.floatObserver || state.floatFull) {
      // Pemeriksaan penuh: pertama kali, atau setelah kelas <html>/<body> berubah.
      for (const el of document.querySelectorAll('body *')) consider(el);
      state.floatFull = false;
      state.floatQueue.clear();
      if (!state.floatObserver) {
        state.floatObserver = new MutationObserver(queueMutations);
        state.floatObserver.observe(document.documentElement, {
          subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'],
        });
      }
    } else {
      // Hanya elemen yang baru ditambahkan atau berubah kelas/gaya, beserta isinya.
      for (const root of state.floatQueue) {
        if (!root.isConnected || !document.body?.contains(root)) continue;
        consider(root);
        for (const el of root.querySelectorAll('*')) consider(el);
      }
      state.floatQueue.clear();
    }

    for (const el of targets) {
      el.setAttribute(HIDDEN_ATTR, '');
      setStyle(el, 'visibility', 'hidden');
    }
    // Perubahan gaya buatan kita sendiri tidak perlu diperiksa ulang.
    state.floatObserver.takeRecords();
  }

  // Tinggi konten penggulir saat ini (untuk mendeteksi konten baru yang dimuat).
  function contentHeight() {
    const el = state.scroller;
    if (el) return el.scrollHeight;
    return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  }

  // Jarak scroll maksimum. Setelah mengukur, kembali ke atas — kecuali stayAtBottom
  // (halaman chat: kembali ke atas akan memicu pemuatan pesan lama).
  function measureMax(el, stayAtBottom = false) {
    if (el) {
      scrollElement(el, 1e7, 1e7);
      const m = { x: Math.max(0, el.scrollLeft), y: Math.max(0, el.scrollTop) };
      if (!stayAtBottom) scrollElement(el, 0, 0);
      return m;
    }
    scrollWindow(1e7, 1e7);
    const m = { x: Math.max(0, window.scrollX), y: Math.max(0, window.scrollY) };
    if (!stayAtBottom) scrollWindow(0, 0);
    return m;
  }

  async function waitForGrowth(before, waitMs) {
    for (let t = 0; t < waitMs; t += 150) {
      await sleep(150);
      if (contentHeight() > before + 4) {
        await sleep(400); // beri waktu konten baru selesai digambar
        return true;
      }
    }
    return false;
  }

  function currentY() {
    return state.scroller ? state.scroller.scrollTop : window.scrollY;
  }

  function scrollByY(d) {
    const el = state.scroller;
    if (el) scrollElement(el, el.scrollLeft, el.scrollTop + d);
    else scrollWindow(window.scrollX, window.scrollY + d);
  }

  async function settle(hide) {
    await raf();
    if (hide) hideFloating();
    await raf();
    await raf();
    await sleep(150); // beri waktu gambar lazy-load & animasi ringan
  }

  // Posisi gulir sekarang + apakah sudah di ujung arah gulir.
  function position(dir) {
    const el = state.scroller;
    const x = el ? el.scrollLeft : window.scrollX;
    const y = currentY();
    const max = el ? el.scrollHeight - el.clientHeight : contentHeight() - viewportSize().h;
    return { x, y, atEnd: dir < 0 ? y <= 0 : y >= max - 1 };
  }

  // Elemen penanda: ikut bergeser bersama isi (bukan fixed/sticky), cukup kecil
  // (bukan pembungkus seluruh daftar), dan berada di tepi layar ke arah gulir.
  function movesWithContent(node) {
    for (let n = node; n && n !== state.scroller && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return false;
    }
    return true;
  }

  function pickAnchor(edge) {
    const el = state.scroller;
    let top, bottom, left, right;
    if (el) {
      const r = el.getBoundingClientRect();
      top = Math.max(0, r.top + el.clientTop);
      bottom = Math.min(window.innerHeight, r.top + el.clientTop + el.clientHeight);
      left = Math.max(0, r.left + el.clientLeft);
      right = Math.min(window.innerWidth, r.left + el.clientLeft + el.clientWidth);
    } else {
      const v = viewportSize();
      top = 0; bottom = v.h; left = 0; right = v.w;
    }
    const h = bottom - top;
    const fys = edge === 'top' ? [0.06, 0.15, 0.3, 0.5, 0.7] : [0.94, 0.85, 0.7, 0.5, 0.3];
    const fxs = [0.5, 0.3, 0.7, 0.12, 0.88];
    for (const fy of fys) {
      for (const fx of fxs) {
        for (const c of document.elementsFromPoint(left + (right - left) * fx, top + h * fy)) {
          if (c === el || c === document.body || c === document.documentElement) continue;
          if (el && !el.contains(c)) continue;
          if (c.getBoundingClientRect().height > h * 1.5) continue;
          if (movesWithContent(c)) return c;
        }
      }
    }
    return null;
  }

  window.__fullsnap = {
    version: VERSION,
    // Langkah 1: pasang gaya & tentukan elemen yang digulir.
    prepare() {
      state = {
        x: window.scrollX, y: window.scrollY, inline: [], scroller: null, elScroll: null,
        floatObserver: null, floatQueue: new Set(), floatFull: false,
        // Arah pemuatan konten: 'down' = feed/infinite scroll, 'up' = chat (pesan lama dimuat di atas).
        dirs: { down: { active: true, grewOnce: false, idle: 0 }, up: { active: true, grewOnce: false, idle: 0 } },
      };

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        html, body, [${SCROLLER_ATTR}] { scroll-behavior: auto !important; scroll-snap-type: none !important; }
        html, [${SCROLLER_ATTR}] { scrollbar-width: none !important; }
        html::-webkit-scrollbar, body::-webkit-scrollbar, [${SCROLLER_ATTR}]::-webkit-scrollbar {
          display: none !important; width: 0 !important; height: 0 !important;
        }`;
      (document.head || document.documentElement).appendChild(style);

      // Ukur jarak scroll maksimum jendela secara langsung (paling andal).
      const view = viewportSize();
      const maxY = measureMax(null).y;

      // Jendela yang hanya bisa digulir sedikit (mis. 5px karena margin) bukan penggulir utama;
      // pada aplikasi web, konten sebenarnya ada di panel dalam.
      let inner = maxY > view.h * 0.25 ? null : findInnerScroller();
      if (inner && inner.scrollHeight - inner.clientHeight <= maxY) inner = null;

      if (inner) {
        state.scroller = inner;
        state.elScroll = { x: inner.scrollLeft, y: inner.scrollTop };
        // Panel yang awalnya berada di paling bawah (mis. chat WhatsApp di pesan terbaru)
        // biasanya memuat konten lama di atas → tangkap dari bawah.
        const fromBottom = inner.scrollHeight - inner.clientHeight - inner.scrollTop;
        state.startAtBottom = inner.scrollTop > 0 && fromBottom <= 20;
        inner.setAttribute(SCROLLER_ATTR, '');
      }
      return { mode: inner ? 'element' : 'window' };
    },

    // Langkah 2 (opsional, diulang): gulir ke dasar DAN ke puncak agar halaman "infinite scroll"
    // (feed) maupun chat (WhatsApp, Telegram: pesan lama dimuat saat digulir ke atas) memuat konten.
    // Arah yang tidak pernah menambah konten berhenti dicoba.
    async loadMore(waitMs = 1500) {
      const el = state.scroller;
      const go = (y) => (el ? scrollElement(el, 0, y) : scrollWindow(0, y));
      const maxScroll = () => (el ? el.scrollHeight - el.clientHeight : contentHeight() - window.innerHeight);
      let grew = false;
      for (const dir of ['down', 'up']) {
        const d = state.dirs[dir];
        if (!d.active) continue;
        const before = contentHeight();
        // Gerak kecil dulu lalu ke ujung: memicu ulang pemuat yang menunggu elemen
        // "masuk layar" (IntersectionObserver) atau event scroll.
        if (dir === 'down') go(Math.max(0, maxScroll() - window.innerHeight));
        else go(Math.min(window.innerHeight, Math.max(0, maxScroll())));
        await raf();
        go(dir === 'down' ? 1e7 : 0);
        if (await waitForGrowth(before, waitMs)) {
          d.grewOnce = true;
          d.idle = 0;
          grew = true;
        } else if (!d.grewOnce || ++d.idle >= 2) {
          // Tidak pernah bertambah → berhenti; pernah bertambah → 1 kesempatan lagi (koneksi lambat).
          d.active = false;
        }
      }
      return { grew, done: !state.dirs.down.active && !state.dirs.up.active };
    },

    // Langkah 3: ukur ukuran akhir & siapkan elemen sticky.
    measure() {
      const view = viewportSize();
      const inner = state.scroller;
      // Konten bertambah di atas (chat) → jahit dari bawah ke atas, posisi dihitung dari dasar.
      const anchor = state.dirs.up.grewOnce || state.startAtBottom ? 'bottom' : 'top';
      const atBottom = anchor === 'bottom';
      let result;
      if (inner) {
        const m = measureMax(inner, atBottom);
        const r = inner.getBoundingClientRect();
        const x = r.left + inner.clientLeft;
        const y = r.top + inner.clientTop;
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(window.innerWidth, x + inner.clientWidth);
        const y1 = Math.min(window.innerHeight, y + inner.clientHeight);
        result = {
          mode: 'element',
          totalWidth: inner.clientWidth + m.x,
          totalHeight: inner.clientHeight + m.y,
          region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, offX: x0 - x, offY: y0 - y },
        };
      } else {
        const m = measureMax(null, atBottom);
        result = {
          mode: 'window',
          totalWidth: view.w + m.x,
          totalHeight: view.h + m.y,
          region: { x: 0, y: 0, w: view.w, h: view.h, offX: 0, offY: 0 },
        };
      }

      neutralizeSticky();
      result.viewWidth = window.innerWidth;
      result.viewHeight = window.innerHeight;
      result.anchor = anchor;
      result.contentHeight = contentHeight();
      return result;
    },

    // Langkah 4: posisi awal tangkapan (atas, atau bawah untuk chat).
    async start(fromBottom) {
      const el = state.scroller;
      if (el) scrollElement(el, 0, fromBottom ? 1e7 : 0);
      else scrollWindow(0, fromBottom ? 1e7 : 0);
      await settle(false);
      return position(fromBottom ? -1 : 1);
    },

    // Geser horizontal (halaman yang lebih lebar dari layar).
    async setX(x) {
      const el = state.scroller;
      if (el) scrollElement(el, x, el.scrollTop);
      else scrollWindow(x, window.scrollY);
      await settle(false);
      return position(1);
    },

    // Langkah 5 (sesaat sebelum setiap foto): ukur seberapa jauh ISI bergeser sejak foto
    // sebelumnya, memakai elemen penanda yang dipilih saat foto sebelumnya. Lalu pilih penanda
    // baru di tepi layar ke arah gulir. Karena diukur tepat sebelum foto, perubahan halaman di
    // antara foto (gambar termuat, pesan lama disisipkan, daftar virtual) tetap terhitung.
    async freeze(edge, maxMove = 0) {
      const dir = edge === 'top' ? -1 : 1;
      const measure = () => {
        if (state.anchor && state.anchor.isConnected) return state.anchor.getBoundingClientRect().top - state.t0;
        if (state.anchor !== undefined) return -(currentY() - state.y0);
        return 0;
      };
      let moved = measure();
      // Isi bergeser lebih dari satu layar sejak foto sebelumnya (mis. gambar memanjang setelah
      // digulir) → gulir mundur dulu agar tidak ada bagian yang terlewat.
      for (let i = 0; i < 3 && maxMove && Math.abs(moved) > maxMove + 2; i++) {
        scrollByY(-dir * (Math.abs(moved) - maxMove));
        await settle(false);
        moved = measure();
      }
      state.anchor = pickAnchor(edge);
      state.t0 = state.anchor ? state.anchor.getBoundingClientRect().top : 0;
      state.y0 = currentY();
      return { ...position(dir), moved };
    },

    // Langkah 6: gulir satu layar ke atas (dir -1) atau ke bawah (dir 1).
    // Mengembalikan pergeseran isi sementara (positif = isi bergeser ke bawah).
    async scrollStep(dir, amount, hide) {
      const moved = () =>
        state.anchor && state.anchor.isConnected
          ? state.anchor.getBoundingClientRect().top - state.t0
          : -(currentY() - state.y0);
      scrollByY(dir * amount);
      await settle(hide);
      let m = moved();
      // Isi bergeser lebih jauh dari satu layar (mis. konten disisipkan) → mundur agar tidak ada celah.
      if (Math.abs(m) > amount + 2) {
        scrollByY(-dir * (Math.abs(m) - amount));
        await settle(false);
        m = moved();
      }
      return { moved: m };
    },

    // Sembunyikan elemen mengambang sekarang juga (dipakai untuk panel/chat sejak foto pertama).
    hideOverlays() {
      hideFloating();
      return true;
    },

    restore() {
      if (!state) return;
      state.floatObserver?.disconnect();
      for (let i = state.inline.length - 1; i >= 0; i--) {
        const { el, prop, value, priority } = state.inline[i];
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
      document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => el.removeAttribute(HIDDEN_ATTR));
      if (state.scroller) {
        state.scroller.removeAttribute(SCROLLER_ATTR);
        scrollElement(state.scroller, state.elScroll.x, state.elScroll.y);
      }
      document.getElementById(STYLE_ID)?.remove();
      scrollWindow(state.x, state.y);
      state = null;
      delete window.__fullsnap;
    },
  };
})();
