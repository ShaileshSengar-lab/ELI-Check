/*
  Reads plate reader slips from text (typed, pasted, or from photo text
  recognition) and turns them into run wells.

  Two slip formats are recognised:
  - "merilyzer": one line per well, "A1  0.0448"  (OD only)
  - "lisascan":  "PC 2.4597", "NC 0.0023", "SMP 1 0.0015 0.0097 NR",
                 with a cutoff line such as "mNC + 0.15 = 0.1561"
*/
(function (root) {
  "use strict";
  const E = (typeof module !== "undefined" && module.exports) ? require("./engine.js") : root.Engine;

  const DEC = /\d*[.,]\d+/g;

  function clean(line) {
    return String(line)
      .replace(/(\d)[,](\d)/g, "$1.$2")
      .replace(/(\d)\.\s+(\d)/g, "$1.$2")
      .replace(/(?<=\d|\.)[Oo](?=\d|\b)/g, "0")
      .replace(/\b[Oo](?=[.,]\d)/g, "0")
      .replace(/[|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const decimals = s => (s.match(DEC) || []).map(x => parseFloat(x.replace(",", ".")));

  function toLines(input) {
    if (Array.isArray(input)) return input.map(l => typeof l === "string" ? { text: l, conf: 100 } : { text: l.text || "", conf: l.conf ?? 100 });
    return String(input || "").split(/\r?\n/).map(t => ({ text: t, conf: 100 }));
  }

  function detect(text) {
    if (/TEST\s*RESULT|CUTOFF\s*EQ|\bSMP\b|SMP\/CO|Analyte/i.test(text)) return "lisascan";
    if (/MERILYZER|EIAQuant|Well\s+Id|Res\./i.test(text)) return "merilyzer";
    if (/^\s*(PC|NC)\s+\d/im.test(text)) return "lisascan";
    return "merilyzer";
  }

  function parseDate(text) {
    const m = text.match(/(?:Run\s*Date|Date)\s*[:;.]?\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})/i);
    if (!m) return null;
    let [, d, mo, y] = m; y = y.length === 2 ? "20" + y : y;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
  }

  /* Merilyzer: OD per well, in plate order. */
  function parseMerilyzer(lines) {
    const entries = [], skipped = [];
    let started = false;
    for (const { text, conf } of lines) {
      const t = clean(text);
      if (!t) continue;
      if (/Run\s*Date|Lab\s*Name|Address|Test\s*:|Filter|Print\s*Time|Plate\s*Report|MERILYZER|End\s*Of/i.test(t)) continue;
      if (/Well\s+Id|\bOD\b\s+Res/i.test(t)) { started = true; continue; }
      const nums = decimals(t);
      if (!nums.length) { if (started && t.length > 2) skipped.push(text); continue; }
      const od = nums[nums.length - 1];
      if (od > 4.5) { skipped.push(text); continue; }
      const head = t.slice(0, t.search(DEC)).trim().split(" ").filter(Boolean).pop() || "";
      entries.push({ label: fuzzyLabel(head), od, conf, raw: text });
      started = true;
    }
    return { entries, skipped };
  }

  /* Read a well label even when text recognition has garbled it ("Bl" for B1, "(1" for C1). */
  function fuzzyLabel(tok) {
    if (!tok || tok.length > 3) return null;
    if (/^[A-H](1[0-2]|[1-9])$/.test(tok)) return { pos: tok, exact: true };
    const row = { "(": "C", "[": "C", "{": "C", "8": "B", "6": "G" }[tok[0]] || tok[0].toUpperCase();
    if (!/[A-H]/.test(row)) return null;
    const col = tok.slice(1).replace(/[lIi|!\]]/g, "1").replace(/S/g, "5").replace(/Z/g, "2").replace(/O/g, "0").replace(/11+/g, "1");
    const pos = row + col;
    return E.isPos(pos) ? { pos, exact: false } : null;
  }

  /* Lay Merilyzer entries onto plate positions in reading order, using any
     readable well labels to spot lines that were missed. */
  function placeSequential(entries, startPos) {
    let i = Math.max(0, E.posIndex(startPos || "A1"));
    const out = [];
    for (const e of entries) {
      const lab = e.label;
      if (lab) {
        const li = E.posIndex(lab.pos);
        if (li > i && li <= i + 3) {
          for (let b = out.length - 1, n = 0; b >= 0 && n < 3; b--, n++) if (!out[b].missing) out[b].checkOrder = true;
          while (i < li) out.push({ pos: E.posAt(i++), od: null, role: "S", missing: true, uncertain: true });
        }
      }
      const pos = E.posAt(i++);
      if (!pos) break;
      const w = { pos, od: e.od, role: "S", conf: e.conf, raw: e.raw };
      if (lab && lab.exact && lab.pos !== pos) w.labelMismatch = lab.pos;
      if (e.conf < 75) w.uncertain = true;
      out.push(w);
    }
    return out;
  }

  /* LisaScan: labelled controls and numbered samples with printed ratio and flag.
     Written to survive text recognition errors seen on real slips: "SMP" read as SHP/sup/cup,
     the sample number run into the OD ("SMP 9 2.1007" read as "92.1007"), "0." dropped from
     an OD ("0043"), "NR" read as Np/NK, and stray marks from highlighter or pen. */
  const round4 = x => Math.round(x * 10000) / 10000;
  function parseLisaScan(lines) {
    const res = { testNo: null, testName: null, printed: null, controls: [], samples: [], skipped: [] };
    const raws = [];
    for (const { text, conf } of lines) {
      const t = clean(text);
      if (!t) continue;
      let m;
      if ((m = t.match(/Test\s*No\s*[:.]?\s*(\d+)/i))) { res.testNo = +m[1]; continue; }
      if ((m = t.match(/^\W*TEST\s*[:;]\s*(.+)$/i))) { res.testName = m[1].trim(); continue; }
      if ((m = t.match(/GREY\s*ZONE\s*[:;]?\s*(\w+)/i))) { res.printed = { ...(res.printed || {}), greyZone: m[1].toUpperCase() }; continue; }
      if ((m = t.match(/((?:\d*\.\d+\s*[+*x×]\s*)?m?\s*[NP]C(?:\s*[+*x×]\s*\d*\.\d+)?)\s*[=:]\s*(\d*\.\d+)/i))) {
        res.printed = { ...(res.printed || {}), formula: m[1].replace(/\s+/g, " ").trim(), cutoff: parseFloat(m[2]) }; continue;
      }
      if (/TEST\s*RESULT|Plate\s*I\.?D|FILTERS|CUTOFF\s*EQ|Analyte|SmpID|End\s*Of/i.test(t)) continue;
      if ((m = t.match(/^\W{0,3}(PC|NC|BLK|BLANK|BL)\b\W*(\d*\.\d+)/i))) {
        let role = m[1].toUpperCase(); if (role.startsWith("BL")) role = "BLK";
        res.controls.push({ role, od: parseFloat(m[2]), conf, raw: text });
        continue;
      }
      raws.push({ t, conf, raw: text });
    }
    const cut = res.printed && res.printed.cutoff > 0 ? res.printed.cutoff : null;
    let seenSample = false;
    for (const { t, conf, raw } of raws) {
      const toks = t.match(/\d+(?:\.\d*)?|\.\d+/g) || [];
      const isDec = x => /\.\d{2,}$/.test(x);
      const decs = toks.filter(isDec);
      const merged = x => { const m = x.match(/^(\d{1,2}?)(\d\.\d{4})$/); return m && m[1] && parseFloat(x) > 4.5 ? { n: +m[1], od: parseFloat(m[2]) } : null; };
      const smpLike = /\b[S5$][MNHWU][PFR]\b|\bs[uh]p\b|\bcup\b|\bgue\b|SMP/i.test(t);
      let n = null, od = null, ratio = null, uncertain = false, estimated = false;
      const firstDec = toks.findIndex(isDec);
      const head = firstDec < 0 ? toks : toks.slice(0, firstDec);
      const intTok = head.find(x => /^\d{1,2}\.?$/.test(x));
      if (intTok) n = parseInt(intTok, 10);
      if (decs.length >= 2) {
        const mg = merged(decs[0]);
        if (mg) { if (n == null) n = mg.n; od = mg.od; }
        else if (parseFloat(decs[0]) <= 4.5) od = parseFloat(decs[0]);
        const last = decs[decs.length - 1];
        if (/\.\d{3,}$/.test(last)) ratio = parseFloat(last);
      } else if (decs.length === 1) {
        const mg = merged(decs[0]);
        const z = head.find(x => /^0\d{3}$/.test(x));
        if (mg) { if (n == null) n = mg.n; od = mg.od; }
        else if (z && (n != null || smpLike)) {
          // "0." lost from the OD ("0043"): the 4 digits are the OD and the decimal is the ratio
          od = parseFloat("0." + z); ratio = parseFloat(decs[0]); uncertain = true;
        }
        else if (n != null || smpLike) {
          const v = parseFloat(decs[0]);
          // with a sample number, a single value is the OD (the ratio was lost) unless it only makes sense as the ratio
          if (v <= 4.5) od = v; else ratio = v;
        } else if (!seenSample && parseFloat(decs[0]) <= 4.5) {
          // an unlabelled value above the first sample is a control whose label was not read
          res.controls.push({ role: null, od: parseFloat(decs[0]), conf: Math.min(conf, 50), raw });
          continue;
        } else { continue; }
      } else {
        const z = toks.find(x => /^0\d{3}$/.test(x));
        if (z && (n != null || smpLike)) { od = parseFloat("0." + z); uncertain = true; }
        else { if (smpLike && toks.length) res.skipped.push(raw); continue; }
      }
      // a 4-digit token that lost its "0." (e.g. "0043") between the number and the ratio
      if (od == null) { const z = head.find(x => /^0\d{3}$/.test(x)); if (z) { od = parseFloat("0." + z); uncertain = true; } }
      const flagM = t.match(/\b(N\s?[RPKBre]|M[RP]|R)\W*$/i);
      let flag = flagM ? (/^R$/i.test(flagM[1]) ? "R" : "NR") : null;
      // the reader flags R exactly when its ratio is 1 or more; a flag that contradicts the printed ratio was misread
      if (flag && ratio != null && (flag === "R") !== (ratio >= 1)) { flag = ratio >= 1 ? "R" : "NR"; uncertain = true; }
      if (ratio == null) uncertain = true;
      if (cut && ratio != null) {
        const est = ratio * cut;
        if (od == null) { od = round4(est); uncertain = true; estimated = true; }
        // the reader divides unrounded values, so allow for rounding of OD, ratio and printed cutoff
        else if (Math.abs(od - est) > Math.max(0.00015, est * 0.012)) uncertain = true;
      }
      if (od == null) { res.skipped.push(raw); continue; }
      if (Math.abs(od * 10000 - Math.round(od * 10000)) > 1e-6) uncertain = true; // ODs print with 4 decimals
      seenSample = true;
      res.samples.push({ n, od, ratio, flag, conf, raw, uncertain, estimated });
    }
    res.samples = numberSamples(res.samples);
    return res;
  }

  /* Sample numbers. Numbers read from the slip that rise in order act as anchors (longest increasing run);
     lines between anchors are numbered in sequence. If there are more lines than numbers between two anchors,
     the least plausible extra lines (no ratio, or OD not matching the ratio) are dropped, so one stray line
     cannot shift every later sample. Lines whose place is not certain are flagged. */
  function numberSamples(list) {
    const idx = list.map((s, i) => i).filter(i => list[i].n != null && list[i].n >= 1);
    // longest strictly increasing subsequence of read numbers, also requiring room for the lines between
    const best = [], prev = [];
    idx.forEach((i, a) => {
      best[a] = 1; prev[a] = -1;
      for (let b = 0; b < a; b++) {
        const j = idx[b];
        if (list[i].n > list[j].n && best[b] + 1 > best[a]) { best[a] = best[b] + 1; prev[a] = b; }
      }
    });
    let end = best.length ? best.indexOf(Math.max(...best)) : -1;
    const anchors = new Set();
    while (end >= 0) { anchors.add(idx[end]); end = prev[end]; }
    if (anchors.size < 2) anchors.clear();
    const out = [];
    let lastN = 0, seg = [];
    const plaus = s => (s.ratio != null ? 2 : 0) + (s.uncertain ? 0 : 1);
    const flush = (upto) => {
      const room = upto == null ? Infinity : upto - lastN - 1;
      let keep = seg;
      if (keep.length > room) {
        const order = keep.map((s, i) => [plaus(s), i]).sort((x, y) => x[0] - y[0] || y[1] - x[1]);
        const drop = new Set(order.slice(0, keep.length - room).map(x => x[1]));
        keep = keep.filter((s, i) => !drop.has(i));
      }
      const exact = upto == null || keep.length === room;
      keep.forEach(s => { s.n = ++lastN; if (!exact) s.uncertain = true; out.push(s); });
      seg = [];
    };
    list.forEach((s, i) => {
      if (anchors.has(i)) { flush(s.n); lastN = s.n; out.push(s); }
      else { s.n = null; seg.push(s); }
    });
    flush(null);
    return out;
  }

  function lisaToWells(p, layout) {
    let i = 0;
    const wells = [];
    // Controls in the assay's usual order; a control the slip shows but text recognition missed gets an empty row to fill in
    const pool = p.controls.slice();
    const order = layout && layout.where === "start" ? layout.order : [];
    order.forEach(role => {
      let k = pool.findIndex(c => c.role === role);
      if (k < 0) k = pool.findIndex(c => c.role == null);
      if (k >= 0) { const c = pool.splice(k, 1)[0]; wells.push({ pos: E.posAt(i++), od: c.od, role, uncertain: c.conf < 75 || undefined, raw: c.raw }); }
      else wells.push({ pos: E.posAt(i++), od: null, role, missing: true, uncertain: true });
    });
    pool.forEach(c => wells.push({ pos: E.posAt(i++), od: c.od, role: c.role || "NC", uncertain: true, raw: c.raw }));
    // Samples in slip order; a numbered line that was not read gets an empty row so later wells keep their places
    let expect = 1;
    p.samples.forEach(s => {
      while (s.n > expect) { wells.push({ pos: E.posAt(i++), od: null, role: "S", n: expect++, missing: true, uncertain: true }); }
      wells.push({ pos: E.posAt(i++), od: s.od, role: "S", n: s.n, printedRatio: s.ratio, printedFlag: s.flag,
        uncertain: (s.conf < 75 || s.uncertain) || undefined, estimated: s.estimated || undefined, raw: s.raw });
      expect = s.n + 1;
    });
    return wells.filter(w => w.pos);
  }

  /* Apply the assay's usual control layout to OD-only wells. */
  function applyLayout(wells, layout) {
    const out = wells.map(w => ({ ...w, role: "S" }));
    if (!layout || !out.length) return out;
    const k = layout.order.length;
    if (layout.where === "end") {
      layout.order.forEach((role, j) => { const w = out[out.length - k + j]; if (w) w.role = role; });
    } else {
      layout.order.forEach((role, j) => { if (out[j]) out[j].role = role; });
    }
    return out;
  }

  function parse(input, opts = {}) {
    const lines = toLines(input);
    const text = lines.map(l => l.text).join("\n");
    const format = opts.format || detect(text);
    const date = parseDate(text);
    if (format === "lisascan") {
      const p = parseLisaScan(lines);
      return { format, date, testNo: p.testNo, testName: p.testName, printed: p.printed, wells: lisaToWells(p, opts.layout), skipped: p.skipped };
    }
    const m = parseMerilyzer(lines);
    return { format, date, printed: null, wells: placeSequential(m.entries, opts.startPos), skipped: m.skipped };
  }

  const api = { parse, applyLayout, detect, parseDate, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlipParser = api;
})(this);
