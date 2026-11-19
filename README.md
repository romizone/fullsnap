# FullSnap – Screenshot Seluruh Halaman

Ekstensi Chrome (Manifest V3) untuk menangkap layar halaman web, mirip FireShot.

## Fitur

- **Tangkap seluruh halaman**: menggulir otomatis lalu menggabungkan semua bagian jadi satu gambar.
  - Header *sticky* hanya muncul sekali, elemen *fixed* (tombol chat, banner) tidak berulang.
  - Mendukung aplikasi web yang menggulir di dalam panel (bukan di body), mis. Gmail atau dashboard.
  - **Gulir dulu (muat konten)**: sebelum menangkap, halaman digulir ke dasar **dan** ke puncak beberapa kali
    (bawaan **7×**) agar konten tambahan ikut dimuat: feed/*infinite scroll* (memuat ke bawah) maupun chat seperti
    WhatsApp Web (pesan lama dimuat ke atas). Bisa diatur di popup: Mati / 3× / 7× / 15× / 30×.
    Arah yang tidak menambah konten berhenti dicoba otomatis.
  - Potongan disambung berdasarkan pergeseran isi yang diukur langsung (elemen penanda di layar), bukan perkiraan
    posisi gulir. Jadi urutan tetap benar dan tidak ada celah walau halaman berubah saat ditangkap
    (gambar baru termuat, pesan lama disisipkan, daftar virtual). Panel chat ditangkap dari bawah ke atas,
    dan label/tombol yang mengambang di atas panel disembunyikan.
- **Tangkap area terlihat**: hanya yang tampil di layar.
- **Tangkap area pilihan**: seret mouse untuk memilih area, `Esc` untuk batal.
- **Menu popup bergaya daftar**: klik baris untuk menangkap dengan aksi default, atau klik panah ▸
  untuk memilih **…lalu Edit / Simpan gambar / Simpan PDF / Salin / Cetak**.
  Aksi default bisa diatur di popup. Ada juga **Buka tangkapan terakhir**.
- **Editor**: potong (crop), kotak, elips, panah, pena, stabilo, teks, nomor langkah (1, 2, 3… otomatis),
  sensor/buramkan (pixelate), urungkan/ulangi, zoom.
- **Berhenti & simpan**: saat menangkap seluruh halaman, tombol di popup bisa melewati sisa pemuatan
  ("Lewati, tangkap sekarang") atau menghentikan tangkapan dan menyusun bagian yang sudah didapat.
- **Tombol aksi besar** di halaman hasil: Simpan gambar (PNG/JPG), Simpan PDF (A4, Letter, satu halaman panjang), Salin, Cetak.
- Akses dari popup, menu klik kanan, atau shortcut keyboard.

## Instalasi (mode developer)

0. Unduh kode: `git clone https://github.com/romizone/fullsnap.git` (atau **Code → Download ZIP** lalu ekstrak)
1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (pojok kanan atas)
3. Klik **Load unpacked**, pilih folder hasil unduhan (yang berisi `manifest.json`)
4. Sematkan (pin) ikon FullSnap di toolbar

Untuk menangkap file lokal (`file://`), buka detail ekstensi lalu aktifkan **Allow access to file URLs**.

## Shortcut

| Aksi | Shortcut |
| --- | --- |
| Seluruh halaman | `Alt+Shift+1` |
| Area terlihat | `Alt+Shift+2` |
| Area pilihan | `Alt+Shift+3` |

Ubah di `chrome://extensions/shortcuts`.

Di editor: `V` geser, `C` potong, `R` kotak, `O` elips, `A` panah, `P` pena, `H` stabilo, `T` teks,
`N` nomor langkah, `B` sensor,
`Ctrl/Cmd+Z` urungkan, `Ctrl/Cmd+S` simpan PNG, `Ctrl/Cmd+C` salin, `Ctrl/Cmd+scroll` zoom.

## Batasan

- Halaman bawaan browser (`chrome://`, Chrome Web Store) tidak bisa ditangkap. Ini aturan Chrome.
- Chrome membatasi tangkapan ±2 kali per detik, jadi halaman panjang butuh beberapa detik. Tetap di tab yang sama sampai selesai.
- "Gulir dulu" menambah ±3 detik pada halaman biasa (untuk memastikan tidak ada konten baru), dan ±2–3 detik per putaran pada halaman *infinite scroll*.
- Halaman yang sangat panjang dibatasi 150 layar. Jika gambar melebihi batas ukuran canvas browser (±32.000 px), hasilnya diperkecil otomatis.
- Hanya 15 tangkapan terakhir yang disimpan untuk dibuka ulang di editor.

## Struktur

```
manifest.json
background.js            service worker: alur tangkap, scroll & gabung gambar
content/page-helper.js   disuntikkan ke halaman: ukur, gulir, sembunyikan elemen fixed/sticky
content/select-overlay.js overlay pemilihan area
popup/                   UI popup
editor/                  editor anotasi & ekspor
lib/db.js                penyimpanan hasil di IndexedDB
lib/pdf.js               pembuat PDF tanpa library eksternal
icons/
```

## Lisensi

[MIT](LICENSE)
