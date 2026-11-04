/* Page code: views, storage on this device, import and export. */
(function () {
  "use strict";
  const ASSAYS = window.ASSAYS, E = window.Engine, P = window.SlipParser, O = window.SlipOCR;
  const byId = Object.fromEntries(ASSAYS.map(a => [a.id, a]));
  const KEY = "erc.runs.v1", PREF = "erc.prefs.v1", DRAFT = "erc.draft.v1";
  const view = document.getElementById("view");

  /* ---------- helpers ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f4 = n => (n == null || !isFinite(n)) ? "–" : Number(n).toFixed(4);
  const f3 = n => (n == null || !isFinite(n)) ? "–" : Number(n).toFixed(3);
  const f2 = n => (n == null || !isFinite(n)) ? "–" : Number(n).toFixed(2);
  const pct = (a, b) => b ? (a / b * 100).toFixed(1) + "%" : "–";
  const numOrNull = v => { if (v === "" || v == null) return null; const n = Number(String(v).replace(",", ".")); return isFinite(n) ? n : null; };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = d => { if (!d) return "No date"; const [y, m, dd] = d.split("-"); return `${+dd} ${MONTHS[+m - 1]} ${y}`; };
  const shortDate = d => { if (!d) return "–"; const [, m, dd] = d.split("-"); return `${+dd} ${MONTHS[+m - 1]}`; };
  const today = () => { const t = new Date(); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCSV = rows => rows.length ? [Object.keys(rows[0]).join(","), ...rows.map(r => Object.values(r).map(csvCell).join(","))].join("\n") : "";

  /* ---------- storage (this device only) ---------- */
  function readJSON(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
  /* Runs whose assay is not in this version are never deleted: they are kept
     aside, saved back with every change and included in backups, so they
     reappear when their assay block is added to js/assays.js. */
  const stored = readJSON(KEY, []);
  const unplaced = Array.isArray(stored) ? stored.filter(r => r && !byId[r.assayId]) : [];
  let runs = Array.isArray(stored) ? stored.filter(r => r && byId[r.assayId]) : [];
  let prefs = readJSON(PREF, { assay: "all", qcAssay: ASSAYS[0].id, auditAssay: ASSAYS[0].id });
  const allRuns = () => runs.concat(unplaced);
  const saveRuns = () => { if (!writeJSON(KEY, allRuns())) toast("This device would not store the runs. Download a backup from Audit."); };
  const savePrefs = () => writeJSON(PREF, prefs);
  const evalRun = r => E.evaluate(r, byId[r.assayId]);
  const sortRuns = list => list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.id).localeCompare(String(a.id)));

  function mergeRuns(incoming) {
    let added = 0, replaced = 0;
    for (const r of incoming) {
      if (!r || !r.id) continue;
      const list = byId[r.assayId] ? runs : unplaced;
      const i = list.findIndex(x => x.id === r.id);
      if (i >= 0) { list[i] = r; replaced++; } else { list.push(r); added++; }
    }
    saveRuns();
    return { added, replaced };
  }
  /* ---------- shared pieces ---------- */
  function chipFor(ev) {
    if (!ev) return `<span class="chip neutral">–</span>`;
    if (!ev.valid) return `<span class="chip bad">Invalid</span>`;
    const n = ev.findings.filter(f => f.sev === "bad" || f.sev === "warn").length;
    return n ? `<span class="chip warn">${n} to review</span>` : `<span class="chip ok">Clear</span>`;
  }
  const findingsHTML = list => `<ul class="findings">${list.map(f => `<li class="${f.sev}"><div><b>${esc(f.title)}</b>${f.detail ? `<p>${esc(f.detail)}</p>` : ""}</div></li>`).join("")}</ul>`;
  const resultText = (a, s) => s.missing ? "–" : a.units ? f2(s.units) : f3(s.ratio);
  const bandName = code => ({ POS: "Positive", NEG: "Negative", EQV: "Equivocal", GZ: "Grey zone", IR: "Reactive" })[code] || "";
  const resultLabel = a => a.units ? (a.units.label || "Units") : "S/CO";
  // result cells for one review row: calculated value and category, or why there is none
  function resultCells(a, w, s, valid) {
    if (w.role !== "S") return `<td class="mono note">${w.role === "BLK" ? "Blank" : w.role}</td><td></td>`;
    if (!s || s.missing || numOrNull(w.od) == null) return `<td class="mono">–</td><td class="note">enter OD</td>`;
    if (s.noCutoff || !s.band) return `<td class="mono">–</td><td class="note">needs controls</td>`;
    const code = s.band.code, cls = E.isReactiveCode(code) ? "st-bad" : /EQV|GZ/.test(code) ? "st-warn" : "";
    return `<td class="mono ${cls}"><b>${resultText(a, s)}</b></td><td class="${cls}"><b>${esc(bandName(code))}</b>${valid ? "" : ' <span class="note">(run invalid)</span>'}</td>`;
  }

  function plateHTML(wells, ev) {
    const byPos = {};
    (wells || []).forEach(w => { if (w.pos) byPos[w.pos] = w; });
    const sampleBy = {}; (ev.samples || []).forEach(s => { sampleBy[s.pos] = s; });
    const top = Math.max(isFinite(ev.cutoff) ? ev.cutoff * 4 : 1, 0.8);
    let h = `<div class="lab"></div>`;
    for (let c = 1; c <= 12; c++) h += `<div class="lab">${c}</div>`;
    for (let r = 0; r < 8; r++) {
      h += `<div class="lab">${E.ROWS[r]}</div>`;
      for (let c = 1; c <= 12; c++) {
        const pos = E.ROWS[r] + c, w = byPos[pos];
        if (!w) { h += `<div class="well vacant" aria-hidden="true"></div>`; continue; }
        const s = sampleBy[pos];
        const od = Number(w.od);
        const k = isFinite(od) ? Math.pow(Math.max(0, Math.min(1, od / top)), 0.6) : 0;
        const bg = k > 0 ? `background:color-mix(in srgb, var(--tmb) ${Math.round(k * 100)}%, var(--well))` : "";
        const cls = ["well", w.role !== "S" ? "ctrl" : "", s && s.band && E.isReactiveCode(s.band.code) ? "r" : "", s && s.band && /EQV|GZ/.test(s.band.code) ? "eq" : ""].join(" ");
        const label = w.role === "S" ? (s ? s.n : "") : (w.role === "BLK" ? "BL" : w.role);
        h += `<div class="${cls}" style="${bg}" title="${pos} · ${w.role === "S" ? "sample " + (s ? s.n : "") : w.role} · OD ${f4(od)}">${esc(label)}</div>`;
      }
    }
    return `<div class="plate-wrap"><div class="plate" role="img" aria-label="Plate layout">${h}</div></div>
      <div class="legend"><span><i style="background:color-mix(in srgb,var(--tmb) 100%,var(--well))"></i>Colour follows OD</span>
      <span><i style="box-shadow:0 0 0 2px var(--bad)"></i>Reactive</span><span><i style="box-shadow:0 0 0 2px var(--warn)"></i>Equivocal or grey zone</span>
      <span><i style="border:3px double var(--well-edge)"></i>Control</span></div>`;
  }

  /* ---------- Runs ---------- */
  function renderRuns(selectedId) {
    const filter = prefs.assay || "all";
    const list = sortRuns(runs.filter(r => filter === "all" || r.assayId === filter));
    const sel = runs.find(r => r.id === selectedId);
    const listHTML = list.length ? list.map(r => {
      const a = byId[r.assayId], ev = evalRun(r), c = E.counts(r, ev);
      const nS = c.samples, nR = c.reactive;
      return `<a class="runitem" href="#run-${encodeURIComponent(r.id)}" aria-current="${sel && sel.id === r.id}">
        <span class="d">${fmtDate(r.date)}</span>${chipFor(ev)}
        <span class="s">${esc(a.name)}${r.plate ? " · plate " + esc(r.plate) : ""} · ${nS} samples · ${nR} reactive${c.fromSlip ? " (controls only)" : ""}${r.kitLot ? " · lot " + esc(r.kitLot) : ""}</span></a>`;
    }).join("") : `<p class="note" style="padding:14px">No runs for this assay yet.</p>`;

    view.innerHTML = `<div class="split ${sel ? "has-detail" : ""}">
      <aside class="panel runlist">
        <div class="head">
          <div class="row between"><h3>Saved runs (${list.length})</h3><a class="btn primary small" href="#add">Add run</a></div>
          <select id="assayFilter" aria-label="Show runs for">
            <option value="all">All assays</option>${ASSAYS.map(a => `<option value="${a.id}" ${filter === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          </select>
        </div>
        <div class="scroll">${listHTML}</div>
      </aside>
      <section class="stack" id="detail">${sel ? detailHTML(sel) : welcomeHTML()}</section>
    </div>`;
    $("#assayFilter").onchange = e => { prefs.assay = e.target.value; savePrefs(); renderRuns(selectedId); };
    if (sel) bindDetail(sel);
    else {
    }
  }

  function welcomeHTML() {
    if (!runs.length) return `<div class="panel empty">
      <h2>No runs on this device yet</h2>
      <p class="note">Add a run by photographing the reader slip, pasting its text or typing the values. Runs saved earlier can be brought back from a backup file under Audit.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="#add">Add a run</a><a class="btn" href="#audit">Restore from backup</a></div></div>`;
    return `<div class="panel empty"><h2>Choose a run</h2><p class="note">Pick a run from the list to see its checks, plate and results.</p></div>`;
  }

  function detailHTML(run) {
    const a = byId[run.assayId], ev = evalRun(run);
    const nR = ev.samples.filter(s => s.band && E.isReactiveCode(s.band.code)).length;
    const nEq = ev.samples.filter(s => s.band && /EQV|GZ/.test(s.band.code)).length;
    const hasReg = ev.samples.some(s => s.labNo || s.regOD != null || s.regUnits != null);
    const hasPrinted = ev.printed != null;
    const ctrlRows = ["NC", "PC", "BLK"].filter(k => ev.ctrlVals[k].length).map(k =>
      `<tr><td>${k === "BLK" ? "Blank" : k === "NC" ? "Negative control" : "Positive control"}</td><td class="n">${ev.ctrlVals[k].map(f4).join(" · ")}</td><td class="c">${ev.ctrlVals[k].length} well${ev.ctrlVals[k].length > 1 ? "s" : ""}</td></tr>`).join("");
    const checkRows = ev.checks.map(c => `<tr><td>${esc(c.rule.text)}</td><td class="n">${Array.isArray(c.value) ? c.value.map(f4).join(", ") || "–" : f4(c.value)}</td>
      <td class="c">${c.pass === null ? '<span class="chip neutral">Not read</span>' : c.pass ? '<span class="chip ok">Pass</span>' : '<span class="chip bad">Fail</span>'}</td></tr>`).join("");
    const unitHead = a.units ? "Units" : "Ratio";
    const rows = ev.samples.map(s => {
      const notes = [];
      if (s.missing) notes.push("OD missing");
      if (s.readerDiscordant) notes.push("Reader and insert differ");
      if (s.inGap) notes.push("Between reader and insert cutoffs");
      if (s.printedRatioMismatch) notes.push("Printed ratio does not match");
      if (s.regODMatch === false) notes.push(`Register OD ${s.regOD}${s.regUncertain ? " (to verify)" : ""}`);
      if (s.regUnitsMatch === false) notes.push(`Register ${a.units ? "units" : "ratio"} ${s.regUnits}${s.regUncertain ? " (to verify)" : ""}`);
      if (s.uncertain) notes.push("Hard to read on slip");
      const code = s.band ? s.band.code : "";
      const cls = [E.isReactiveCode(code) ? "rx" : "", /EQV|GZ/.test(code) ? "eq" : "", (s.readerDiscordant || s.regODMatch === false || s.regUnitsMatch === false) ? "bad" : (notes.length ? "flag" : "")].join(" ");
      return `<tr class="${cls}"><td class="l">${s.pos}</td><td>${s.n}</td><td class="l">${esc(s.labNo || "")}</td><td>${f4(s.od)}</td>
        ${hasPrinted ? `<td>${s.printedRatio != null ? f4(s.printedRatio) : "–"}</td><td class="l">${esc(s.printedFlag || "–")}</td>` : ""}
        <td>${resultText(a, s)}</td><td class="l"><b>${s.band ? esc(s.band.code === "POS" ? "Positive" : s.band.code === "NEG" ? "Negative" : s.band.code === "EQV" ? "Equivocal" : s.band.code === "GZ" ? "Grey zone" : "Init. reactive") : "–"}</b></td>
        ${hasReg ? `<td>${s.regOD != null ? esc(s.regOD) : ""}</td><td>${s.regUnits != null ? esc(s.regUnits) : ""}</td>` : ""}
        <td class="t">${esc(notes.join("; "))}</td></tr>`;
    }).join("");
    return `
      <a class="btn small back" href="#runs">← All runs</a>
      <div class="tiles">
        <div><span class="k">Run</span><span class="v ${ev.valid ? "st-ok" : "st-bad"}">${ev.valid ? "Valid" : "Invalid"}</span><span class="s">${fmtDate(run.date)}${run.plate ? " · plate " + esc(run.plate) : ""} · ${esc(a.name)}${run.reader ? " · " + esc(run.reader) : ""}</span></div>
        <div><span class="k">Insert cutoff</span><span class="v">${f4(ev.cutoff)}</span><span class="s">${esc(ev.floorApplied ? "Floor applied: " : "")}${esc(a.cutoff.text)}</span></div>
        ${hasPrinted ? `<div><span class="k">Reader cutoff</span><span class="v ${Math.abs(ev.printed - ev.cutoff) > 0.0006 ? "st-warn" : ""}">${f4(ev.printed)}</span><span class="s">${esc(run.printed.formula || "")}${run.printed.greyZone ? " · grey zone " + esc(run.printed.greyZone) : ""}</span></div>` : ""}
        ${ev.samples.length || !run.slip ? `<div><span class="k">Results</span><span class="v">${nR} / ${ev.samples.length}</span><span class="s">reactive${nEq ? ` · ${nEq} equivocal or grey zone` : ""}</span></div>`
          : `<div><span class="k">From the slip</span><span class="v">${run.slip.reactive} / ${run.slip.samples}</span><span class="s">reactive (${esc(run.slip.reactiveBy || "reader flags")}); sample ODs not transcribed</span></div>`}
      </div>
      ${a.provisional ? `<div class="panel provisional"><h2>Provisional rules</h2><p class="note">${esc(a.provisional)}</p></div>` : ""}
      <div class="panel"><div class="row between"><h2>Findings</h2>${chipFor(ev)}</div>${findingsHTML(ev.findings)}</div>
      <div class="grid2">
        <div class="panel"><h2>Controls and run validity</h2>
          <table class="checks"><tbody>${ctrlRows}${checkRows}</tbody></table>
          <p class="note">Kit: ${esc(a.kit)}, ${esc(a.maker)}. Insert ${esc(a.insert)}.${run.kitLot ? " Lot " + esc(run.kitLot) + "." : ""}${run.notes ? " Notes: " + esc(run.notes) : ""}${run.qcExclude ? " Left out of QC limits (" + esc(run.qcExclude.ctrls.join(", ")) + "): " + esc(run.qcExclude.reason) + "." : ""}</p>
        </div>
        <div class="panel"><h2>Plate</h2>${plateHTML(run.wells, ev)}</div>
      </div>
      <div class="panel"><div class="row between"><h2>Samples</h2><span class="note">${a.units ? "Units = OD ÷ cutoff × " + a.units.factor : "Ratio = OD ÷ cutoff"}</span></div>
        <div class="tbl tall"><table class="data"><thead><tr><th class="l">Well</th><th>No.</th><th class="l">Lab no.</th><th>OD</th>
        ${hasPrinted ? "<th>Printed ratio</th><th class=\"l\">Flag</th>" : ""}<th>${unitHead}</th><th class="l">Result</th>
        ${hasReg ? "<th>Register OD</th><th>Register " + unitHead.toLowerCase() + "</th>" : ""}<th class="l">Check</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="panel"><h2>Run record</h2>
        <div class="fields"><div><h3>Test no.</h3><span class="mono">${esc(run.testNo ?? "–")}</span></div><div><h3>Kit lot</h3><span class="mono">${esc(run.kitLot || "–")}</span></div><div><h3>Source</h3><span>${esc(run.source || "–")}</span></div></div>
        ${run.notes ? `<p class="note">${esc(run.notes)}</p>` : ""}
        <div class="row" id="runActions"><a class="btn" href="#edit-${encodeURIComponent(run.id)}">Edit run</a><button class="btn" id="csvRun">Download CSV</button><button class="btn danger" id="delRun">Delete run</button></div>
      </div>`;
  }

  function bindDetail(run) {
    $("#csvRun").onclick = () => download(`${run.assayId}_${run.date}.csv`, toCSV(sampleRows([run])), "text/csv");
    $("#delRun").onclick = () => {
      const box = $("#runActions");
      box.innerHTML = `<span class="confirm">Delete this run from this device? <button class="btn danger small" id="delYes">Delete</button><button class="btn small" id="delNo">Keep</button></span>`;
      $("#delNo").onclick = () => renderRuns(run.id);
      $("#delYes").onclick = () => { runs = runs.filter(r => r.id !== run.id); saveRuns(); toast("Run deleted"); location.hash = "#runs"; };
    };
  }

  /* ---------- Add / edit run ---------- */
  let draft = null;
  function newDraft(base) {
    const assayId = (base && base.assayId) || (prefs.assay !== "all" && prefs.assay) || ASSAYS[0].id;
    return {
      id: base ? base.id : null, assayId, date: base ? base.date : "", kitLot: base?.kitLot || "", testNo: base?.testNo ?? "",
      notes: base?.notes || "", source: base?.source || "", printed: base?.printed ? { ...base.printed } : null,
      wells: base ? base.wells.map(w => ({ ...w })) : [], rolesTouched: !!base, format: base ? (base.printed ? "lisascan" : "merilyzer") : null, expected: "",
      pcNotRun: !!(base && base.pcNotRun)
    };
  }
  const saveDraft = () => { if (draft && !draft.id) { draft.updated = new Date().toISOString(); const { restored, ...keep } = draft; writeJSON(DRAFT, keep); } };

  function renderEditor(editId) {
    if (editId) {
      const r = runs.find(x => x.id === editId);
      if (!r) { location.hash = "#runs"; return; }
      if (!draft || draft.id !== editId) draft = newDraft(r);
    } else if (!draft || draft.id) {
      const saved = readJSON(DRAFT, null);
      draft = saved && !saved.id ? saved : newDraft(null);
      draft.restored = !!(saved && !saved.id && (saved.wells || []).length);
    }
    const a = byId[draft.assayId];
    view.innerHTML = `<div class="stack">
      <div class="panel">
        <div class="row between"><h2>${draft.id ? "Edit run" : "Add a run"}</h2>${draft.id ? `<a class="btn small" href="#run-${encodeURIComponent(draft.id)}">Cancel</a>` : `<button class="btn small" id="clearDraft">Start over</button>`}</div>
        <div class="fields">
          <label class="f" for="fAssay">Assay<select id="fAssay">${ASSAYS.map(x => `<option value="${x.id}" ${x.id === draft.assayId ? "selected" : ""}>${esc(x.name)} · ${esc(x.maker)}</option>`).join("")}</select></label>
          <label class="f" for="fDate">Run date<input id="fDate" type="date" value="${esc(draft.date)}"></label>
          <label class="f" for="fLot">Kit lot<input id="fLot" value="${esc(draft.kitLot)}" placeholder="From the kit box"></label>
          <label class="f" for="fTest">Test no. on slip<input id="fTest" inputmode="numeric" value="${esc(draft.testNo)}"></label>
        </div>
        <label class="f" for="fNotes">Notes<input id="fNotes" value="${esc(draft.notes)}" placeholder="Repeats, corrections, anything unusual"></label>
        ${draft.restored ? `<p class="note st-warn">An unsaved run from earlier${draft.updated ? ` (${esc(new Date(draft.updated).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))})` : ""} is open, with ${draft.wells.length} wells. Press <b>Start over</b> to begin a fresh run, or carry on with it.</p>` : ""}
      </div>

      <div class="panel" id="capture">
        <div class="row between"><h2>Read the slip</h2><span class="note">Reader: ${esc(a.reader)}</span></div>
        <div class="dropzone">
          <p class="note"><b>Scan with camera</b> straightens the slip and evens out the light before reading. For the best result, scan the slip <b>before</b> anything is highlighted or written on it, flat and in good light. Strips can be laid side by side. Photos already taken can be used with <b>Choose photo</b>.</p>
          <div class="row">
            <button class="btn primary" id="scanCam">Scan with camera</button>
            <label class="btn" for="photo">Choose photo</label>
            <input id="photo" type="file" accept="image/*" hidden>
            <input id="photoCam" type="file" accept="image/*" capture="environment" hidden>
            <button class="btn" id="showPaste">Paste slip text</button>
            <button class="btn" id="addBlank">Type values</button>
          </div>
          <label class="f" for="startPos" style="max-width:220px">Next reading starts at well<input id="startPos" value="${esc(nextPos())}" placeholder="A1"></label>
        </div>
        <div id="photoArea" hidden></div>
        <div id="pasteArea" hidden class="stack">
          <textarea id="pasteText" spellcheck="false" placeholder="One line per slip entry, for example:&#10;A1 0.0448&#10;B1 0.034&#10;&#10;or, for a slip with a cutoff:&#10;mNC + 0.15 = 0.1561&#10;PC 2.4597&#10;NC 0.0023&#10;SMP 1 0.0015 0.0097 NR"></textarea>
          <div class="row"><button class="btn primary" id="readPaste">Read text</button><button class="btn" id="hidePaste">Close</button></div>
        </div>
      </div>

      <div class="panel" id="review">${reviewHTML()}</div>
      <div class="panel" id="preview"></div>
    </div>`;
    bindEditor();
    renderPreview();
  }

  function nextPos() {
    const ws = draft.wells.filter(w => w.pos);
    if (!ws.length) return "A1";
    const last = Math.max(...ws.map(w => E.posIndex(w.pos)));
    return E.posAt(last + 1) || "";
  }

  function reviewHTML() {
    const a = byId[draft.assayId];
    if (!draft.wells.length) return `<h2>Check every value</h2><p class="note">Values read from the slip appear here for checking before anything is saved.</p>`;
    const showPrinted = !!a.readerProgram || draft.format === "lisascan";
    const ev = E.evaluate(draft, a);
    const sBy = {}; ev.samples.forEach(s => { sBy[s.pos] = s; });
    const nMissing = draft.wells.filter(w => numOrNull(w.od) == null).length;
    const nUnsure = draft.wells.filter(w => w.uncertain).length;
    const nLabel = draft.wells.filter(w => w.labelMismatch || w.checkOrder).length;
    const nRatio = ev.samples.filter(s => s.printedRatioMismatch).length;
    const ctrlCount = k => draft.wells.filter(w => w.role === k).length;
    const exp = numOrNull(draft.expected);
    const showReg = !!prefs.showRegister;
    const rows = draft.wells.map((w, i) => {
      const s = sBy[w.pos];
      const notes = [];
      if (numOrNull(w.od) == null) notes.push("missing");
      if (w.uncertain) notes.push("hard to read");
      if (w.rereadFixed) notes.push("corrected by a second reading (agrees with the printed ratio)");
      if (w.rereadAlt != null && numOrNull(w.od) != null && Math.abs(w.rereadAlt - Number(w.od)) > 1e-9) notes.push(`second reading: ${w.rereadAlt}`);
      if (w.labelMismatch) notes.push(`slip label read as ${w.labelMismatch}`);
      if (w.checkOrder) notes.push("a nearby line was missed; check these values are in the right wells");
      if (s && s.printedRatioMismatch) notes.push("ratio does not match");
      const code = s && s.band ? s.band.code : "";
      const cls = [numOrNull(w.od) == null ? "missing" : notes.length ? "flag" : "", E.isReactiveCode(code) ? "rx pos" : /EQV|GZ/.test(code) ? "eq" : ""].join(" ").trim();
      return `<tr class="${cls}" data-i="${i}">
        <td><input data-k="pos" value="${esc(w.pos)}" size="4" aria-label="Well"></td>
        <td><select data-k="role" aria-label="Role">${["S", "NC", "PC", "BLK"].map(r => `<option value="${r}" ${w.role === r ? "selected" : ""}>${r === "S" ? "Sample" : r === "BLK" ? "Blank" : r}</option>`).join("")}</select></td>
        <td><input data-k="od" inputmode="decimal" value="${w.od ?? ""}" aria-label="OD"></td>
        ${showPrinted ? `<td><input data-k="printedRatio" inputmode="decimal" value="${w.printedRatio ?? ""}" aria-label="Printed ratio"></td><td><input data-k="printedFlag" value="${esc(w.printedFlag || "")}" size="3" aria-label="Printed flag"></td>` : ""}
        ${resultCells(a, w, s, ev.valid)}
        ${showReg ? `<td><input data-k="labNo" value="${esc(w.labNo || "")}" aria-label="Lab number"></td>
        <td><input data-k="regOD" inputmode="decimal" value="${w.regOD ?? ""}" aria-label="Register OD"></td>
        <td><input data-k="regUnits" inputmode="decimal" value="${w.regUnits ?? ""}" aria-label="Register result"></td>` : ""}
        <td style="text-align:center"><input type="checkbox" data-k="uncertain" ${w.uncertain ? "checked" : ""} aria-label="Hard to read" style="width:auto"></td>
        <td class="t note-cell">${esc(notes.join("; "))}</td>
        <td><button class="btn small" data-del="${i}" aria-label="Remove well ${esc(w.pos)}">×</button></td></tr>`;
    }).join("");
    return `<div class="row between"><h2>Check every value against the slip</h2>
        <div class="row"><button class="btn small primary" id="recalc">Recalculate</button><button class="btn small" id="applyLayout">Mark usual controls</button><button class="btn small" id="addRow">Add well</button><button class="btn small" id="toggleReg">${showReg ? "Hide register columns" : "Compare with register"}</button></div></div>
      <p class="note">Compare each row with the slip; rows shaded amber need a look (untick <b>Unclear</b> once checked). The ${esc(resultLabel(a))} and result are calculated from the insert and update as you type; positive samples are shown in red. After changing controls or values, press <b>Recalculate</b> to refresh everything. <b>Compare with register</b> adds columns to check what was written by hand.</p>
      <div class="fields">
        <div><h3>Wells</h3><span class="mono">${draft.wells.length}</span></div>
        <div><h3>Controls</h3><span class="mono">NC ${ctrlCount("NC")} · PC ${ctrlCount("PC")}${ctrlCount("BLK") ? " · blank " + ctrlCount("BLK") : ""}</span></div>
        <div><h3>To check</h3><span class="mono ${nMissing + nUnsure + nLabel + nRatio ? "st-warn" : "st-ok"}">${nMissing} missing · ${nUnsure} unclear${nLabel ? ` · ${nLabel} label` : ""}${nRatio ? ` · ${nRatio} ratio` : ""}</span></div>
        <label class="f" for="fExpected">Tests in register<input id="fExpected" inputmode="numeric" value="${esc(draft.expected)}" placeholder="optional"></label>
      </div>
      ${exp != null && exp !== ev.samples.length ? `<p class="note st-warn">The register lists ${exp} tests but ${ev.samples.length} sample wells were read. A line may have been missed or a control marked as a sample.</p>` : ""}
      ${showPrinted ? `<div class="fields">
        <label class="f" for="pCut">Printed cutoff<input id="pCut" inputmode="decimal" value="${draft.printed?.cutoff ?? ""}"></label>
        <label class="f" for="pForm">Printed formula<input id="pForm" value="${esc(draft.printed?.formula || "")}" placeholder="${esc(a.readerProgram?.text || "")}"></label>
        <label class="f" for="pGrey">Grey zone on slip<input id="pGrey" value="${esc(draft.printed?.greyZone || "")}" placeholder="NO"></label></div>` : ""}
      ${controlsHTML(a)}
      <div class="tbl tall"><table class="data edit" id="wellTable"><thead><tr><th class="l">Well</th><th class="l">Role</th><th class="l">OD</th>
        ${showPrinted ? '<th class="l">Printed ratio</th><th class="l">Flag</th>' : ""}<th class="l">${esc(resultLabel(a))}</th><th class="l">Result</th>${showReg ? `<th class="l">Lab no.</th><th class="l">Register OD</th><th class="l">Register ${a.units ? "units" : "ratio"}</th>` : ""}<th>Unclear</th><th class="l">Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }

  function renderReview() { $("#review").innerHTML = reviewHTML(); bindReview(); renderPreview(); $("#startPos") && ($("#startPos").value = nextPos()); saveDraft(); }

  function renderPreview() {
    const box = $("#preview"); if (!box) return;
    const a = byId[draft.assayId];
    if (!draft.wells.length) { box.innerHTML = `<h2>Result</h2><p class="note">The run is checked against the insert as soon as values are entered.</p>`; return; }
    const ev = E.evaluate(draft, a);
    const nR = ev.samples.filter(s => s.band && E.isReactiveCode(s.band.code)).length;
    box.innerHTML = `<div class="row between"><h2>Result</h2>${chipFor(ev)}</div>
      <div class="tiles">
        <div><span class="k">Run</span><span class="v ${ev.valid ? "st-ok" : "st-bad"}">${ev.valid ? "Valid" : "Invalid"}</span></div>
        <div><span class="k">Insert cutoff</span><span class="v">${f4(ev.cutoff)}</span></div>
        <div><span class="k">Reactive</span><span class="v">${nR} / ${ev.samples.length}</span></div>
      </div>
      ${findingsHTML(ev.findings)}
      <div class="row"><button class="btn primary" id="saveRun">Save run</button><span class="note" id="saveMsg"></span></div>`;
    $("#saveRun").onclick = saveRun;
  }

  function bindEditor() {
    const a = () => byId[draft.assayId];
    const set = (id, k) => $(id).addEventListener("change", e => { draft[k] = e.target.value; saveDraft(); renderPreview(); });
    set("#fDate", "date"); set("#fLot", "kitLot"); set("#fTest", "testNo"); set("#fNotes", "notes");
    $("#fAssay").onchange = e => {
      draft.assayId = e.target.value;
      if (!draft.rolesTouched && draft.format !== "lisascan") defaultRoles(false);
      saveDraft(); renderEditor(draft.id);
    };
    const clr = $("#clearDraft");
    if (clr) clr.onclick = () => { draft = newDraft(null); try { localStorage.removeItem(DRAFT); } catch (e) { } renderEditor(null); };
    $("#photo").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openPhoto(f); };
    $("#photoCam").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openPhoto(f); };
    $("#scanCam").onclick = openCamera;
    $("#showPaste").onclick = () => { $("#pasteArea").hidden = false; $("#pasteText").focus(); };
    $("#hidePaste").onclick = () => { $("#pasteArea").hidden = true; };
    $("#readPaste").onclick = () => { ingest(P.parse($("#pasteText").value, { startPos: $("#startPos").value || "A1", layout: byId[draft.assayId].layout })); $("#pasteArea").hidden = true; $("#pasteText").value = ""; };
    $("#addBlank").onclick = () => {
      const start = Math.max(0, E.posIndex($("#startPos").value || "A1"));
      for (let i = 0; i < 8; i++) { const p = E.posAt(start + i); if (p) draft.wells.push({ pos: p, od: null, role: "S" }); }
      if (!draft.format) draft.format = "merilyzer";
      autoRoles(); renderReview();
    };
    bindReview();
  }

  function bindReview() {
    const tb = $("#wellTable tbody");
    if (tb) {
      tb.addEventListener("change", e => {
        const tr = e.target.closest("tr"); if (!tr) return;
        const w = draft.wells[+tr.dataset.i], k = e.target.dataset.k; if (!w || !k) return;
        if (k === "uncertain") w.uncertain = e.target.checked || undefined;
        else if (k === "role") { w.role = e.target.value; draft.rolesTouched = true; ctrlFromRoles(); }
        else if (k === "pos") w.pos = e.target.value.trim().toUpperCase();
        else if (["od", "printedRatio", "regOD", "regUnits"].includes(k)) { w[k] = numOrNull(e.target.value); if (k === "od") { delete w.missing; delete w.labelMismatch; delete w.checkOrder; } }
        else w[k] = e.target.value.trim() || undefined;
        if (k === "role" || k === "pos") renderReview(); else { refreshRow(tr); renderPreview(); saveDraft(); }
      });
      tb.addEventListener("click", e => {
        const b = e.target.closest("[data-del]"); if (!b) return;
        draft.wells.splice(+b.dataset.del, 1); renderReview();
      });
    }
    const lay = $("#applyLayout");
    if (lay) lay.onclick = () => { defaultRoles(true); renderReview(); toast("Controls marked in the usual positions"); };
    const ct = $("#ctrlTable tbody");
    if (ct) {
      ct.addEventListener("change", e => {
        const tr = e.target.closest("tr[data-c]"); if (!tr) return;
        const r = draft.ctrl[+tr.dataset.c], k = e.target.dataset.ck; if (!r || !k) return;
        if (k === "confirmed") r.confirmed = e.target.checked;
        else if (k === "pos") { r.pos = e.target.value.trim().toUpperCase(); r.confirmed = false; }
        else if (k === "od") { r.od = e.target.value.trim(); r.confirmed = false; }
        else r[k] = e.target.value;
        syncControls(); renderReview();
      });
      ct.addEventListener("click", e => { const b = e.target.closest("[data-cdel]"); if (!b) return; draft.ctrl.splice(+b.dataset.cdel, 1); syncControls(); renderReview(); });
    }
    const cadd = $("#ctrlAdd");
    if (cadd) cadd.onclick = () => { (draft.ctrl = draft.ctrl || []).push({ role: draft.ctrl.some(r => r.role === "NC") ? "PC" : "NC", pos: "", od: "", confirmed: false }); renderReview(); };
    const nopc = $("#cNoPC");
    if (nopc) nopc.onchange = e => {
      draft.pcNotRun = e.target.checked;
      if (draft.pcNotRun) {
        // no PC on this plate: the well marked PC was a sample or nothing; drop empty placeholder rows
        draft.wells = draft.wells.filter(w => !(w.role === "PC" && w.ctrlPlaceholder && numOrNull(w.od) == null));
        draft.wells.forEach(w => { if (w.role === "PC") { if (w.ctrlTyped) { w.od = w.readOd; delete w.ctrlTyped; delete w.readOd; } w.role = "S"; } });
        draft.ctrl = (draft.ctrl || []).filter(r => r.role !== "PC");
        draft.rolesTouched = true;
      }
      renderReview();
    };
    const rc = $("#recalc");
    if (rc) rc.onclick = () => { if (draft.ctrl) syncControls(); renderReview(); const pv = $("#preview"); if (pv) pv.scrollIntoView({ behavior: "smooth", block: "start" }); toast("Recalculated with the current controls and values"); };
    const tr2 = $("#toggleReg");
    if (tr2) tr2.onclick = () => { prefs.showRegister = !prefs.showRegister; savePrefs(); renderReview(); };
    const add = $("#addRow");
    if (add) add.onclick = () => { draft.wells.push({ pos: nextPos(), od: null, role: "S" }); renderReview(); };
    const ex = $("#fExpected");
    if (ex) ex.onchange = e => { draft.expected = e.target.value; renderReview(); };
    const pc = $("#pCut");
    if (pc) {
      const upd = () => { draft.printed = { cutoff: numOrNull($("#pCut").value), formula: $("#pForm").value.trim(), greyZone: $("#pGrey").value.trim().toUpperCase() }; if (draft.printed.cutoff == null && !draft.printed.formula) draft.printed = null; renderReview(); };
      ["#pCut", "#pForm", "#pGrey"].forEach(id => $(id).addEventListener("change", upd));
    }
  }

  function refreshRow(tr) {
    const a = byId[draft.assayId];
    const ev = E.evaluate(draft, a);
    const w = draft.wells[+tr.dataset.i];
    const s = ev.samples.find(x => x.pos === w.pos);
    const notes = [];
    if (numOrNull(w.od) == null) notes.push("missing");
    if (w.uncertain) notes.push("hard to read");
    if (w.labelMismatch) notes.push(`slip label read as ${w.labelMismatch}`);
    if (w.checkOrder) notes.push("a nearby line was missed; check these values are in the right wells");
    if (s && s.printedRatioMismatch) notes.push("ratio does not match");
    // a value change can move the cutoff (controls) or this sample's result: redraw the table
    if (w.role !== "S") { renderReview(); return; }
    const code = s && s.band ? s.band.code : "";
    tr.className = [numOrNull(w.od) == null ? "missing" : notes.length ? "flag" : "", E.isReactiveCode(code) ? "rx pos" : /EQV|GZ/.test(code) ? "eq" : ""].join(" ").trim();
    const nc = $(".note-cell", tr); if (nc) nc.textContent = notes.join("; ");
    const tds = tr.querySelectorAll("td"), odTd = tr.querySelector('[data-k="od"]').closest("td");
    let k = [...tds].indexOf(odTd) + 1;
    if (a.readerProgram || draft.format === "lisascan") k += 2;
    const tmp = document.createElement("tbody"); tmp.innerHTML = `<tr>${resultCells(a, w, s, ev.valid)}</tr>`;
    const nu = tmp.querySelectorAll("td");
    if (tds[k] && tds[k + 1]) { tds[k].replaceWith(nu[0]); tds[k + 1].replaceWith(nu[1]); }
  }

  /* Control wells: the user states where controls were placed. Defaults come from the last saved run of
     the same assay (the same pattern: last wells, first wells, or fixed wells), else the kit's usual layout. */
  /* ---------- Control wells (option A): one row per control, with well and OD typed from the slip ----------
     The typed OD is what the calculation uses. It is compared with what was read for that well; a difference
     must be corrected or confirmed before saving. The value is also looked for in other wells (a misread well
     label), and checked against the insert limit and this lot's history. */
  const CTRL_ROLES = ["NC", "PC", "BLK"];
  const same4 = (x, y) => x != null && y != null && Math.abs(Number(x) - Number(y)) < 0.00006;
  function ctrlFromRoles() {
    const prev = new Map((draft.ctrl || []).map(r => [r.role + "@" + r.pos, r]));
    draft.ctrl = draft.wells.filter(w => w.role !== "S").sort((x, y) => E.posIndex(x.pos) - E.posIndex(y.pos))
      .map(w => {
        const p = prev.get(w.role + "@" + w.pos);
        if (p) return { role: w.role, pos: w.pos, od: p.od, confirmed: p.confirmed };
        // a saved run being edited: its controls were already typed and checked
        if (w.ctrlTyped) return { role: w.role, pos: w.pos, od: String(w.od ?? ""), confirmed: !same4(w.readOd, w.od) };
        return { role: w.role, pos: w.pos, od: "", confirmed: false };
      });
  }
  function syncControls() {
    const rows = (draft.ctrl || []).filter(r => E.isPos(r.pos));
    const want = new Map(rows.map(r => [r.pos, r]));
    draft.wells.forEach(w => {
      const r = want.get(w.pos);
      if (!r) { if (w.ctrlTyped) { w.od = w.readOd; delete w.ctrlTyped; delete w.readOd; } if (w.role !== "S") w.role = "S"; return; }
      w.role = r.role;
    });
    rows.forEach(r => { if (!draft.wells.some(w => w.pos === r.pos)) draft.wells.push({ pos: r.pos, od: null, role: r.role, missing: true, ctrlPlaceholder: true }); });
    // drop empty placeholder rows no longer listed as controls
    draft.wells = draft.wells.filter(w => !(w.ctrlPlaceholder && !want.has(w.pos) && numOrNull(w.od) == null && !w.ctrlTyped));
    draft.wells.forEach(w => {
      const r = want.get(w.pos); if (!r) return;
      const typed = numOrNull(r.od);
      if (typed != null) { if (!w.ctrlTyped) { w.readOd = numOrNull(w.od); w.ctrlTyped = true; } w.od = typed; delete w.missing; }
      else if (w.ctrlTyped) { w.od = w.readOd; delete w.ctrlTyped; delete w.readOd; }
    });
    draft.wells.sort((x, y) => E.posIndex(x.pos) - E.posIndex(y.pos));
    if (rows.some(r => r.role === "PC")) draft.pcNotRun = false;
    draft.rolesTouched = true;
  }
  function lotHistory(role) {
    const vals = [];
    runs.filter(r => r.assayId === draft.assayId && r.id !== draft.id && (!draft.kitLot || !r.kitLot || r.kitLot === draft.kitLot))
      .forEach(r => (r.wells || []).forEach(w => { if (w.role === role && numOrNull(w.od) != null) vals.push(Number(w.od)); }));
    if (vals.length < 5) return null;
    const m = vals.reduce((t, v) => t + v, 0) / vals.length, sd = Math.sqrt(vals.reduce((t, v) => t + (v - m) ** 2, 0) / (vals.length - 1));
    return { m, sd, n: vals.length };
  }
  function ctrlChecks(a) {
    return (draft.ctrl || []).map((r, i) => {
      const out = { i, status: "", text: "", block: false };
      if (!r.pos) { out.status = "warn"; out.text = "Enter the well"; out.block = true; return out; }
      if (!E.isPos(r.pos)) { out.status = "bad"; out.text = `${r.pos} is not a well (A1 to H12)`; out.block = true; return out; }
      const w = draft.wells.find(x => x.pos === r.pos);
      const read = w ? (w.ctrlTyped ? w.readOd : numOrNull(w.od)) : null;
      const typed = numOrNull(r.od);
      const msgs = [];
      if (typed == null) { out.status = "warn"; out.text = read != null ? `Type the OD from the slip (read as ${read})` : "Type the OD from the slip"; out.block = true; return out; }
      if (read == null) msgs.push({ s: "ok", t: `Not read from the slip; your value is used` });
      else if (same4(read, typed)) msgs.push({ s: "ok", t: "Matches the slip reading" });
      else {
        const elsewhere = draft.wells.filter(x => x.pos !== r.pos && same4(x.ctrlTyped ? x.readOd : x.od, typed)).map(x => x.pos);
        msgs.push({ s: r.confirmed ? "ok" : "bad", t: `${r.pos} was read as ${read}` + (elsewhere.length ? `; ${typed} was read in ${elsewhere.join(", ")}. Check the well` : "") + (r.confirmed ? " (confirmed: slip shows the typed value)" : "") });
        if (!r.confirmed) out.block = true, out.mismatch = true;
      }
      // insert limit for a single control value
      (a.validity || []).filter(v => v.ctrl === r.role && typeof v.value === "number" && !/ref/.test(v.op)).forEach(v => {
        const ok = v.op === "<" ? typed < v.value : v.op === "<=" ? typed <= v.value : v.op === ">" ? typed > v.value : v.op === ">=" ? typed >= v.value : true;
        if (!ok) msgs.push({ s: "warn", t: r.role === "PC" ? `Below the insert limit (${v.text}): is this really the PC well?` : `Outside the insert limit (${v.text})` });
      });
      const h = lotHistory(r.role);
      if (h && h.sd > 0 && Math.abs(typed - h.m) > 3 * h.sd) msgs.push({ s: "warn", t: `Unusual for this ${draft.kitLot ? "lot" : "assay"} (usual ${h.m.toFixed(3)} ± ${(3 * h.sd).toFixed(3)}, ${h.n} runs): check the well` });
      out.status = msgs.some(m => m.s === "bad") ? "bad" : msgs.some(m => m.s === "warn") ? "warn" : "ok";
      out.text = msgs.map(m => m.t).join(". ");
      return out;
    });
  }
  function controlsHTML(a) {
    if (!draft.ctrl) ctrlFromRoles();
    const checks = ctrlChecks(a);
    const icon = st => st === "ok" ? "✔" : st === "bad" ? "✘" : "!";
    const rows = (draft.ctrl || []).map((r, i) => {
      const c = checks[i];
      return `<tr class="${c.status === "bad" ? "missing" : c.status === "warn" ? "flag" : ""}" data-c="${i}">
        <td><select data-ck="role" aria-label="Control">${CTRL_ROLES.map(x => `<option value="${x}" ${r.role === x ? "selected" : ""}>${x === "BLK" ? "Blank" : x}</option>`).join("")}</select></td>
        <td><input data-ck="pos" value="${esc(r.pos)}" size="4" placeholder="E4" aria-label="Well"></td>
        <td><input data-ck="od" inputmode="decimal" value="${esc(r.od ?? "")}" placeholder="from slip" aria-label="OD from slip"></td>
        <td class="t"><span class="${c.status === "ok" ? "st-ok" : c.status === "bad" ? "st-bad" : "st-warn"}">${icon(c.status)}</span> ${esc(c.text)}
          ${c.mismatch || r.confirmed ? `<label class="note" style="display:block;margin-top:4px"><input type="checkbox" data-ck="confirmed" ${r.confirmed ? "checked" : ""} style="width:auto"> The slip shows ${esc(r.od)} for ${esc(r.pos)}</label>` : ""}</td>
        <td><button class="btn small" data-cdel="${i}" aria-label="Remove control">×</button></td></tr>`;
    }).join("");
    const blocking = checks.filter(c => c.block).length;
    return `<div class="row between" style="margin-top:14px"><h3>Controls on this plate</h3>
        <div class="row"><button class="btn small" id="ctrlAdd">Add control</button></div></div>
      <p class="note">For each control, check the well and type its OD from the slip. The typed OD is used for the calculation and checked against what was read. ${draft.format === "lisascan" ? "Wells come from the control lines printed on the slip." : (prefs.ctrlPat && prefs.ctrlPat[draft.assayId] ? `Wells are filled in as on your last ${esc(a.name)} run.` : "Wells are filled in from the kit's usual layout.")}</p>
      <div class="tbl"><table class="data edit" id="ctrlTable"><thead><tr><th class="l">Control</th><th class="l">Well</th><th class="l">OD from slip</th><th class="l">Check</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="note">No controls entered. Add the NC and PC wells.</td></tr>`}</tbody></table></div>
      <div class="row" style="margin:6px 0 12px"><label class="note" for="cNoPC"><input type="checkbox" id="cNoPC" ${draft.pcNotRun ? "checked" : ""} style="width:auto"> PC not run on this plate</label>
        <span class="note ${blocking ? "st-warn" : "st-ok"}">${blocking ? `${blocking} control${blocking > 1 ? "s" : ""} to complete before saving` : (draft.ctrl || []).length ? "Controls checked" : ""}</span></div>`;
  }
  function defaultRoles(force) {
    if (draft.format === "lisascan" && !force) return;
    const pat = prefs.ctrlPat && prefs.ctrlPat[draft.assayId];
    if (pat && pat.where === "fixed") {
      const m = new Map(pat.wells.map(x => [x.pos, x.role]));
      draft.wells = draft.wells.map(w => ({ ...w, role: m.get(w.pos) || "S" }));
    } else {
      draft.wells = P.applyLayout(draft.wells, pat || byId[draft.assayId].layout);
    }
    draft.rolesTouched = false;
    ctrlFromRoles();
  }
  function rememberControls(run) {
    if (draft.format === "lisascan") return;
    const ws = run.wells.slice().sort((x, y) => E.posIndex(x.pos) - E.posIndex(y.pos));
    const ctrl = ws.map((w, i) => ({ i, w })).filter(x => x.w.role !== "S");
    // a plate run without a PC is an exception; do not make it the pattern for later runs
    if (!ctrl.length || run.pcNotRun || !ctrl.some(x => x.w.role === "PC")) return;
    const k = ctrl.length, n = ws.length;
    let pat;
    if (ctrl.every((x, j) => x.i === n - k + j)) pat = { where: "end", order: ctrl.map(x => x.w.role) };
    else if (ctrl.every((x, j) => x.i === j)) pat = { where: "start", order: ctrl.map(x => x.w.role) };
    else pat = { where: "fixed", wells: ctrl.map(x => ({ pos: x.w.pos, role: x.w.role })) };
    prefs.ctrlPat = { ...(prefs.ctrlPat || {}), [run.assayId]: pat };
    savePrefs();
  }

  function autoRoles() {
    if (!draft.rolesTouched && draft.format !== "lisascan") defaultRoles(false);
  }

  /* A new reading while the run already holds values from an earlier slip: ask, never mix silently. */
  function ingest(parsed, choice) {
    if (!parsed || !parsed.wells.length) { toast("No values were found. Try a closer photo, or type the values."); return; }
    const held = draft.wells.filter(w => numOrNull(w.od) != null && !w.ctrlPlaceholder).length;
    if (held && !choice) {
      const box = $("#photoArea");
      box.hidden = false;
      box.innerHTML = `<div class="panel provisional stack">
        <h3>This run already has ${held} values from an earlier slip</h3>
        <p class="note">Is this photo a new slip, or the next strip of the same slip?</p>
        <div class="row"><button class="btn primary" id="ingNew">New slip: replace the earlier values</button>
          <button class="btn" id="ingAdd">Next strip of the same slip: add after them</button>
          <button class="btn" id="ingCancel">Cancel</button></div></div>`;
      $("#ingNew").onclick = () => { box.hidden = true; ingest(parsed, "new"); };
      $("#ingAdd").onclick = () => { box.hidden = true; ingest(parsed, "add"); };
      $("#ingCancel").onclick = () => { box.hidden = true; };
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (choice === "new") {
      Object.assign(draft, { wells: [], ctrl: null, printed: null, format: null, rolesTouched: false, pcNotRun: false, expected: "" });
      $("#startPos") && ($("#startPos").value = "A1");
      parsed.wells.forEach((w, i) => { if (parsed.format !== "lisascan" && !w.pos) w.pos = E.posAt(i); });
    }
    if (parsed.date && !draft.date) draft.date = parsed.date;
    if (parsed.testNo && !draft.testNo) draft.testNo = parsed.testNo;
    if (parsed.format === "lisascan") {
      if (parsed.printed) draft.printed = { ...(draft.printed || {}), ...parsed.printed };
      if (draft.wells.length) {
        // A further strip: continue positions and sample numbers (empty control rows belong only to the first strip)
        parsed.wells = parsed.wells.filter(w => !(w.missing && w.role !== "S"));
        let i = E.posIndex(nextPos());
        const lastN = Math.max(0, ...draft.wells.filter(w => w.role === "S").map(w => w.n || 0));
        let k = 0;
        parsed.wells.forEach(w => { w.pos = E.posAt(i++); if (w.role === "S" && !(w.n > lastN)) w.n = lastN + (++k); });
      }
      draft.format = "lisascan";
    } else {
      draft.format = draft.format || "merilyzer";
    }
    // Replace any wells already at these positions
    const incoming = new Set(parsed.wells.map(w => w.pos));
    draft.wells = draft.wells.filter(w => !incoming.has(w.pos)).concat(parsed.wells)
      .sort((x, y) => E.posIndex(x.pos) - E.posIndex(y.pos));
    if (parsed.format !== "lisascan") autoRoles();
    ctrlFromRoles();
    renderReview();
    const unsure = parsed.wells.filter(w => w.uncertain || w.missing || w.labelMismatch).length;
    toast(`Read ${parsed.wells.length} wells${unsure ? `, ${unsure} to check` : ""}`);
    $("#review").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Photo with rotate and crop */
  let shot = null;
  async function openPhoto(file) {
    const area = $("#photoArea");
    area.hidden = false;
    area.innerHTML = `<p class="note">Opening photo…</p>`;
    let canvas;
    try { canvas = await O.loadImage(file); }
    catch (e) { area.innerHTML = `<p class="note st-bad">${esc(e.message)}</p>`; return; }
    openCanvas(canvas);
  }
  /* A photo (from the camera or a file) is scanned like a document scanner app: when one clear slip is
     found it is straightened and the light evened out (this read best in tests); otherwise the photo is
     used as it is, with the slip boxed automatically. Either view can be chosen. */
  function openCanvas(canvas) {
    $("#photoArea").hidden = false;
    let sc = null;
    try { sc = O.scan(canvas, { evenLight: true }); } catch (e) { sc = null; }
    let crop = null; try { crop = O.autoCrop(canvas); } catch (e) { crop = null; }
    const original = { canvas, crop, auto: !!crop };
    if (sc && !sc.skipped && sc.canvas) shot = { canvas: sc.canvas, crop: null, auto: false, scanned: true, original, scan: sc.canvas };
    else shot = { ...original, scanned: false, original, scan: null };
    drawShot();
  }

  /* In-app camera: live view from the rear camera with a frame to fit the slip in. Falls back to the
     phone's own camera screen where live camera access is not available. Nothing leaves the device. */
  async function openCamera() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { $("#photoCam").click(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); }
    catch (e) { toast("Camera not available here. Opening the phone's camera instead."); $("#photoCam").click(); return; }
    const ov = document.createElement("div");
    ov.id = "camOverlay";
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Scan slip with camera");
    ov.style.cssText = "position:fixed;inset:0;z-index:1000;background:#000;display:flex;flex-direction:column;";
    ov.innerHTML = `<div style="position:relative;flex:1;overflow:hidden">
        <video playsinline muted autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video>
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(70vw,60vh);height:88%;border:3px dashed rgba(255,255,255,.85);border-radius:10px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none"></div>
        <p style="position:absolute;left:0;right:0;top:8px;margin:0;text-align:center;color:#fff;font:600 15px system-ui;text-shadow:0 1px 3px #000">Fit the slip inside the frame, flat, without shadow. Strips can be side by side.</p>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;align-items:center;padding:12px;background:#111">
        <button class="btn" id="camCancel" style="background:transparent;color:#fff;border-color:#888">Cancel</button>
        <button class="btn primary" id="camShoot" style="min-width:140px;font-size:17px">Capture</button>
        <button class="btn" id="camTorch" hidden style="background:transparent;color:#fff;border-color:#888">Light</button>
      </div>`;
    document.body.appendChild(ov);
    const video = ov.querySelector("video");
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    const stop = () => { stream.getTracks().forEach(t => t.stop()); ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") stop(); };
    document.addEventListener("keydown", onKey);
    try { const caps = track.getCapabilities ? track.getCapabilities() : {}; if (caps.torch) { const tb = ov.querySelector("#camTorch"); tb.hidden = false; let on = false; tb.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => { }); tb.textContent = on ? "Light off" : "Light"; }; } } catch (e) { }
    ov.querySelector("#camCancel").onclick = stop;
    ov.querySelector("#camShoot").onclick = async () => {
      if (!video.videoWidth) { toast("The camera is still starting. Try again in a moment."); return; }
      let canvas = document.createElement("canvas");
      try {
        // full camera resolution where the browser supports still photos
        if (window.ImageCapture) { const bmp = await new ImageCapture(track).takePhoto().then(b => createImageBitmap(b)); canvas.width = bmp.width; canvas.height = bmp.height; canvas.getContext("2d").drawImage(bmp, 0, 0); }
        else throw new Error("no ImageCapture");
      } catch (e) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext("2d").drawImage(video, 0, 0); }
      const max = 2600, k = Math.min(1, max / Math.max(canvas.width, canvas.height));
      if (k < 1) { const c2 = document.createElement("canvas"); c2.width = Math.round(canvas.width * k); c2.height = Math.round(canvas.height * k); c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height); canvas = c2; }
      stop();
      openCanvas(canvas);
    };
  }
  function drawShot() {
    const area = $("#photoArea");
    area.innerHTML = `<div class="stack">
      <div class="row"><button class="btn small" id="rotL">Rotate left</button><button class="btn small" id="rotR">Rotate right</button>${shot.scanned ? "" : `<button class="btn small" id="cropClear">Use whole photo</button>`}
        ${shot.scan ? `<button class="btn small" id="scanToggle">${shot.scanned ? "Use original photo" : "Use scanned slip"}</button>` : ""}
        <span class="note">${shot.scanned ? "Scanned: the slip was found, straightened and the light evened out. Check that no part of the slip is cut off." : shot.auto ? "The slip was found and boxed automatically. Check the box covers the whole slip; drag to redraw it if not." : "Drag across the slip to read only that part."}</span></div>
      <div class="shot" id="shot"><div class="crop" id="cropBox" hidden></div></div>
      <div class="progress" hidden id="ocrProg"><div></div></div>
      <div class="row"><button class="btn primary" id="readPhoto">Read values</button><button class="btn" id="closePhoto">Close photo</button><span class="note" id="ocrMsg"></span></div></div>`;
    const holder = $("#shot");
    const disp = shot.canvas; disp.style.width = "100%";
    holder.prepend(disp);
    const box = $("#cropBox");
    const showCrop = () => {
      if (!shot.crop) { box.hidden = true; return; }
      const k = disp.clientWidth / disp.width;
      Object.assign(box.style, { left: shot.crop.x * k + "px", top: shot.crop.y * k + "px", width: shot.crop.w * k + "px", height: shot.crop.h * k + "px" });
      box.hidden = false;
    };
    let start = null;
    const pt = e => { const r = disp.getBoundingClientRect(); const k = disp.width / r.width; return { x: Math.max(0, Math.min(disp.width, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(disp.height, (e.clientY - r.top) * k)) }; };
    holder.addEventListener("pointerdown", e => { start = pt(e); holder.setPointerCapture(e.pointerId); });
    holder.addEventListener("pointermove", e => {
      if (!start) return; const p = pt(e);
      shot.crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      showCrop();
    });
    holder.addEventListener("pointerup", () => { start = null; if (shot.crop && (shot.crop.w < 30 || shot.crop.h < 30)) { shot.crop = null; showCrop(); } });
    requestAnimationFrame(showCrop);
    const turn = dir => { openCanvas(O.rotate(shot.original ? shot.original.canvas : shot.canvas, dir)); };
    const tg = $("#scanToggle");
    if (tg) tg.onclick = () => { shot = shot.scanned ? { ...shot.original, scanned: false, original: shot.original, scan: shot.scan } : { canvas: shot.scan, crop: null, auto: false, scanned: true, original: shot.original, scan: shot.scan }; drawShot(); };
    $("#rotL").onclick = () => turn(-1);
    $("#rotR").onclick = () => turn(1);
    const cc = $("#cropClear"); if (cc) cc.onclick = () => { shot.crop = null; showCrop(); };
    $("#closePhoto").onclick = () => { $("#photoArea").hidden = true; shot = null; };
    $("#readPhoto").onclick = async () => {
      const btn = $("#readPhoto"), prog = $("#ocrProg"), msg = $("#ocrMsg");
      btn.disabled = true; prog.hidden = false; msg.textContent = "Preparing text recognition (first time takes a little longer)…";
      try {
        const out = await O.read(shot.canvas, shot.crop, m => {
          if (m.status === "recognizing text") { prog.firstElementChild.style.width = Math.round(m.progress * 100) + "%"; msg.textContent = "Reading values…"; }
        });
        let opts = { startPos: $("#startPos").value || "A1", layout: byId[draft.assayId].layout };
        let lines = out.lines;
        // OD-only slips (well label and OD per line): read again in page-layout mode, which keeps strips
        // photographed side by side apart, and place values by column and label
        if (P.detect(out.text) === "merilyzer") {
          msg.textContent = "Reading the strips…";
          const out2 = await O.read(shot.canvas, shot.crop, m => {
            if (m.status === "recognizing text") { prog.firstElementChild.style.width = Math.round(m.progress * 100) + "%"; }
          }, "3");
          opts.words = out2.words;
          if ((out2.lines || []).length > lines.length) lines = out2.lines;
        }
        const parsed = P.parse(lines, opts);
        // second reading of doubtful values, each cut out and enlarged on its own
        const targets = P.rereadTargets(parsed, opts.words ? null : lines);
        if (targets.length) {
          msg.textContent = `Checking ${targets.length} doubtful value${targets.length > 1 ? "s" : ""}…`;
          try { const rr = await O.reread(shot.canvas, shot.crop, targets.map(t => t.word)); P.applyRereads(parsed, targets, rr); } catch (e) { /* keep the first reading */ }
        }
        $("#photoArea").hidden = true; shot = null;
        ingest(parsed);
      } catch (e) {
        msg.textContent = e.message || "Text recognition failed. Type the values instead.";
        btn.disabled = false;
      }
    };
  }

  function saveRun() {
    const a = byId[draft.assayId], msg = $("#saveMsg");
    const ev = E.evaluate(draft, a);
    if (!draft.date) { msg.textContent = "Enter the run date."; $("#fDate").focus(); return; }
    const cc = draft.ctrl && draft.ctrl.length ? ctrlChecks(a) : [];
    if (cc.some(c => c.block)) { msg.textContent = "Complete the controls first: type each control's OD from the slip, and correct or confirm any that differ from the reading."; $("#ctrlTable") && $("#ctrlTable").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (!draft.wells.some(w => w.role === a.cutoff.base)) { msg.textContent = `Enter the ${a.cutoff.base} well${a.cutoff.base === "NC" ? "s" : ""} under Control wells before saving.`; return; }
    if (!ev.samples.length) { msg.textContent = "There are no sample wells yet."; return; }
    const run = {
      id: draft.id || `${draft.assayId}_${draft.date}_${Date.now().toString(36)}`,
      assayId: draft.assayId, date: draft.date, kitLot: draft.kitLot.trim(), testNo: numOrNull(draft.testNo),
      printed: draft.printed && draft.printed.cutoff != null ? draft.printed : null,
      wells: draft.wells.map(w => { const o = { ...w }; delete o.conf; delete o.raw; delete o.checkOrder; delete o.labelMismatch; delete o.missing; delete o.ctrlPlaceholder; return o; }),
      notes: draft.notes.trim(), source: draft.source || "Entered in ELI-Check", savedAt: new Date().toISOString(),
      pcNotRun: draft.pcNotRun || undefined,
      ctrlCheck: (draft.ctrl || []).length ? draft.ctrl.map(r => { const w = draft.wells.find(x => x.pos === r.pos); return { role: r.role, pos: r.pos, typed: numOrNull(r.od), read: w ? (w.ctrlTyped ? w.readOd : numOrNull(w.od)) : null, confirmed: !!r.confirmed }; }) : undefined
    };
    rememberControls(run);
    const i = runs.findIndex(r => r.id === run.id);
    if (i >= 0) runs[i] = run; else runs.push(run);
    saveRuns();
    try { localStorage.removeItem(DRAFT); } catch (e) { }
    draft = null;
    toast("Run saved");
    location.hash = "#run-" + encodeURIComponent(run.id);
  }

  /* ---------- QC charts ---------- */
  function insertLimits(a, ctrl) {
    const out = [];
    a.validity.filter(r => r.ctrl === ctrl).forEach(r => {
      if (r.op === "between") { out.push({ v: r.value[0], text: r.text }); out.push({ v: r.value[1], text: r.text }); }
      else if (typeof r.value === "number" && r.op !== "<cutoffx" && r.op !== ">=ref") out.push({ v: r.value, text: r.text, op: r.op });
    });
    return out;
  }

  function ljChart(a, ctrl, series) {
    const name = ctrl === "NC" ? "Negative control" : ctrl === "PC" ? "Positive control" : "Blank";
    if (series.length < 3) return `<div class="panel"><h2>${name}</h2><p class="note">A chart needs at least 3 runs of this assay. ${series.length} saved so far.</p></div>`;
    const vals = series.map(p => p.v), wg = E.westgard(vals), limits = insertLimits(a, ctrl);
    const W = 760, H = 270, L = 58, R = 74, T = 16, B = 38;
    const lo0 = Math.min(wg.mean - 3.6 * wg.sd, ...vals, ...limits.map(l => l.v)), hi0 = Math.max(wg.mean + 3.6 * wg.sd, ...vals, ...limits.map(l => l.v));
    const pad = (hi0 - lo0) * 0.04, lo = lo0 - pad, hi = hi0 + pad;
    const x = i => L + (series.length === 1 ? 0 : i * (W - L - R) / (series.length - 1));
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    let g = "";
    [-3, -2, -1, 0, 1, 2, 3].forEach(k => {
      const v = wg.mean + k * wg.sd, yy = y(v);
      const col = k === 0 ? "var(--fg)" : Math.abs(k) === 3 ? "var(--bad)" : Math.abs(k) === 2 ? "var(--warn)" : "var(--line)";
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="1" ${k ? 'stroke-dasharray="4 4"' : ""} opacity="${k ? 1 : 0.6}"/>`;
      g += `<text x="${L - 7}" y="${yy + 3.5}" text-anchor="end" font-size="10.5" fill="var(--muted)" font-family="ui-monospace,monospace">${k ? (k > 0 ? "+" : "") + k + "SD" : "mean"}</text>`;
    });
    limits.forEach(l => {
      const yy = y(l.v);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--accent)" stroke-width="2"/>`;
      g += `<text x="${W - R + 6}" y="${yy + 3.5}" font-size="10.5" fill="var(--accent)" font-family="ui-monospace,monospace">insert ${l.v}</text>`;
    });
    g += `<path d="${wg.pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}" fill="none" stroke="var(--fg)" stroke-width="1.3" opacity=".75"/>`;
    const failsInsert = p => a.validity.filter(r => r.ctrl === ctrl).some(r => {
      const v = p.v;
      switch (r.op) { case "<": return !(v < r.value); case "<=": return !(v <= r.value); case ">": return !(v > r.value); case ">=": return !(v >= r.value); case "between": return !(v >= r.value[0] && v <= r.value[1]); default: return false; }
    });
    wg.pts.forEach((p, i) => {
      const rej = p.rules.some(r => r.reject), warn = p.rules.length && !rej, bad = failsInsert(p);
      g += `<circle cx="${x(i)}" cy="${y(p.v)}" r="4.2" fill="${bad ? "var(--bad)" : rej ? "var(--bad)" : warn ? "var(--warn)" : "var(--accent)"}" stroke="var(--panel)" stroke-width="1.5"${bad ? "" : ""}><title>${esc(fmtDate(series[i].date))} · ${f4(p.v)} · z ${f2(p.z)}${p.rules.length ? " · " + p.rules.map(r => r.id).join(", ") : ""}${bad ? " · fails insert limit" : ""}</title></circle>`;
      if (bad) g += `<circle cx="${x(i)}" cy="${y(p.v)}" r="7.5" fill="none" stroke="var(--bad)" stroke-width="1.2"/>`;
    });
    const step = Math.max(1, Math.ceil(series.length / 9));
    series.forEach((p, i) => { if (i % step === 0 || i === series.length - 1) g += `<text x="${x(i)}" y="${H - B + 18}" text-anchor="middle" font-size="10.5" fill="var(--muted)" font-family="ui-monospace,monospace">${esc(shortDate(p.date))}</text>`; });
    const nFail = wg.pts.filter(failsInsert).length;
    const flagged = wg.pts.filter(p => p.rules.length);
    return `<div class="panel chart">
      <div class="row between"><h2>${name}</h2>${wg.provisional ? `<span class="chip warn">Provisional limits: ${wg.baselineN} of 20 runs</span>` : `<span class="chip ok">Limits from first 20 runs</span>`}</div>
      <div class="row mono muted" style="gap:16px;font-size:12px"><span>mean ${f4(wg.mean)}</span><span>SD ${f4(wg.sd)}</span><span>CV ${f2(wg.cv)}%</span><span>${series.length} runs</span></div>
      <div class="plate-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${name} Levey-Jennings chart" style="min-width:520px">${g}</svg></div>
      <div class="legend"><span><i style="background:var(--accent);border-color:var(--accent)"></i>In control</span><span><i style="background:var(--warn);border-color:var(--warn)"></i>Westgard warning</span><span><i style="background:var(--bad);border-color:var(--bad)"></i>Westgard rejection or fails insert limit (ringed)</span></div>
      <ul class="findings">
        ${limits.length ? `<li class="${nFail ? "bad" : "ok"}"><div><b>Insert limit: ${nFail} of ${series.length} runs outside</b><p>${esc(limits[0].text)}. Runs outside it are invalid by the insert.</p></div></li>` : ""}
        <li class="${flagged.some(p => p.rules.some(r => r.reject)) ? "bad" : flagged.length ? "warn" : "ok"}"><div><b>Westgard: ${flagged.length ? flagged.map(p => `${shortDate(series[p.i].date)} ${p.rules.map(r => r.id).join(", ")}`).join("; ") : "no rule violations"}</b><p>1-2s is a warning; 1-3s, 2-2s, R-4s, 4-1s and 10x are rejection rules. Limits use the first ${wg.baselineN} runs.</p></div></li>
      </ul></div>`;
  }

  const qcGroup = r => (r.kitLot || "Lot not recorded") + (r.reader ? " · " + r.reader : "");
  const qcKeep = (r, ctrl) => !(r.qcExclude && r.qcExclude.ctrls.includes(ctrl));
  function renderQC() {
    const id = prefs.qcAssay && byId[prefs.qcAssay] ? prefs.qcAssay : ASSAYS[0].id;
    const a = byId[id];
    const list = runs.filter(r => r.assayId === id).sort((x, y) => (x.date || "").localeCompare(y.date || ""));
    const lots = [...new Set(list.map(qcGroup))];
    const lot = prefs.qcLot && lots.includes(prefs.qcLot) ? prefs.qcLot : "all";
    const use = list.filter(r => lot === "all" || qcGroup(r) === lot);
    const excluded = ["PC", "NC"].map(c => ({ c, runs: use.filter(r => !qcKeep(r, c)) })).filter(o => o.runs.length);
    const raw = ctrl => use.filter(r => qcKeep(r, ctrl)).map(r => ({ date: r.date, v: E.mean(r.wells.filter(w => w.role === ctrl && numOrNull(w.od) != null).map(w => Number(w.od))) })).filter(p => isFinite(p.v));
    const series = ctrl => raw(ctrl).filter(p => E.inLinear(a, p.v));
    const overLinear = ["PC", "NC"].map(c => ({ c, pts: raw(c).filter(p => !E.inLinear(a, p.v)) })).filter(o => o.pts.length);
    view.innerHTML = `<div class="stack">
      <div class="panel"><div class="row between"><h2>Control trends</h2>
        <div class="row"><select id="qcAssay" aria-label="Assay">${ASSAYS.map(x => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <select id="qcLot" aria-label="Kit lot and reader"><option value="all">All lots and readers</option>${lots.map(l => `<option ${l === lot ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div></div>
        <div class="row" style="margin-top:8px"><a class="btn primary" href="#report">Monthly IQC report</a></div>
        <p class="note">Levey-Jennings charts of each control, one point per run in date order. The green line is the insert's acceptance limit; the dashed lines are this lab's own mean and SD. A control can be steady by its own statistics and still fail the insert limit, which is what these charts are meant to show. Kit controls change with each lot, so filter by lot once lots are recorded.</p>
        ${lots.length > 1 && lot === "all" ? `<p class="note st-warn">This chart mixes ${lots.length} lots or readers. Choose one above: kit controls change with each lot, and readers differ in NC level.</p>` : ""}
        ${excluded.map(o => `<p class="note">${o.c} left out on ${o.runs.length} run${o.runs.length === 1 ? "" : "s"}: ${o.runs.map(r => esc(shortDate(r.date) + (r.plate ? " " + r.plate : "") + " (" + r.qcExclude.reason + ")")).join("; ")}.</p>`).join("")}
        ${overLinear.map(o => `<p class="note st-warn">${o.c} above the reader's linear range (${a.linearMax} OD) on ${o.pts.length} run${o.pts.length === 1 ? "" : "s"} (${o.pts.map(p => esc(shortDate(p.date))).join(", ")}): valid under the insert, left out of this chart and its limits.</p>`).join("")}
      </div>
      ${ljChart(a, "PC", series("PC"))}
      ${ljChart(a, "NC", series("NC"))}
      ${series("BLK").length ? ljChart(a, "BLK", series("BLK")) : ""}
    </div>`;
    $("#qcAssay").onchange = e => { prefs.qcAssay = e.target.value; prefs.qcLot = "all"; savePrefs(); renderQC(); };
    $("#qcLot").onchange = e => { prefs.qcLot = e.target.value; savePrefs(); renderQC(); };
  }


  /* ---------- Monthly IQC report (printable) ---------- */
  const CTRL_NAME = { NC: "Negative control", PC: "Positive control", BLK: "Blank" };
  const monthLabel = ym => { const [y, m] = ym.split("-"); return `${["January","February","March","April","May","June","July","August","September","October","November","December"][+m - 1]} ${y}`; };
  const ctrlMean = (r, ctrl) => { const v = (r.wells || []).filter(w => w.role === ctrl && numOrNull(w.od) != null).map(w => Number(w.od)); return v.length ? E.mean(v) : NaN; };
  const passOp = (v, r) => { switch (r.op) { case "<": return v < r.value; case "<=": return v <= r.value; case ">": return v > r.value; case ">=": return v >= r.value; case "between": return v >= r.value[0] && v <= r.value[1]; default: return true; } };

  /* Chart for print: limits from the whole series, points shown only for the month (idx). Plain colours so it prints the same in any theme. */
  function ljPrint(a, ctrl, wg, idx, dates) {
    const limits = insertLimits(a, ctrl);
    const pts = idx.map(i => wg.pts[i]);
    const vals = pts.map(p => p.v);
    const W = 720, H = 230, L = 56, R = 78, T = 12, B = 34;
    const lo0 = Math.min(wg.mean - 3.5 * wg.sd, ...vals, ...limits.map(l => l.v)), hi0 = Math.max(wg.mean + 3.5 * wg.sd, ...vals, ...limits.map(l => l.v));
    const pad = (hi0 - lo0) * 0.05, lo = lo0 - pad, hi = hi0 + pad;
    const x = j => L + (pts.length === 1 ? (W - L - R) / 2 : j * (W - L - R) / (pts.length - 1));
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    let g = `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="#fff" stroke="#bbb"/>`;
    [-3, -2, -1, 0, 1, 2, 3].forEach(k => {
      const yy = y(wg.mean + k * wg.sd);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${k === 0 ? "#222" : Math.abs(k) === 3 ? "#b42318" : Math.abs(k) === 2 ? "#b7791f" : "#aaa"}" stroke-width="1" ${k ? 'stroke-dasharray="4 3"' : ""}/>`;
      g += `<text x="${L - 6}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="#444" font-family="monospace">${k ? (k > 0 ? "+" : "") + k + "SD" : "Mean"}</text>`;
      g += `<text x="${W - R + 5}" y="${yy + 3.5}" font-size="9.5" fill="#666" font-family="monospace">${(wg.mean + k * wg.sd).toFixed(3)}</text>`;
    });
    limits.forEach(l => {
      const yy = y(l.v);
      g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#0e6e66" stroke-width="2"/>`;
      g += `<text x="${L + 4}" y="${yy - 4}" font-size="9.5" fill="#0e6e66" font-family="monospace">Insert limit ${l.v}</text>`;
    });
    if (pts.length > 1) g += `<path d="${pts.map((p, j) => `${j ? "L" : "M"}${x(j).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}" fill="none" stroke="#333" stroke-width="1.2"/>`;
    const rulesOf = a.validity.filter(r => r.ctrl === ctrl && typeof r.value !== "undefined" && r.op !== "<cutoffx" && r.op !== ">=ref");
    pts.forEach((p, j) => {
      const fails = rulesOf.some(r => !passOp(p.v, r)), rej = p.rules.some(r => r.reject), warn = p.rules.length && !rej;
      g += `<circle cx="${x(j)}" cy="${y(p.v)}" r="4" fill="${rej || fails ? "#b42318" : warn ? "#b7791f" : "#0e6e66"}" stroke="#fff" stroke-width="1.2"/>`;
      if (fails) g += `<circle cx="${x(j)}" cy="${y(p.v)}" r="7" fill="none" stroke="#b42318" stroke-width="1.1"/>`;
      g += `<text x="${x(j)}" y="${H - B + 15}" text-anchor="middle" font-size="9.5" fill="#444" font-family="monospace">${esc(shortDate(dates[j]))}</text>`;
    });
    return `<svg class="rp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${CTRL_NAME[ctrl]} Levey-Jennings chart">${g}</svg>`;
  }

  function renderReport() {
    const id = prefs.qcAssay && byId[prefs.qcAssay] ? prefs.qcAssay : ASSAYS[0].id;
    const a = byId[id];
    const all = runs.filter(r => r.assayId === id && r.date).sort((x, y) => x.date.localeCompare(y.date) || String(x.id).localeCompare(String(y.id)));
    const lots = [...new Set(all.map(qcGroup))];
    const lot = prefs.qcLot && lots.includes(prefs.qcLot) ? prefs.qcLot : "all";
    const list = all.filter(r => lot === "all" || qcGroup(r) === lot);
    const months = [...new Set(list.map(r => r.date.slice(0, 7)))].sort().reverse();
    const month = prefs.rpMonth && months.includes(prefs.rpMonth) ? prefs.rpMonth : months[0];
    const labName = prefs.labName ?? "";

    const controls = `<div class="panel no-print"><div class="row between"><h2>Monthly IQC report</h2><a class="btn small" href="#qc">Back to QC charts</a></div>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
        <select id="rpAssay" aria-label="Assay">${ASSAYS.map(x => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <select id="rpLot" aria-label="Kit lot and reader"><option value="all">All lots and readers</option>${lots.map(l => `<option ${l === lot ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <select id="rpMonth" aria-label="Month">${months.map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</select>
        <button class="btn primary" id="rpPrint" ${month ? "" : "disabled"}>Print or save as PDF</button>
      </div>
      <label class="f" for="rpLab" style="margin-top:10px">Laboratory name on the report<input id="rpLab" value="${esc(labName)}"></label>
      <p class="note">Control limits come from this lab's first 20 runs of the selected lot (or all lots), and Westgard rules look back across earlier months, so a trend that starts in one month and continues into the next is still caught. On a phone, Print opens the share sheet: choose Print, then Save as PDF. Print the report, sign it and file it; the signed copy is the record.</p></div>`;

    if (!month) { view.innerHTML = `<div class="stack">${controls}<div class="panel empty"><h2>No dated runs</h2><p class="note">Save runs of ${esc(a.name)} with dates to make a report.</p></div></div>`; bindReport(); return; }

    const inMonth = list.map((r, i) => ({ r, i })).filter(o => o.r.date.slice(0, 7) === month);
    const ctrls = ["PC", "NC", "BLK"].filter(c => list.some(r => isFinite(ctrlMean(r, c))));
    /* Westgard per control over the whole series (runs missing that control are skipped) */
    const W = {};
    for (const c of ctrls) {
      const ser = list.map((r, i) => ({ i, v: qcKeep(r, c) ? ctrlMean(r, c) : NaN })).filter(p => isFinite(p.v) && E.inLinear(a, p.v));
      const wg = E.westgard(ser.map(p => p.v));
      const byRun = new Map(ser.map((p, k) => [p.i, wg.pts[k]]));
      const base = ser.slice(0, wg.baselineN || ser.length);
      W[c] = { wg, byRun, ser, baseFrom: base.length ? list[base[0].i].date : "", baseTo: base.length ? list[base[base.length - 1].i].date : "" };
    }
    const rows = inMonth.map(({ r, i }) => {
      const ev = evalRun(r);
      const rules = ctrls.flatMap(c => { const p = W[c].byRun.get(i); return p ? p.rules.map(x => ({ c, ...x })) : []; });
      const rejected = rules.some(x => x.reject);
      const decision = !ev.valid ? "Reject (insert)" : rejected ? "Reject (Westgard)" : rules.length ? "Accept with warning" : "Accept";
      return { r, i, ev, rules, decision };
    });
    const nValid = rows.filter(o => o.ev.valid).length;
    const nAccept = rows.filter(o => o.decision.startsWith("Accept")).length;
    const nWarn = rows.filter(o => o.rules.some(x => !x.reject)).length;
    const nWgRej = rows.filter(o => o.rules.some(x => x.reject)).length;
    const lotsInMonth = [...new Set(inMonth.map(o => o.r.kitLot || "not recorded"))];

    const limitRows = ctrls.map(c => {
      const { wg, baseFrom, baseTo } = W[c];
      const mVals = rows.map(o => ctrlMean(o.r, c)).filter(isFinite);
      const mm = mVals.length ? E.mean(mVals) : NaN, ms = mVals.length > 1 ? E.sd(mVals) : NaN;
      const lim = a.validity.filter(v => v.ctrl === c).map(v => v.text).join("; ") || "–";
      return `<tr><td>${CTRL_NAME[c]}</td><td class="n">${f4(wg.mean)}</td><td class="n">${f4(wg.sd)}</td><td class="n">${f2(wg.cv)}%</td>
        <td>${wg.baselineN || 0} runs, ${esc(shortDate(baseFrom))} to ${esc(fmtDate(baseTo))}${wg.provisional ? " (provisional, under 20)" : ""}</td>
        <td class="n">${f4(mm)}</td><td class="n">${f4(ms)}</td><td class="n">${isFinite(mm) && isFinite(ms) && mm ? f2(ms / mm * 100) + "%" : "–"}</td><td>${esc(lim)}</td></tr>`;
    }).join("");

    const runRows = rows.map(o => {
      const cells = ctrls.map(c => { const v = ctrlMean(o.r, c), p = W[c].byRun.get(o.i); return `<td class="n">${f4(v)}${p && p.rules.length ? `<br><span class="rp-flag">${p.rules.map(x => x.id).join(", ")}</span>` : ""}</td>`; }).join("");
      const failed = o.ev.checks.filter(c => c.pass === false).map(c => c.rule.text);
      return `<tr><td>${esc(fmtDate(o.r.date))}</td><td class="c">${esc(o.r.testNo ?? "")}</td><td>${esc(o.r.kitLot || "–")}</td>${cells}
        <td class="n">${f4(o.ev.cutoff)}</td><td>${o.ev.valid ? "Valid" : "Invalid: " + esc(failed.join("; "))}</td>
        <td><b>${o.decision}</b></td><td class="rp-write"></td></tr>`;
    }).join("");

    const charts = ctrls.map(c => {
      const { wg, ser } = W[c];
      const k = ser.map((p, j) => ({ j, i: p.i })).filter(o => list[o.i].date.slice(0, 7) === month);
      if (!wg.enough) return `<div class="rp-block"><h3>${CTRL_NAME[c]}</h3><p class="rp-small">At least 3 runs are needed to set limits. ${ser.length} so far.</p></div>`;
      return `<div class="rp-block"><h3>${CTRL_NAME[c]}: Levey-Jennings chart</h3>${ljPrint(a, c, wg, k.map(o => o.j), k.map(o => list[o.i].date))}</div>`;
    }).join("");

    const sig = t => `<div class="rp-sig"><b>${t}</b><div>Name</div><div>Signature</div><div>Date</div></div>`;

    view.innerHTML = `<div class="stack">${controls}
      <article class="report" id="report">
        <header class="rp-head">
          <div><div class="rp-lab">${esc(labName)}</div><div class="rp-title">Internal Quality Control: monthly review</div></div>
          <div class="rp-month">${monthLabel(month)}</div>
        </header>
        <table class="rp-meta"><tbody>
          <tr><th>Assay</th><td>${esc(a.name)}</td><th>Section</th><td>${esc(a.section)}</td></tr>
          <tr><th>Kit</th><td>${esc(a.kit)}, ${esc(a.maker)}</td><th>Insert</th><td>${esc(a.insert)}</td></tr>
          <tr><th>Reader</th><td>${esc(a.reader)}</td><th>Kit lot(s)</th><td>${esc(lotsInMonth.join(", "))}${lot === "all" ? "" : " (report filtered to this lot)"}</td></tr>
          <tr><th>Cutoff</th><td>${esc(a.cutoff.text)}</td><th>Controls</th><td>Kit controls${a.provisional ? " · rules provisional" : ""}</td></tr>
        </tbody></table>
        ${a.provisional ? `<p class="rp-alert">Provisional rules: ${esc(a.provisional)}</p>` : ""}

        <h2>Summary</h2>
        <table class="rp-sum"><tbody><tr>
          <td><span>${rows.length}</span>runs</td><td><span>${nValid}</span>valid by insert</td><td><span>${rows.length - nValid}</span>invalid by insert</td>
          <td><span>${nWarn}</span>with Westgard warning</td><td><span>${nWgRej}</span>with Westgard rejection</td><td><span>${nAccept}</span>accepted</td>
        </tr></tbody></table>

        <h2>Control limits</h2>
        <div class="rp-scroll"><table class="rp-tbl"><thead><tr><th rowspan="2">Control</th><th colspan="4">Established (this lab)</th><th colspan="3">This month</th><th rowspan="2">Insert acceptance</th></tr>
          <tr><th>Mean</th><th>SD</th><th>CV</th><th>Based on</th><th>Mean</th><th>SD</th><th>CV</th></tr></thead><tbody>${limitRows}</tbody></table></div>

        ${charts}
        <p class="rp-small">Points: teal in control; amber Westgard warning (1-2s); red Westgard rejection (1-3s, 2-2s, R-4s, 4-1s, 10x) or outside the insert limit (ringed). Dashed lines are this lab's mean ± 1, 2, 3 SD; the solid teal line is the insert acceptance limit.</p>

        <h2>Runs</h2>
        <div class="rp-scroll"><table class="rp-tbl rp-runs"><thead><tr><th>Date</th><th>Test no.</th><th>Lot</th>${ctrls.map(c => `<th>${c === "BLK" ? "Blank" : c} OD</th>`).join("")}<th>Cutoff</th><th>Insert validity</th><th>Decision</th><th>Remarks and corrective action</th></tr></thead>
        <tbody>${runRows}</tbody></table></div>
        <p class="rp-small">Decision: a run failing the insert acceptance criteria is rejected whatever its Westgard status. Westgard rules are applied to each control separately.</p>

        <h2>Review and corrective action</h2>
        <div class="rp-box"></div>

        <div class="rp-sigs">${sig("Performed by")}${sig("Reviewed by (QC in charge)")}${sig("Laboratory in charge")}</div>
        <footer class="rp-foot">Generated ${esc(fmtDate(today()))} by ELI-Check, a quality control verification aid. Values are transcribed from the reader printouts. This report becomes the record when reviewed and signed.</footer>
      </article></div>`;
    bindReport();
  }
  function bindReport() {
    $("#rpAssay").onchange = e => { prefs.qcAssay = e.target.value; prefs.qcLot = "all"; prefs.rpMonth = ""; savePrefs(); renderReport(); };
    $("#rpLot").onchange = e => { prefs.qcLot = e.target.value; prefs.rpMonth = ""; savePrefs(); renderReport(); };
    const m = $("#rpMonth"); if (m) m.onchange = e => { prefs.rpMonth = e.target.value; savePrefs(); renderReport(); };
    $("#rpLab").onchange = e => { prefs.labName = e.target.value; savePrefs(); renderReport(); };
    const pr = $("#rpPrint"); if (pr) pr.onclick = () => window.print();
  }

  /* ---------- Audit ---------- */
  function sampleRows(list) {
    const rows = [];
    for (const r of list) {
      const a = byId[r.assayId], ev = evalRun(r);
      for (const s of ev.samples) rows.push({
        assay: a.name, run_date: r.date, test_no: r.testNo ?? "", kit_lot: r.kitLot || "", run_valid: ev.valid ? "yes" : "no",
        well: s.pos, sample_no: s.n, lab_no: s.labNo || "", od: s.od ?? "", insert_cutoff: isFinite(ev.cutoff) ? ev.cutoff.toFixed(4) : "",
        ratio: s.ratio != null && isFinite(s.ratio) ? s.ratio.toFixed(4) : "", units: s.units != null ? s.units.toFixed(2) : "",
        result: s.band ? s.band.code : "", printed_cutoff: ev.printed ?? "", printed_ratio: s.printedRatio ?? "", printed_flag: s.printedFlag || "",
        reader_insert_discordant: s.readerDiscordant ? "yes" : "", between_cutoffs: s.inGap ? "yes" : "",
        register_od: s.regOD ?? "", register_od_match: s.regODMatch == null ? "" : s.regODMatch ? "yes" : "no",
        register_result: s.regUnits ?? "", register_result_match: s.regUnitsMatch == null ? "" : s.regUnitsMatch ? "yes" : "no",
        register_to_verify: s.regUncertain ? "yes" : "", hard_to_read: s.uncertain ? "yes" : ""
      });
    }
    return rows;
  }
  function runRows(list) {
    return list.map(r => {
      const a = byId[r.assayId], ev = evalRun(r);
      return {
        assay: a.name, run_date: r.date, test_no: r.testNo ?? "", kit_lot: r.kitLot || "",
        nc_wells: ev.ctrlVals.NC.length, nc_mean: E.mean(ev.ctrlVals.NC).toFixed(4), pc_wells: ev.ctrlVals.PC.length, pc_mean: isFinite(E.mean(ev.ctrlVals.PC)) ? E.mean(ev.ctrlVals.PC).toFixed(4) : "",
        insert_cutoff: isFinite(ev.cutoff) ? ev.cutoff.toFixed(4) : "", printed_cutoff: ev.printed ?? "", valid: ev.valid ? "yes" : "no",
        failed_checks: ev.checks.filter(c => c.pass === false).map(c => c.rule.text).join("; "),
        samples: ev.samples.length, reactive: ev.samples.filter(s => s.band && E.isReactiveCode(s.band.code)).length,
        equivocal_or_grey: ev.samples.filter(s => s.band && /EQV|GZ/.test(s.band.code)).length, notes: r.notes || ""
      };
    });
  }

  function renderAudit() {
    const id = prefs.auditAssay && byId[prefs.auditAssay] ? prefs.auditAssay : ASSAYS[0].id;
    const a = byId[id];
    const all = runs.filter(r => r.assayId === id);
    const from = prefs.auditFrom || "", to = prefs.auditTo || "";
    const list = all.filter(r => (!from || r.date >= from) && (!to || r.date <= to)).sort((x, y) => x.date.localeCompare(y.date));
    const { S, evs } = E.summarise(list, a);
    const hasReader = !!a.readerProgram;
    const tableRows = evs.map(({ run, ev }) => {
      const c = E.counts(run, ev), nR = c.reactive, nE = c.equivocal;
      const regBad = ev.samples.filter(s => s.regUnitsMatch === false || s.regODMatch === false).length;
      return `<tr class="${ev.valid ? "" : "bad"}"><td class="l"><a href="#run-${encodeURIComponent(run.id)}">${fmtDate(run.date)}${run.plate ? " " + esc(run.plate) : ""}</a></td><td>${c.samples}${c.fromSlip ? "*" : ""}</td><td>${nR}</td><td>${nE || ""}</td>
        <td>${f4(E.mean(ev.ctrlVals.NC))}</td><td>${f4(E.mean(ev.ctrlVals.PC))}</td><td>${f4(ev.cutoff)}</td>${hasReader ? `<td>${f4(ev.printed)}</td>` : ""}
        <td class="l">${ev.valid ? '<span class="chip ok">Valid</span>' : '<span class="chip bad">Invalid</span>'}</td><td>${regBad || ""}</td></tr>`;
    }).join("");
    view.innerHTML = `<div class="stack">
      <div class="panel"><div class="row between"><h2>Audit summary</h2>
        <div class="row"><select id="auAssay" aria-label="Assay">${ASSAYS.map(x => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div></div>
        <div class="fields"><label class="f" for="auFrom">From<input type="date" id="auFrom" value="${esc(from)}"></label><label class="f" for="auTo">To<input type="date" id="auTo" value="${esc(to)}"></label>
          <div><h3>Period covered</h3><span class="mono">${S.runs ? `${fmtDate(S.from)} to ${fmtDate(S.to)}` : "–"}</span></div></div>
      </div>
      ${S.runs ? `
      <div class="tiles">
        <div><span class="k">Runs</span><span class="v">${S.runs}</span><span class="s">${esc(a.kit)}</span></div>
        <div><span class="k">Samples</span><span class="v">${S.samples}</span><span class="s">${S.reactive} reactive (${pct(S.reactive, S.samples)})</span></div>
        <div><span class="k">Invalid runs</span><span class="v ${S.invalidRuns ? "st-bad" : "st-ok"}">${S.invalidRuns} of ${S.runs}</span><span class="s">by insert criteria</span></div>
        <div><span class="k">Results from invalid runs</span><span class="v ${S.samplesInInvalid ? "st-bad" : ""}">${pct(S.samplesInInvalid, S.samples)}</span><span class="s">${S.samplesInInvalid} samples, ${S.reactiveInInvalid} reactive</span></div>
      </div>
      <div class="panel"><h2>Findings by type</h2>
        <table class="checks"><tbody>
          <tr><td>Runs failing an insert validity criterion</td><td class="n">${S.invalidRuns} / ${S.runs}</td></tr>
          <tr><td>Patient results reported from those runs</td><td class="n">${S.samplesInInvalid} / ${S.samples}</td></tr>
          <tr><td>Samples in the equivocal or grey zone</td><td class="n">${S.equivocal}</td></tr>
          ${hasReader ? `<tr><td>Runs where the reader cutoff differs from the insert cutoff</td><td class="n">${S.cutoffDiffRuns} / ${S.runs}</td></tr>
          <tr><td>Samples with OD between the reader and insert cutoffs</td><td class="n">${S.gapSamples}</td></tr>
          <tr><td>Samples flagged differently by reader and insert</td><td class="n">${S.readerDiscordant}</td></tr>` : ""}
          <tr><td>Runs with fewer control wells than the insert specifies</td><td class="n">${S.replicateShortRuns} / ${S.runs}</td></tr>
          ${a.replicates.BLK ? `<tr><td>Runs without a blank well</td><td class="n">${S.blankMissingRuns} / ${S.runs}</td></tr>` : ""}
          <tr><td>Register calculations checked, not matching</td><td class="n">${S.regUnitsErrors} / ${S.regUnitsChecked}${S.regUnitsToVerify ? ` (+${S.regUnitsToVerify} to verify)` : ""}</td></tr>
          <tr><td>Register ODs checked, not matching the slip</td><td class="n">${S.regODErrors} / ${S.regODChecked}${S.regODToVerify ? ` (+${S.regODToVerify} to verify)` : ""}</td></tr>
        </tbody></table>
        ${S.slipRuns ? `<p class="note">${S.slipRuns} of ${S.runs} runs hold control values only (marked * in the run table); their sample and reactive counts come from the slip, and equivocal or grey zone samples in them are not counted.</p>` : ""}
        <p class="note">Register checks allow for the lab's habit of rounding or truncating the NC and OD to three decimals before calculating. Entries marked "to verify" were hard to read in the photo and are kept out of the error count.</p>
      </div>
      <div class="panel"><h2>Runs</h2>
        <div class="tbl tall"><table class="data"><thead><tr><th class="l">Date</th><th>Samples</th><th>Reactive</th><th>Eqv/grey</th><th>NC</th><th>PC</th><th>Cutoff</th>${hasReader ? "<th>Reader</th>" : ""}<th class="l">Run</th><th>Register issues</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      </div>` : `<div class="panel empty"><h2>No runs for this assay in this period</h2><p class="note">Add runs, or restore them from a backup.</p></div>`}
      <div class="panel"><h2>Export and back up</h2>
        <div class="row">
          <button class="btn primary" id="dlSamples" ${S.runs ? "" : "disabled"}>Sample results (CSV)</button>
          <button class="btn" id="dlRuns" ${S.runs ? "" : "disabled"}>Run summary (CSV)</button>
          <button class="btn" id="dlBackup" ${allRuns().length ? "" : "disabled"}>Back up all runs</button>
          <label class="btn" for="restore">Restore from backup</label><input type="file" id="restore" accept=".json,application/json" hidden>
        </div>
        <p class="note">CSV files open in Excel or any statistics package. The backup file holds every run on this device and can be restored on another phone or computer.</p>
        <div class="row" id="wipeBox"><button class="btn danger small" id="wipe" ${allRuns().length ? "" : "disabled"}>Delete all runs on this device</button></div>
      </div>
    </div>`;
    $("#auAssay").onchange = e => { prefs.auditAssay = e.target.value; savePrefs(); renderAudit(); };
    $("#auFrom").onchange = e => { prefs.auditFrom = e.target.value; savePrefs(); renderAudit(); };
    $("#auTo").onchange = e => { prefs.auditTo = e.target.value; savePrefs(); renderAudit(); };
    $("#dlSamples").onclick = () => download(`${id}_samples_${S.from || ""}_${S.to || ""}.csv`, toCSV(sampleRows(list)), "text/csv");
    $("#dlRuns").onclick = () => download(`${id}_runs_${S.from || ""}_${S.to || ""}.csv`, toCSV(runRows(list)), "text/csv");
    $("#dlBackup").onclick = () => download(`eli-check-backup_${today()}.json`, JSON.stringify({ app: "ELI-Check", exported: new Date().toISOString(), runs: allRuns() }, null, 1), "application/json");
    $("#restore").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try { const data = JSON.parse(await f.text()); const { added, replaced } = mergeRuns(data.runs || data); toast(`Restored ${added} run${added === 1 ? "" : "s"}${replaced ? `, updated ${replaced}` : ""}`); renderAudit(); }
      catch (err) { toast("That file is not an ELI-Check backup."); }
    };
    
    $("#wipe").onclick = () => {
      $("#wipeBox").innerHTML = `<span class="confirm">Delete all ${allRuns().length} runs from this device? <button class="btn danger small" id="wipeYes">Delete all</button><button class="btn small" id="wipeNo">Keep</button></span>`;
      $("#wipeNo").onclick = renderAudit;
      $("#wipeYes").onclick = () => { runs = []; unplaced.length = 0; saveRuns(); toast("All runs deleted"); renderAudit(); };
    };
  }

  /* ---------- Assays ---------- */
  function renderAssays() {
    const card = a => `<div class="panel">
      <div class="row between"><h2>${esc(a.name)}</h2><span class="row">${a.provisional ? '<span class="chip warn">Provisional</span>' : ""}<span class="chip neutral">${esc(a.section)}</span></span></div>
      ${a.provisional ? `<p class="note st-warn">${esc(a.provisional)}</p>` : ""}
      <p class="note">${esc(a.kit)}, ${esc(a.maker)}. Insert ${esc(a.insert)}. Reader: ${esc(a.reader)}.</p>
      <div class="rules">
        <div class="rule"><h3>Cutoff (insert)</h3><span class="num mono">${esc(a.cutoff.text)}</span></div>
        ${a.readerProgram ? `<div class="rule"><h3>Reader program</h3><span class="num mono">${esc(a.readerProgram.text)}</span></div>` : ""}
        <div class="rule"><h3>Result</h3><span class="num">${a.bands.map(b => esc(b.label)).join(" · ")}</span><span class="note">${a.units ? "Units = ratio × " + a.units.factor : "Ratio = OD ÷ cutoff"}</span></div>
        ${a.validity.map(v => `<div class="rule"><h3>Validity${v.optional ? " (if read)" : ""}</h3><span class="num mono">${esc(v.text)}</span></div>`).join("")}
        <div class="rule"><h3>Control wells</h3><span class="num mono">${Object.entries(a.replicates).map(([k, n]) => `${k === "BLK" ? "Blank" : k} × ${n}`).join(", ")}</span></div>
        ${a.discard.map(d => `<div class="rule"><h3>Outlier rule</h3><span class="num">${esc(d.text)}</span></div>`).join("")}
        ${a.linearMax != null ? `<div class="rule"><h3>Reader linear range</h3><span class="num mono">Controls above ${a.linearMax} OD stay valid; left out of QC limits</span></div>` : ""}
      </div>
      <p class="note">${esc(a.notes)} Usual layout in this lab: ${a.layout.where === "end" ? "controls are the last wells" : "controls first"} (${a.layout.order.join(", ")}).</p>
    </div>`;
    view.innerHTML = `<div class="stack">
      <div class="panel"><h2>Assay rules</h2><p class="note">Each assay's rules are copied from its kit insert into one file, <span class="mono">js/assays.js</span>. To add an assay or update a rule after an insert revision, edit that file. The rest of the app reads from it.</p></div>
      ${ASSAYS.map(card).join("")}</div>`;
  }

  /* ---------- routing ---------- */
  function render() {
    const h = decodeURIComponent((location.hash || "#runs").slice(1));
    const tab = h.startsWith("run-") ? "runs" : h.startsWith("edit-") ? "add" : h === "report" ? "qc" : (h || "runs");
    $$(".tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === tab ? "page" : "false"));
    if (h.startsWith("run-")) renderRuns(h.slice(4));
    else if (h.startsWith("edit-")) renderEditor(h.slice(5));
    else if (h === "add") renderEditor(null);
    else if (h === "qc") renderQC();
    else if (h === "report") renderReport();
    else if (h === "audit") renderAudit();
    else if (h === "assays") renderAssays();
    else renderRuns(null);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", render);
  const net = () => { $("#offline-state").textContent = navigator.onLine ? "" : "Offline: saving still works"; };
  window.addEventListener("online", net); window.addEventListener("offline", net); net();
  if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => { });
  render();
  if (unplaced.length) toast(`${unplaced.length} saved run${unplaced.length === 1 ? " is" : "s are"} for an assay not in this version. Kept on this device and in backups.`);
})();
