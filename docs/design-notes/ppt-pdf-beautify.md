Berdasarkan `readme.md` (tech-reference) terbaru, arsitektur Anda sudah melakukan loncatan besar dengan mengadopsi **HTML-first path** menggunakan Gotenberg Chromium. Ini adalah fondasi yang sempurna karena Chromium mampu merender CSS modern (Grid, Flexbox, Glassmorphism, Web Fonts) yang mustahil dilakukan oleh `python-pptx`.

Namun, masalah "monoton" terjadi karena **LLM masih diperlakukan sebagai "pengisi teks" ke dalam 7 template statis**, dan **tema "navy+gold" di-hardcode**. 

Untuk membuat slide terasa dinamis, premium, dan bervariasi, kita harus mengubah paradigma dari *Template-Filling* menjadi **Component-Based Design & Dynamic Theming**.

Berikut adalah usulan perbaikan komprehensif yang dibagi menjadi 3 pilar:

---

### **Pilar 1: HTML Generation to Slide (Memperluas "Kanvas" Desain)**
Karena Gotenberg menggunakan Chromium, Anda bisa menggunakan teknik web modern. Jangan batasi LLM dengan 7 class statis.

**1. Implementasi CSS Utility-First & CSS Variables (Theming Dinamis)**
*   **Masalah:** "navy+gold" di-hardcode. Semua slide terlihat seperti laporan keuangan tahun 2010.
*   **Solusi:** Buat sistem tema menggunakan CSS Variables (`--primary`, `--accent`, `--bg-gradient`). 
*   **Aksi:** Definisikan 4-5 tema di CSS (misal: `theme-corporate` (navy/gold), `theme-tech` (dark mode/neon), `theme-creative` (pastel/gradients), `theme-minimal` (white/black/accent)).
*   **Eksekusi:** LLM akan menambahkan class tema di root slide: `<section class="slide theme-tech layout-split">`.

**2. Integrasi Icon Font & Web Fonts (Via CDN di `<head>`)**
*   **Masalah:** Slide hanya berisi teks dan bentuk geometris kaku.
*   **Solusi:** Inject CDN untuk **Bootstrap Icons** atau **FontAwesome**, serta **Google Fonts** (seperti *Plus Jakarta Sans* atau *Inter*) langsung di dalam `<head>` HTML yang di-generate LLM.
*   **Eksekusi:** LLM bisa langsung menulis `<i class="bi bi-rocket-fill text-accent"></i>` di dalam HTML. Chromium akan merendernya dengan sempurna.

**3. Layout Matrix (Pengganti 7 Template Kaku)**
Hapus template kaku. Ganti dengan **Layout Classes** yang bisa diisi komponen apa saja:
*   `.layout-hero` (Full background image/gradient + big title)
*   `.layout-split-left` / `.layout-split-right` (Kiri gambar/ikon, kanan teks)
*   `.layout-bento-3` / `.layout-bento-4` (Grid kotak-kotak modern ala Apple/Stripe)
*   `.layout-timeline-horizontal` / `.layout-timeline-vertical`
*   `.layout-quote-mega` (Typography besar dengan background blur/glassmorphism)

**4. Dynamic Visual Assets (Unsplash / SVG Patterns)**
*   Instruksikan LLM untuk menyisipkan gambar dari `source.unsplash.com` atau SVG pattern abstrak sebagai background.
*   Contoh: `<div class="bg-cover" style="background-image: url('https://source.unsplash.com/1280x720/?corporate,technology')">`

---

### **Pilar 2: Prompt Engineering (Menjadikan LLM sebagai "Art Director")**
Prompt saat ini terlalu fokus pada struktur teks. Prompt harus diubah untuk memaksa LLM memikirkan **komposisi visual**.

**1. Role & Persona Upgrade**
*   *Old:* "You are an expert presentation designer..."
*   *New:* "You are an elite Presentation Art Director (ex-Apple/Stripe). Your goal is to create visually stunning, highly dynamic slides. NEVER use the same layout twice in a row. Match the visual theme to the content's tone."

**2. Layout Selection Matrix (Aturan Ketat Variasi)**
Berikan matriks keputusan di dalam prompt agar LLM tidak malas:
```text
[LAYOUT RULES]
- If comparing 2 concepts -> USE `.layout-split`
- If showing 3-4 metrics/features -> USE `.layout-bento`
- If explaining a process -> USE `.layout-timeline`
- If introducing a topic -> USE `.layout-hero` with a relevant Unsplash background.
- NEVER use `.layout-content` (standard bullets) more than once in the entire deck. Force visual variety.
```

**3. Theme Auto-Selection**
Instruksikan LLM untuk memilih tema berdasarkan konteks dokumen:
```text
[THEME SELECTION]
Analyze the document tone and select ONE theme class for the whole deck:
- Financial/Legal/Formal -> `theme-corporate`
- Tech/Software/Startup -> `theme-tech` (Dark mode)
- Marketing/Creative -> `theme-creative` (Gradients)
- Default -> `theme-minimal`
Apply this theme to the first slide, and it will cascade.
```

