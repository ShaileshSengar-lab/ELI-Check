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
  function prepare(canvas, crop) {
    const r = crop || { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const target = 1100;
    const scale = Math.max(1, Math.min(3, target / r.w));
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
    g.putImageData(img, 0, 0);
    return c;
  }

  /* Returns lines as [{ text, conf }], conf being the lowest confidence of any number on the line. */
  async function read(canvas, crop, onProgress) {
    const w = await getWorker(onProgress);
    const { data } = await w.recognize(prepare(canvas, crop));
    const lines = (data.lines || []).map(l => {
      const numeric = (l.words || []).filter(x => /\d[.,]\s?\d/.test(x.text) || /^\d+$/.test(x.text));
      const conf = numeric.length ? Math.min(...numeric.map(x => x.confidence)) : 100;
      return { text: (l.text || "").trim(), conf: Math.round(conf) };
    });
    return { lines, text: data.text };
  }

  root.SlipOCR = { loadImage, rotate, read };
})(this);
