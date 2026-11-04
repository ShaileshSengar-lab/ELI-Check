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

  /* Merilyzer slips print a well label beside every OD, so values can be placed by label rather than
     by reading order. This pairs each label with the number printed just to its right on the photo,
     which keeps working when a slip cut into strips is photographed side by side. Words carry
     positions from text recognition: { text, conf, x0, y0, x1, y1 }. */
  function labelToken(t) {
    t = String(t).replace(/[^\w(\[{|!]/g, "");
    if (!t || t.length > 3) return null;
    let row = { "(": "C", "[": "C", "{": "C", "8": "B", "6": "G", "0": "D", "|": "H", "#": "H" }[t[0]] || t[0].toUpperCase();
    if (!/[A-H]/.test(row)) return null;
    const colRaw = t.slice(1);
    if (!colRaw) return null;
    const col = colRaw.replace(/[lIi|!\]tTJ]/g, "1").replace(/S/g, "5").replace(/Z/g, "2").replace(/[Oo]/g, "0").replace(/^11+$/, "1");
    if (!/^(1[0-2]|[1-9])$/.test(col)) return null;
    return { pos: row + col, exact: /^[A-H](1[0-2]|[1-9])$/.test(t) };
  }
  /* Strips photographed side by side: group values into columns by position, read each column top to
     bottom, attach any readable label to the left of each value, and lay each column onto the plate
     from the start its labels agree on. Returns wells, or null if the words do not look like a slip. */
  function placeColumns(words) {
    const W = words.map(w => ({ ...w, text: String(w.text || "").trim(), yc: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) })).filter(w => w.text);
    if (!W.length) return null;
    W.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
    const vals = [], used = new Set();
    W.forEach((w, i) => {
      if (used.has(i)) return;
      let t = w.text.replace(/[,;:]/g, ".").replace(/[)(\]'"`]/g, "").replace(/[Oo]/g, "0"), x1 = w.x1, conf = w.conf;
      if (/^\d\.?$/.test(t)) {
        const j = W.findIndex((v, k) => k !== i && !used.has(k) && Math.abs(v.yc - w.yc) < w.h * 0.6 && v.x0 >= w.x1 - 2 && v.x0 - w.x1 < w.h * 1.6 && /^\.?\d{2,4}$/.test(v.text.replace(/[,;:]/g, ".")));
        if (j >= 0) { t = t.replace(/\.$/, "") + "." + W[j].text.replace(/[,;:.]/g, ""); x1 = W[j].x1; conf = Math.min(conf, W[j].conf); used.add(j); }
      }
      const m = t.match(/^(\d?)\.(\d{2,4})$/);
      if (m) { const od = parseFloat((m[1] || "0") + "." + m[2]); if (od <= 4.5) vals.push({ od, conf, x0: w.x0, x1, yc: w.yc, h: w.h, i, partial: !m[1] }); }
      // decimal point lost: "19749" read for 1.9749 (kept, but flagged)
      else if (/^[0-3]\d{4}$/.test(t)) { const od = parseFloat(t[0] + "." + t.slice(1)); if (od <= 4.5) vals.push({ od, conf: Math.min(conf, 40), x0: w.x0, x1, yc: w.yc, h: w.h, i, partial: true }); }
    });
    if (vals.length < 4) return null;
    const hMed = vals.map(v => v.h).sort((a, b) => a - b)[vals.length >> 1];
    // columns: split value positions where the horizontal gap is large
    const byX = vals.slice().sort((a, b) => a.x0 - b.x0);
    const cols = [[byX[0]]];
    for (let k = 1; k < byX.length; k++) {
      if (byX[k].x0 - byX[k - 1].x0 > hMed * 4) cols.push([]);
      cols[cols.length - 1].push(byX[k]);
    }
    const labelWords = W.map(w => ({ w, lab: labelToken(w.text) })).filter(x => x.lab);
    const colEntries = cols.filter(c => c.length >= 2).map(c => {
      c.sort((a, b) => a.yc - b.yc);
      return c.map(v => {
        // nearest label on the same line, to the left of the value
        let best = null, bd = Infinity;
        labelWords.forEach(L => {
          const dy = Math.abs(L.w.yc - v.yc), dx = v.x0 - L.w.x1;
          if (dy < Math.max(L.w.h, v.h) * 0.7 && dx > -2 && dx < hMed * 14 && dx + dy * 4 < bd) { bd = dx + dy * 4; best = L.lab; }
        });
        return { od: v.od, conf: v.partial ? Math.min(v.conf, 60) : v.conf, label: best, raw: "", box: { x0: v.x0, x1: v.x1, y0: v.yc - v.h / 2, y1: v.yc + v.h / 2 } };
      });
    });
    if (!colEntries.length) return null;
    // a label pointing far beyond the number of values on the slip is a misread; ignore it
    const totalVals = colEntries.reduce((t, es) => t + es.length, 0);
    colEntries.forEach(es => es.forEach(e => { if (e.label && E.posIndex(e.label.pos) > totalVals + 6) e.label = null; }));
    // Within each column, readable labels pin their values to wells (longest run of labels rising in
    // plate order, allowing for skipped lines). Values between two labels are placed in order; where the
    // count does not fit the gap, their places are uncertain and flagged. A column with no usable
    // labels follows on from the previous one and is flagged.
    const placeCol = (es, fallback) => {
      const idx = es.map((e, k) => k).filter(k => es[k].label);
      const best = [], prev = [];
      idx.forEach((k, a) => {
        best[a] = es[k].label.exact ? 2 : 1; prev[a] = -1;
        const pk = E.posIndex(es[k].label.pos);
        for (let b = 0; b < a; b++) {
          const j = idx[b], pj = E.posIndex(es[j].label.pos);
          if (pk - pj >= k - j && best[b] + (es[k].label.exact ? 2 : 1) > best[a]) { best[a] = best[b] + (es[k].label.exact ? 2 : 1); prev[a] = b; }
        }
      });
      let end = best.length ? best.indexOf(Math.max(...best)) : -1;
      const anchors = new Map();
      if (end >= 0 && best[end] >= 2) while (end >= 0) { anchors.set(idx[end], E.posIndex(es[idx[end]].label.pos)); end = prev[end]; }
      const out = [];
      const ks = [...anchors.keys()].sort((a, b) => a - b);
      if (!ks.length) {
        es.forEach((e, k) => out.push({ pos: E.posAt(fallback + k), od: e.od, role: "S", conf: e.conf, box: e.box, uncertain: true }));
        return { wells: out, end: fallback + es.length, anchored: false };
      }
      const put = (k, pi, sure) => { const e = es[k], pos = E.posAt(pi); if (pos) out.push({ pos, od: e.od, role: "S", conf: e.conf, box: e.box, uncertain: !sure || e.conf < 75 || (e.label && !e.label.exact) || undefined }); };
      // before the first anchor: count back from it
      for (let k = 0; k < ks[0]; k++) { const pi = anchors.get(ks[0]) - (ks[0] - k); if (pi >= 0) put(k, pi, true); }
      ks.forEach((k, n) => {
        put(k, anchors.get(k), true);
        const k2 = ks[n + 1];
        if (k2 == null) { for (let m = k + 1; m < es.length; m++) put(m, anchors.get(k) + (m - k), true); return; }
        const between = k2 - k - 1, slots = anchors.get(k2) - anchors.get(k) - 1;
        const exact = between === slots;
        for (let m = k + 1; m < k2 && m - k <= slots; m++) put(m, anchors.get(k) + (m - k), exact);
      });
      return { wells: out, end: Math.max(...out.map(w => E.posIndex(w.pos))) + 1, anchored: true };
    };
    const firstPos = es => { const l = es.find(e => e.label); return l ? E.posIndex(l.label.pos) : Infinity; };
    const orderCols = colEntries.map((es, k) => k).sort((a, b) => firstPos(colEntries[a]) - firstPos(colEntries[b]) || a - b);
    let next = 0;
    const wells = [];
    orderCols.forEach(k => { const r = placeCol(colEntries[k], next); r.wells.forEach(w => wells.push(w)); next = Math.max(next, r.end); });
    // keep one well per position (prefer one that was read), in plate order, filling gaps
    const byPos = new Map();
    wells.forEach(w => { const c = byPos.get(w.pos); if (!c || (c.missing && !w.missing)) byPos.set(w.pos, w); });
    let maxI = Math.max(...[...byPos.keys()].map(p => E.posIndex(p)));
    // a well whose label was read but whose value was not (e.g. covered by ink) still gets its row
    labelWords.forEach(L => { const i = E.posIndex(L.lab.pos); if (L.lab.exact && i > maxI && i <= maxI + 3) maxI = i; });
    const out = [];
    for (let i = 0; i <= maxI; i++) { const p = E.posAt(i); out.push(byPos.get(p) || { pos: p, od: null, role: "S", missing: true, uncertain: true }); }
    return out;
  }

  function pairWords(words) {
    const W = words.map(w => ({ ...w, text: String(w.text || "").trim(), yc: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) })).filter(w => w.text);
    W.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
    // join a number broken in two ("0," "0079" or "0. 0079") when the pieces sit side by side
    const vals = [];
    const used = new Set();
    W.forEach((w, i) => {
      if (used.has(i)) return;
      let t = w.text.replace(/[,;:]/g, ".").replace(/[)(\]]/g, "").replace(/[Oo]/g, "0"), x1 = w.x1, conf = w.conf;
      if (/^\d\.?$/.test(t)) {
        const j = W.findIndex((v, k) => k !== i && !used.has(k) && Math.abs(v.yc - w.yc) < w.h * 0.6 && v.x0 >= w.x1 - 2 && v.x0 - w.x1 < w.h * 1.6 && /^\.?\d{2,4}$/.test(v.text.replace(/[,;:]/g, ".")));
        if (j >= 0) { t = t.replace(/\.$/, "") + "." + W[j].text.replace(/[,;:.]/g, ""); x1 = W[j].x1; conf = Math.min(conf, W[j].conf); used.add(j); }
      }
      const m = t.match(/^(\d?)\.(\d{2,4})$/);
      if (m) { const od = parseFloat((m[1] || "0") + "." + m[2]); if (od <= 4.5) vals.push({ od, conf, x0: w.x0, x1, yc: w.yc, h: w.h, i }); }
    });
    const labels = W.map(w => ({ w, lab: labelToken(w.text) })).filter(x => x.lab);
    // candidate pairs: value on the same line, to the right, within a few label widths
    const cand = [];
    labels.forEach((L, li) => vals.forEach((v, vi) => {
      const dy = Math.abs(v.yc - L.w.yc), dx = v.x0 - L.w.x1;
      if (dy < Math.max(L.w.h, v.h) * 0.7 && dx > -2 && dx < L.w.h * 14) cand.push({ li, vi, d: dx + dy * 4 });
    }));
    cand.sort((a, b) => a.d - b.d);
    const usedL = new Set(), usedV = new Set(), out = [];
    cand.forEach(c => {
      if (usedL.has(c.li) || usedV.has(c.vi)) return;
      usedL.add(c.li); usedV.add(c.vi);
      const L = labels[c.li], v = vals[c.vi];
      out.push({ pos: L.lab.pos, exact: L.lab.exact, od: v.od, conf: Math.min(L.w.conf, v.conf), y: L.w.yc, x: L.w.x0 });
    });
    // one entry per well: prefer an exactly read label, then higher confidence
    const byPos = new Map();
    out.forEach(e => {
      const cur = byPos.get(e.pos);
      if (!cur) byPos.set(e.pos, e);
      else { const better = (e.exact && !cur.exact) || (e.exact === cur.exact && e.conf > cur.conf); const keep = better ? e : cur; keep.duplicate = true; byPos.set(e.pos, keep); }
    });
    return [...byPos.values()].map(e => ({ ...e, uncertain: !e.exact || e.duplicate || e.conf < 75 }))
      .sort((a, b) => E.posIndex(a.pos) - E.posIndex(b.pos));
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
  function parseLisaScan(lines, layout) {
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
    resolveControls(res, layout);
    res.samples = numberSamples(res.samples);
    return res;
  }

  /* Controls whose label was not read are placed by value and by the slip's own cutoff line:
     a PC is never a small value, and if the slip prints "mNC + 0.05 = 0.0515" the NCs must average
     about 0.0015, which picks the right values when stray lines were read as controls. Values that
     do not fit as controls are treated as samples whose number was not read. */
  function resolveControls(res, layout) {
    const unl = res.controls.filter(c => c.role == null);
    if (!unl.length) return;
    const labelled = res.controls.filter(c => c.role != null);
    const order = layout && layout.order ? layout.order : ["NC"];
    const need = role => Math.max(0, order.filter(r => r === role).length - labelled.filter(c => c.role === role).length);
    let expected = null;
    const pf = res.printed;
    if (pf && pf.cutoff > 0 && pf.formula && /NC/i.test(pf.formula)) {
      const f = pf.formula.replace(/\s+/g, "");
      const add = f.match(/[+](\d*\.\d+)|(\d*\.\d+)[+]/), mult = f.match(/[*x×](\d*\.\d+)|(\d*\.\d+)[*x×]/i);
      if (add) expected = pf.cutoff - parseFloat(add[1] || add[2]);
      else if (mult) expected = pf.cutoff / parseFloat(mult[1] || mult[2]);
    }
    const chosen = new Set();
    // NCs: small values only; if the expected mean is known, choose the combination that matches it
    const ncNeed = need("NC");
    const ncCand = unl.map((c, i) => i).filter(i => unl[i].od < 0.3);
    const labNC = labelled.filter(c => c.role === "NC").map(c => c.od);
    if (ncNeed > 0 && ncCand.length) {
      let pick = ncCand.slice(0, ncNeed);
      if (expected != null && ncCand.length > ncNeed && ncCand.length <= 8) {
        let bestErr = Infinity;
        const combo = (start, cur) => {
          if (cur.length === Math.min(ncNeed, ncCand.length)) {
            const vals = labNC.concat(cur.map(i => unl[i].od));
            const err = Math.abs(vals.reduce((t, v) => t + v, 0) / vals.length - expected);
            if (err < bestErr) { bestErr = err; pick = cur.slice(); }
            return;
          }
          for (let k = start; k < ncCand.length; k++) combo(k + 1, cur.concat(ncCand[k]));
        };
        combo(0, []);
      }
      pick.forEach(i => { unl[i].role = "NC"; chosen.add(i); });
    }
    // PC: only a value large enough to be a positive control
    let pcNeed = need("PC");
    unl.forEach((c, i) => { if (pcNeed > 0 && !chosen.has(i) && c.od >= 0.3) { c.role = "PC"; chosen.add(i); pcNeed--; } });
    // anything left over was a sample line with its number and ratio lost
    const left = unl.filter((c, i) => !chosen.has(i));
    res.controls = res.controls.filter(c => c.role != null);
    if (left.length) res.samples = left.map(c => ({ n: null, od: c.od, ratio: null, flag: null, conf: c.conf, raw: c.raw, uncertain: true })).concat(res.samples);
    if (expected != null) {
      const ncs = res.controls.filter(c => c.role === "NC").map(c => c.od);
      if (ncs.length) { const m = ncs.reduce((t, v) => t + v, 0) / ncs.length; if (Math.abs(m - expected) > Math.max(0.0006, expected * 0.1)) res.controls.forEach(c => { if (c.role === "NC") c.conf = Math.min(c.conf, 50); }); }
    }
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
      const p = parseLisaScan(lines, opts.layout);
      return { format, date, testNo: p.testNo, testName: p.testName, printed: p.printed, wells: lisaToWells(p, opts.layout), skipped: p.skipped };
    }
    const m = parseMerilyzer(lines);
    const seq = placeSequential(m.entries, opts.startPos);
    // with word positions from a photo, place by columns and labels when that finds more wells
    if (opts.words && opts.words.length) {
      const cols = placeColumns(opts.words);
      const nRead = ws => ws.filter(w => !w.missing).length;
      if (cols && nRead(cols) >= nRead(seq)) return { format, date, printed: null, wells: cols, skipped: m.skipped, layout: "columns" };
    }
    return { format, date, printed: null, wells: seq, skipped: m.skipped };
  }

  /* Second reading of doubtful values. rereadTargets finds the word box behind each flagged value;
     applyRereads uses the second readings: on slips with a printed ratio and cutoff, the OD and ratio
     pair that agrees with ratio × cutoff is kept (two independent readings agreeing); otherwise the
     flag is cleared when both readings agree, and kept, with the second reading shown, when they differ. */
  const numOf = t => { const m = String(t || "").replace(/[,;:]/g, ".").match(/\d*\.\d+/); return m ? parseFloat(m[0]) : null; };
  function rereadTargets(parsed, lines, max = 24) {
    const out = [];
    parsed.wells.forEach((w, wi) => {
      if (!w.uncertain || w.od == null || out.length >= max) return;
      if (w.box) { out.push({ wi, kind: "od", word: w.box }); return; }
      const line = w.raw && (lines || []).find(l => l.text === w.raw);
      if (!line || !line.words) return;
      const ow = line.words.find(x => numOf(x.text) != null && Math.abs(numOf(x.text) - w.od) < 1e-9);
      if (ow) out.push({ wi, kind: "od", word: ow });
      if (w.printedRatio != null) { const rw = line.words.find(x => x !== ow && numOf(x.text) != null && Math.abs(numOf(x.text) - w.printedRatio) < 1e-9); if (rw) out.push({ wi, kind: "ratio", word: rw }); }
    });
    return out;
  }
  function applyRereads(parsed, targets, results) {
    const cut = parsed.printed && parsed.printed.cutoff > 0 ? parsed.printed.cutoff : null;
    const alt = new Map();
    targets.forEach((t, i) => {
      const r = results[i]; if (!r || !r.text) return;
      const m = r.text.match(/^(\d)\.(\d{2,4})$/) || r.text.match(/^\.(\d{2,4})$/);
      if (!m) return;
      const v = parseFloat(m.length === 3 ? m[1] + "." + m[2] : "0." + m[1]);
      if (!(v <= 4.5) && t.kind === "od") return;
      const a = alt.get(t.wi) || {}; a[t.kind] = v; alt.set(t.wi, a);
    });
    alt.forEach((a, wi) => {
      const w = parsed.wells[wi];
      if (cut && w.printedRatio != null && w.role === "S") {
        const ods = [w.od, a.od].filter(x => x != null), rats = [w.printedRatio, a.ratio].filter(x => x != null);
        let best = null;
        ods.forEach(o => rats.forEach(r => { const e = r * cut, d = Math.abs(o - e); if (d <= Math.max(0.00015, e * 0.012) && (!best || d < best.d)) best = { o, r, d }; }));
        if (best) { if (best.o !== w.od || best.r !== w.printedRatio) w.rereadFixed = true; w.od = best.o; w.printedRatio = best.r; w.uncertain = undefined; w.rereadOk = true; }
        else if (a.od != null && a.od !== w.od) w.rereadAlt = a.od;
        return;
      }
      if (a.od == null) return;
      // no printed ratio to check against: clear the flag only when both readings agree and both were confident
      const conf2 = results[targets.findIndex(t => t.wi === wi && t.kind === "od")]?.conf ?? 0;
      if (Math.abs(a.od - w.od) < 1e-9) { if (!w.labelMismatch && !w.checkOrder && !w.duplicate && (w.conf ?? 0) >= 60 && conf2 >= 80) { w.uncertain = undefined; w.rereadOk = true; } }
      else w.rereadAlt = a.od;
    });
    return parsed;
  }

  const api = { parse, applyLayout, detect, parseDate, clean, pairWords, placeColumns, rereadTargets, applyRereads };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlipParser = api;
})(this);
