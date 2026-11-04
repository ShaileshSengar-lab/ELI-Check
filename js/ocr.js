/*
  Photo reading. Text recognition runs inside the browser (Tesseract.js,
  bundled in vendor/), so slip photos never leave the device.
*/
(function (root) {
  "use strict";
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (root.Tesseract) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("Could not load the text recognition files."));
      document.head.appendChild(s);
    });
  }

  async function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        await loadScript("vendor/tesseract/tesseract.min.js");
        const base = new URL("vendor/tesseract/", document.baseURI).href;
        const w = await root.Tesseract.createWorker("eng", 1, {
          workerPath: base + "worker.min.js",
          corePath: base + "core",
          langPath: base + "lang",
          gzip: true,
          logger: m => { if (root.__ocrProgress) root.__ocrProgress(m); }
        });
        await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        return w;
      })().catch(e => { workerPromise = null; throw e; });
    }
    root.__ocrProgress = onProgress;
    return workerPromise;
  }

  /* Load a photo into a canvas, respecting camera orientation. */
  async function loadImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) {
      bmp = await new Promise((res, rej) => {
        const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error("This file could not be opened as an image."));
        img.src = URL.createObjectURL(file);
      });
    }
    const max = 2200, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  function rotate(canvas, dir) {
    const c = document.createElement("canvas");
    c.width = canvas.height; c.height = canvas.width;
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2);
    g.rotate(dir * Math.PI / 2);
    g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }

  /* Crop, enlarge small text and stretch contrast. The red channel is used instead of plain grey:
     printed black text stays dark, while yellow, green and pink highlighter and red pen marks turn
     pale, so they interfere less with reading. */
  function prepare(canvas, crop, opt) {
    opt = opt || {};
    const r = crop || { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const target = opt.targetW || 1100;
    const scale = Math.max(1, Math.min(opt.maxScale || 3, target / r.w));
    const c = document.createElement("canvas");
    c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      d[i] = v; hist[v]++;
    }
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    if (opt.binarize) binarize(d, c.width, c.height, opt.binarize);
    g.putImageData(img, 0, 0);
    return c;
  }

  /* Black and white by local threshold (Sauvola-style mean over a window), so faint thermal print
     and uneven light are both handled. */
  function binarize(d, w, h, mode) {
    const n = w * h, I = new Float64Array((w + 1) * (h + 1)), I2 = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0, s2 = 0;
      for (let x = 0; x < w; x++) {
        const v = d[(y * w + x) * 4]; s += v; s2 += v * v;
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; I2[(y + 1) * (w + 1) + x + 1] = I2[y * (w + 1) + x + 1] + s2;
      }
    }
    const R = Math.max(8, Math.round(Math.min(w, h) / (mode === "fine" ? 40 : 24))), k = 0.2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(w, x + R + 1), y1 = Math.min(h, y + R + 1);
      const cnt = (x1 - x0) * (y1 - y0);
      const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const sum2 = I2[y1 * (w + 1) + x1] - I2[y0 * (w + 1) + x1] - I2[y1 * (w + 1) + x0] + I2[y0 * (w + 1) + x0];
      const m = sum / cnt, sd = Math.sqrt(Math.max(0, sum2 / cnt - m * m));
      const t = m * (1 + k * (sd / 128 - 1));
      const i = (y * w + x) * 4, v = d[i] > t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  /* Find the reader slip in a photo. Thermal slip paper is nearly colourless, while register sheets,
     forms and desks are cream or coloured, so the slip shows up as the largest near-white block.
     Returns a crop rectangle, or null when the slip fills most of the photo (no crop needed) or
     no clear slip is found. */
  function autoCrop(canvas) {
    const k = Math.min(1, 480 / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const white = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      white[p] = (mx - mn < 22 && mn > 140) ? 1 : 0;
    }
    // longest stretch above the threshold, bridging short dips (highlighter or pen marks across the slip)
    const longestRun = (arr, thr, gap) => {
      let best = [0, -1], s = -1, last = -1;
      for (let i = 0; i <= arr.length; i++) {
        const on = i < arr.length && arr[i] >= thr;
        if (on) { if (s < 0) s = i; last = i; }
        else if (s >= 0 && (i === arr.length || i - last > gap)) { if (last - s > best[1] - best[0]) best = [s, last]; s = -1; }
      }
      return best;
    };
    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) { let n = 0; for (let y = 0; y < h; y++) n += white[y * w + x]; col[x] = n / h; }
    const [x0, x1] = longestRun(col, 0.3, Math.round(w * 0.02));
    const row = new Float32Array(h);
    for (let y = 0; y < h; y++) { let n = 0; for (let x = x0; x <= x1; x++) n += white[y * w + x]; row[y] = n / Math.max(1, x1 - x0 + 1); }
    const [y0, y1] = longestRun(row, 0.3, Math.round(h * 0.06));
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (cw < w * 0.08 || ch < h * 0.15) return null;            // nothing slip-like found
    if (cw * ch > w * h * 0.6) return null;                       // slips already fill most of the photo: read it all
    const padX = Math.round(cw * 0.05), padY = Math.round(ch * 0.01);   // margin so well labels at the slip edge are not cut off
    const X0 = Math.max(0, x0 - padX), Y0 = Math.max(0, y0 - padY), X1 = Math.min(w - 1, x1 + padX), Y1 = Math.min(h - 1, y1 + padY);
    return { x: Math.round(X0 / k), y: Math.round(Y0 / k), w: Math.round((X1 - X0 + 1) / k), h: Math.round((Y1 - Y0 + 1) / k) };
  }

  /* Returns lines as [{ text, conf }], conf being the lowest confidence of any number on the line. */
  async function read(canvas, crop, onProgress, psm, opt) {
    const w = await getWorker(onProgress);
    await w.setParameters({ tessedit_pageseg_mode: psm || "6", preserve_interword_spaces: "1", tessedit_char_whitelist: (opt && opt.whitelist) || "" });
    const { data } = await w.recognize(prepare(canvas, crop, opt));
    const lines = (data.lines || []).map(l => {
      const numeric = (l.words || []).filter(x => /\d[.,]\s?\d/.test(x.text) || /^\d+$/.test(x.text));
      const conf = numeric.length ? Math.min(...numeric.map(x => x.confidence)) : 100;
      return { text: (l.text || "").trim(), conf: Math.round(conf), words: (l.words || []).map(x => ({ text: x.text, conf: x.confidence, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1 })) };
    });
    // words with their positions, for slips whose strips are photographed side by side
    const words = (data.lines || []).flatMap(l => l.words || []).map(x => ({ text: x.text, conf: x.confidence, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1 }));
    return { lines, words, text: data.text };
  }

  /* Re-read single values: each word box is cut out of the prepared image, enlarged, and read again as
     one line restricted to digits and the decimal point. Returns the new text for each word (or null). */
  async function reread(canvas, crop, words, opt) {
    if (!words.length) return [];
    const w = await getWorker();
    const base = prepare(canvas, crop, opt);
    await w.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "0123456789.", preserve_interword_spaces: "0" });
    const out = [];
    for (const x of words) {
      const hgt = x.y1 - x.y0, pad = Math.round(hgt * 0.35);
      const sx = Math.max(0, x.x0 - pad), sy = Math.max(0, x.y0 - pad), sw = Math.min(base.width - sx, x.x1 - x.x0 + 2 * pad), sh = Math.min(base.height - sy, hgt + 2 * pad);
      if (sw < 4 || sh < 4) { out.push(null); continue; }
      const k = Math.max(1, Math.min(4, 48 / hgt));
      const c = document.createElement("canvas"); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = "high";
      g.drawImage(base, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const { data } = await w.recognize(c);
      out.push({ text: (data.text || "").replace(/\s+/g, ""), conf: data.confidence });
    }
    await w.setParameters({ tessedit_char_whitelist: "" });
    return out;
  }

  /* ---------- Scan: find the slip, straighten it, even out the light ----------
     The slip is the largest near-white region (thermal paper is almost colourless; registers and desks
     are cream or coloured). Its four corners are taken from that region, the photo is warped so the slip
     becomes an upright rectangle, and optionally the light is evened out by dividing by a blurred copy. */
  function findCorners(canvas) {
    const k = Math.min(1, 520 / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let m = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      m[p] = (mx - mn < 24 && mn > 135) ? 1 : 0;
    }
    // close small gaps (printed text, highlighter strokes) so the slip is one region
    const R = Math.max(2, Math.round(Math.min(w, h) / 90));
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) dil[yy * w + xx] = 1;
    }
    m = dil;
    // largest connected region
    const lab = new Int32Array(w * h).fill(-1);
    let best = -1, bestN = 0, cur = 0;
    const stack = [];
    for (let s0 = 0; s0 < w * h; s0++) {
      if (!m[s0] || lab[s0] >= 0) continue;
      let n = 0; stack.push(s0); lab[s0] = cur;
      while (stack.length) {
        const q = stack.pop(); n++;
        const x = q % w, y = (q - x) / w;
        if (x > 0 && m[q - 1] && lab[q - 1] < 0) { lab[q - 1] = cur; stack.push(q - 1); }
        if (x < w - 1 && m[q + 1] && lab[q + 1] < 0) { lab[q + 1] = cur; stack.push(q + 1); }
        if (y > 0 && m[q - w] && lab[q - w] < 0) { lab[q - w] = cur; stack.push(q - w); }
        if (y < h - 1 && m[q + w] && lab[q + w] < 0) { lab[q + w] = cur; stack.push(q + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
      cur++;
    }
    if (best < 0 || bestN < w * h * 0.04) return null;
    // corners: extreme points along the two diagonals
    let tl = null, tr = null, br = null, bl = null;
    for (let q = 0; q < w * h; q++) {
      if (lab[q] !== best) continue;
      const x = q % w, y = (q - x) / w;
      if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
      if (!br || x + y > br[0] + br[1]) br = [x, y];
      if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
      if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
    }
    const back = p => [p[0] / k, p[1] / k];
    const area = Math.abs((tr[0] - tl[0]) * (bl[1] - tl[1]) - (bl[0] - tl[0]) * (tr[1] - tl[1]));
    return { corners: [back(tl), back(tr), back(br), back(bl)], fill: bestN / (w * h), quadFill: area / (w * h) };
  }

  // homography mapping the unit square corners (0,0),(1,0),(1,1),(0,1) to the quad
  function squareToQuad(q) {
    const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
  }

  function scan(canvas, opt) {
    opt = opt || {};
    const f = findCorners(canvas);
    if (!f) return null;
    // only straighten one clear, roughly rectangular slip: the white region must fill its four-corner
    // outline (not several overlapping strips) and must not already fill the photo
    f.rect = f.fill / Math.max(1e-6, f.quadFill);
    if (!opt.force && (f.rect < 0.85 || f.quadFill > 0.8)) return { skipped: true, reason: f.quadFill > 0.8 ? "fills" : "shape", rect: f.rect, quadFill: f.quadFill };
    const q = f.corners, dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let W = Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2]))), H = Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])));
    if (W < 40 || H < 40) return null;
    // small margin so nothing at the slip edge is lost
    const mx = 0.02;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const qq = q.map(([x, y]) => [cx + (x - cx) * (1 + mx * 2), cy + (y - cy) * (1 + mx * 2)]);
    const scale = Math.min(1, 2400 / Math.max(W, H)); W = Math.round(W * scale * (1 + mx * 2)); H = Math.round(H * scale * (1 + mx * 2));
    const [a, b, c, d, e, ff, g, h] = squareToQuad(qq);
    const sctx = canvas.getContext("2d"), src = sctx.getImageData(0, 0, canvas.width, canvas.height).data, SW = canvas.width, SH = canvas.height;
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const octx = out.getContext("2d"), img = octx.createImageData(W, H), od = img.data;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, den = g * u + h * v + 1;
        const X = (a * u + b * v + c) / den - 0.5, Y = (d * u + e * v + ff) / den - 0.5;
        const o = (y * W + x) * 4;
        if (X < 0 || Y < 0 || X >= SW - 1 || Y >= SH - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
        const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0, i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
        for (let ch = 0; ch < 3; ch++) od[o + ch] = (src[i00 + ch] * (1 - fx) + src[i10 + ch] * fx) * (1 - fy) + (src[i01 + ch] * (1 - fx) + src[i11 + ch] * fx) * fy;
        od[o + 3] = 255;
      }
    }
    if (opt.evenLight) {
      // divide by a heavily blurred copy so shadows and uneven light are removed
      octx.putImageData(img, 0, 0);
      const bl = document.createElement("canvas"); bl.width = W; bl.height = H;
      const bctx = bl.getContext("2d"); bctx.filter = `blur(${Math.max(8, Math.round(Math.min(W, H) / 30))}px)`; bctx.drawImage(out, 0, 0);
      const bd = bctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < od.length; i += 4) for (let ch = 0; ch < 3; ch++) od[i + ch] = Math.min(255, od[i + ch] / Math.max(1, bd[i + ch]) * 235);
    }
    octx.putImageData(img, 0, 0);
    return { canvas: out, corners: q, fill: f.fill, quadFill: f.quadFill };
  }

  root.SlipOCR = { loadImage, rotate, read, autoCrop, reread, scan, findCorners };
})(this);
