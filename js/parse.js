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

  /* LisaScan: labelled controls and numbered samples with printed ratio and flag. */
  function parseLisaScan(lines) {
    const res = { testNo: null, testName: null, printed: null, controls: [], samples: [], skipped: [] };
    for (const { text, conf } of lines) {
      const t = clean(text);
      if (!t) continue;
      let m;
      if ((m = t.match(/Test\s*No\s*[:.]?\s*(\d+)/i))) { res.testNo = +m[1]; continue; }
      if ((m = t.match(/^TEST\s*[:;]\s*(.+)$/i))) { res.testName = m[1].trim(); continue; }
      if ((m = t.match(/GREY\s*ZONE\s*[:;]?\s*(\w+)/i))) { res.printed = { ...(res.printed || {}), greyZone: m[1].toUpperCase() }; continue; }
      if ((m = t.match(/^(m?\s*[NP]C.*?)=\s*(\d*\.\d+)/i))) { res.printed = { ...(res.printed || {}), formula: m[1].replace(/\s+/g, " ").trim(), cutoff: parseFloat(m[2]) }; continue; }
      if (/TEST\s*RESULT|Plate\s*I\.?D|FILTERS|CUTOFF\s*EQ|Analyte|End\s*Of/i.test(t)) continue;
      if ((m = t.match(/^(PC|NC|BLK|BLANK|BL)\b\D*(\d*\.\d+)/i))) {
        let role = m[1].toUpperCase(); if (role.startsWith("BL")) role = "BLK";
        res.controls.push({ role, od: parseFloat(m[2]), conf, raw: text });
        continue;
      }
      const nums = decimals(t);
      if (nums.length >= 2) {
        const before = t.slice(0, t.search(DEC));
        const nm = before.match(/(\d{1,3})\s*$/);
        const flagM = t.match(/\b(N\s?R|R)\s*$/i);
        res.samples.push({ n: nm ? +nm[1] : null, od: nums[0], ratio: nums[1], flag: flagM ? flagM[1].replace(/\s/g, "").toUpperCase() : null, conf, raw: text });
      } else if (nums.length === 1 && /SMP/i.test(t)) {
        res.skipped.push(text);
      }
    }
    // Number samples in order where the number was not read
    let next = 1;
    res.samples.forEach(s => { if (s.n == null || s.n < next || s.n > next + 2) s.n = next; next = s.n + 1; });
    return res;
  }

  function lisaToWells(p) {
    let i = 0;
    const wells = [];
    p.controls.forEach(c => wells.push({ pos: E.posAt(i++), od: c.od, role: c.role, uncertain: c.conf < 75 || undefined, raw: c.raw }));
    p.samples.forEach(s => wells.push({ pos: E.posAt(i++), od: s.od, role: "S", n: s.n, printedRatio: s.ratio, printedFlag: s.flag, uncertain: s.conf < 75 || undefined, raw: s.raw }));
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
      return { format, date, testNo: p.testNo, testName: p.testName, printed: p.printed, wells: lisaToWells(p), skipped: p.skipped };
    }
    const m = parseMerilyzer(lines);
    return { format, date, printed: null, wells: placeSequential(m.entries, opts.startPos), skipped: m.skipped };
  }

  const api = { parse, applyLayout, detect, parseDate, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlipParser = api;
})(this);