**4. Few-Shot Prompting dengan HTML Visual (Sangat Penting)**
Jangan hanya berikan contoh JSON atau HTML teks. Berikan contoh HTML yang *sudah jadi* dengan styling lengkap di dalam prompt (sebagai few-shot).
*Contoh di prompt:*
```html
<!-- EXAMPLE OF BENTO LAYOUT (DO NOT COPY EXACTLY, USE AS INSPIRATION) -->
<section class="slide theme-tech layout-bento-3">
  <div class="bento-card glassmorphism">
    <i class="bi bi-shield-lock icon-xl text-neon-blue"></i>
    <h3 class="mt-4">Zero Trust Security</h3>
    <p class="text-muted">End-to-end encryption...</p>
  </div>
  <!-- 2 other cards -->
</section>
```

---

### **Pilar 3: Output Generation & Validation (Quality Gate)**
Karena LLM sekarang memiliki kebebasan lebih, validasi harus diperketat agar tidak menghasilkan HTML yang "pecah" di Chromium.

**1. HTML Pre-processing & Sanitasi (Node.js)**
Sebelum dikirim ke Gotenberg, lakukan sanitasi di `pptx-generator.service.ts`:
*   Pastikan `<head>` selalu di-inject dengan CDN Tailwind/Bootstrap Icons/Google Fonts (jika LLM lupa atau untuk menghemat token output LLM, lebih baik Node.js yang inject `<head>` secara otomatis, LLM hanya output `<body>`).
*   **Sangat Disarankan:** Biarkan LLM hanya mengoutput `<body>` (isi slide), lalu Node.js membungkusnya dengan `<html><head>...CDNs & Base CSS...</head><body>...</body></html>`. Ini menghemat ribuan token output LLM dan menjamin CSS selalu konsisten.

**2. Validasi Layout Diversity**
Tambahkan validasi deterministik di Node.js setelah LLM output HTML:
*   Parse HTML menggunakan `cheerio`.
*   Hitung penggunaan class layout (`.layout-split`, `.layout-bento`, dll).
*   Jika ada layout yang digunakan > 2 kali dalam satu deck, **trigger retry** dengan pesan spesifik: *"Validation failed: You used '.layout-content' 4 times. You must vary your layouts. Regenerate slides 3, 4, and 5 using '.layout-bento' or '.layout-split'."*

**3. Gotenberg Rendering Tweaks**
*   Pastikan viewport di-set dengan benar di HTML: `<meta name="viewport" content="width=1280, height=720">`.
*   Gunakan Gotenberg endpoint `/forms/chromium/screenshot/html` dengan parameter `emulatedMediaType=screen` dan set custom window size jika memungkinkan, untuk memastikan CSS media queries tidak merusak layout.

---

### **Referensi GitHub untuk Inspirasi Desain (HTML/CSS to Slides)**

Untuk melihat bagaimana HTML/CSS dieksekusi dengan indah untuk presentasi, bedah repo berikut:

1.  **`slidevjs/slidev`** (`https://github.com/slidevjs/slidev`)
    *   *Fokus:* Ini adalah rajanya HTML-to-Slides.
    *   *Yang dicuri:* Lihat folder `packages/create/template/` atau tema-tema komunitasnya. Pelajari bagaimana mereka menggunakan **UnoCSS / Tailwind** dan **Vue components** untuk membuat layout yang sangat dinamis (Bento grid, layout split). Anda bisa meniru struktur CSS class mereka.
2.  **`marp-team/marp`** (`https://github.com/marp-team/marp`)
    *   *Fokus:* Markdown/HTML to PDF/PPTX.
    *   *Yang dicuri:* Pelajari file `themes/` mereka. Perhatikan bagaimana mereka menggunakan `@theme` dan CSS variables untuk membuat tema yang bisa di-switch dengan satu class.
3.  **`presenton/presenton`** (`https://github.com/presenton/presenton`)
    *   *Fokus:* AI Presentation Generator.
    *   *Yang dicuri:* Lihat bagaimana mereka memetakan *intent* ke *layout*. Mereka memiliki sistem di mana LLM tidak hanya output teks, tapi memilih "Template ID" yang sudah di-design sebelumnya. (Meskipun Anda menggunakan HTML-first, logika pemilihan layout mereka sangat layak diadopsi ke dalam Prompt).
4.  **`antfu/iciba` atau repo yang menggunakan `shadcn/ui`**
    *   *Fokus:* Modern UI components.
    *   *Yang dicuri:* Konsep **Glassmorphism**, **Subtle Shadows**, dan **Typography Scale**. Gunakan CSS dari `shadcn/ui` (yang berbasis Tailwind) sebagai base design system Anda di dalam `<head>` HTML. Ini akan membuat slide terlihat seperti aplikasi SaaS modern, bukan PPT kaku.
