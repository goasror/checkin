// Builds the attendance PDF in the host's browser.
//
// Each A4 page is drawn on a canvas (photos, names, times), saved as a JPEG and wrapped in a
// minimal PDF. The browser draws the text, so names in any script come out right, and the photos
// are the same images the host page already shows.
//
//   const blob = await window.buildReport({ title, startedAt, count, entries: [{ name, time, photo }], note? });

(() => {
  'use strict';

  const W = 595.28; // A4 in points
  const H = 841.89;
  const SCALE = 2; // 144 dpi: sharp enough to print, small enough for 200 students
  const M = 40;
  const GAP = 20;
  const COL_W = (W - 2 * M - GAP) / 2;
  const CELL_H = 64;
  const PHOTO = 52;
  const FOOT = 28;
  const HEAD_FIRST = 76;
  const HEAD_NEXT = 34;

  const INK = '#0f172a';
  const MUTED = '#5b6475';
  const RULE = '#dfe3ec';
  const WARN = '#b54511';

  const FONT = "Manrope, system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
  const font = (weight, size) => `${weight} ${size}px ${FONT}`;

  const key = (name) => String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

  // Uzbek, reformed Latin alphabet (as the pages). Dates are numeric: the browser's Uzbek month and
  // weekday names use the old spelling, if it has any.
  const two = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
  const T = {
    title: 'Davomat',
    checkedIn: (n) => `${n} kişi qayd etildi`,
    dup: 'Bu ism bir neça marta işlatilgan',
    page: (n, of) => `Sahifa ${n} / ${of}`,
  };

  function fit(ctx, text, maxW) {
    let s = String(text);
    if (ctx.measureText(s).width <= maxW) return s;
    const chars = [...s];
    while (chars.length > 1 && ctx.measureText(chars.join('') + '…').width > maxW) chars.pop();
    return chars.join('') + '…';
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- layout ----------------------------------------------------------------

  function paginate(n) {
    const rowsFirst = Math.floor((H - M - HEAD_FIRST - FOOT - M) / CELL_H);
    const rowsNext = Math.floor((H - M - HEAD_NEXT - FOOT - M) / CELL_H);
    const pages = [];
    let i = 0;
    do {
      const per = (pages.length === 0 ? rowsFirst : rowsNext) * 2;
      pages.push([i, Math.min(n, i + per)]);
      i += per;
    } while (i < n);
    return pages;
  }

  function drawPage(ctx, { title, subtitle, entries, from, to, pageNo, pageCount, images, dupKeys }) {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    let top = M;
    if (pageNo === 1) {
      ctx.fillStyle = INK;
      ctx.font = font(800, 22);
      ctx.fillText(fit(ctx, title, W - 2 * M), M, top + 20);
      ctx.fillStyle = MUTED;
      ctx.font = font(500, 11);
      ctx.fillText(fit(ctx, subtitle, W - 2 * M), M, top + 42);
      top += HEAD_FIRST - 14;
    } else {
      ctx.fillStyle = MUTED;
      ctx.font = font(600, 10);
      ctx.fillText(fit(ctx, title, W - 2 * M), M, top + 10);
      top += HEAD_NEXT - 14;
    }
    ctx.fillStyle = RULE;
    ctx.fillRect(M, top, W - 2 * M, 1);
    top += 14;

    for (let i = from; i < to; i++) {
      const k = i - from;
      const col = k % 2;
      const row = Math.floor(k / 2);
      const x = M + col * (COL_W + GAP);
      const y = top + row * CELL_H;
      const e = entries[i];

      ctx.fillStyle = MUTED;
      ctx.font = font(600, 9);
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), x + 18, y + PHOTO / 2 + 3);
      ctx.textAlign = 'left';

      const px = x + 24;
      ctx.save();
      roundRect(ctx, px, y, PHOTO, PHOTO, 8);
      ctx.clip();
      const img = images[i];
      if (img) {
        // centre-crop to a square, in case a photo is not square
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, px, y, PHOTO, PHOTO);
      } else {
        ctx.fillStyle = RULE;
        ctx.fillRect(px, y, PHOTO, PHOTO);
      }
      ctx.restore();

      const tx = px + PHOTO + 10;
      const maxW = COL_W - 24 - PHOTO - 10;
      ctx.fillStyle = INK;
      ctx.font = font(700, 12.5);
      ctx.fillText(fit(ctx, e.name, maxW), tx, y + 15);
      ctx.fillStyle = MUTED;
      ctx.font = font(500, 10.5);
      const at = new Date(e.time);
      ctx.fillText(`${hhmm(at)}:${two(at.getSeconds())}`, tx, y + 31);
      if (dupKeys.has(key(e.name))) {
        ctx.fillStyle = WARN;
        ctx.font = font(700, 8);
        ctx.fillText(fit(ctx, T.dup, maxW), tx, y + 45);
      }
    }

    ctx.fillStyle = MUTED;
    ctx.font = font(500, 8.5);
    ctx.textAlign = 'right';
    ctx.fillText(T.page(pageNo, pageCount), W - M, H - M + 14);
    ctx.textAlign = 'left';
  }

  // ---- minimal PDF writer: one full-page JPEG per page -------------------------

  const enc = new TextEncoder();

  function pdfTitle(s) {
    // UTF-16BE hex string, so any script survives in the document title
    let hex = 'FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
      for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
    }
    return `<${hex}>`;
  }

  function writePdf(jpegs, { width, height, title }) {
    const parts = [];
    let offset = 0;
    const offsets = [];
    const push = (chunk) => {
      const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
      parts.push(bytes);
      offset += bytes.length;
    };
    const obj = (n, body, stream) => {
      offsets[n] = offset;
      push(`${n} 0 obj\n${body}\n`);
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    };

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

    const n = jpegs.length;
    const pageNo = (i) => 4 + i * 3; // page, contents, image for each page
    const kids = jpegs.map((_, i) => `${pageNo(i)} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
    obj(3, `<< /Title ${pdfTitle(title)} /Producer (Davomat) >>`);
    jpegs.forEach((jpg, i) => {
      const p = pageNo(i);
      const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
      obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`);
      obj(p + 1, `<< /Length ${enc.encode(content).length} >>`, enc.encode(content));
      obj(p + 2, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
    });

    const total = 3 + n * 3;
    const xref = offset;
    let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---- entry point -------------------------------------------------------------

  async function buildReport({ title, startedAt, count, entries, note }) {
    try {
      await Promise.all([800, 700, 600, 500].map((w) => document.fonts.load(font(w, 12))));
    } catch { /* fall back to system fonts */ }

    const counts = new Map();
    for (const e of entries) counts.set(key(e.name), (counts.get(key(e.name)) || 0) + 1);
    const dupKeys = new Set([...counts].filter(([, c]) => c > 1).map(([k]) => k));

    const images = await Promise.all(entries.map((e) => loadImage(e.photo)));
    const d = new Date(startedAt);
    const when = `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}, ${hhmm(d)}`;
    const heading = title || T.title;
    const subtitle = `${when}  ·  ${T.checkedIn(count)}${note ? `  ·  ${note}` : ''}`;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    const ctx = canvas.getContext('2d');

    const pages = paginate(entries.length);
    const jpegs = [];
    for (let p = 0; p < pages.length; p++) {
      const [from, to] = pages[p];
      drawPage(ctx, { title: heading, subtitle, entries, from, to, pageNo: p + 1, pageCount: pages.length, images, dupKeys });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      jpegs.push(new Uint8Array(await blob.arrayBuffer()));
    }
    return writePdf(jpegs, { width: canvas.width, height: canvas.height, title: heading });
  }

  window.buildReport = buildReport;
})();
