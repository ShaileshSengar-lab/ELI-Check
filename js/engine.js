/*
  Calculation engine. Pure functions, no page code, so the same logic can be
  checked outside the browser.

  A run looks like:
  {
    id, assayId, date: "YYYY-MM-DD", kitLot, testNo,
    printed: { cutoff, formula, greyZone } | null,   // what the reader printed
    wells: [ { pos: "A1", od, role: "S"|"NC"|"PC"|"BLK",
               printedRatio, printedFlag, uncertain,
               labNo, regOD, regUnits, regUncertain } ],
    notes
  }
*/
(function (root) {
  "use strict";

  const ROWS = "ABCDEFGH";
  const ALL_POS = [];
  for (let c = 1; c <= 12; c++) for (let r = 0; r < 8; r++) ALL_POS.push(ROWS[r] + c);

  function posIndex(pos) { return ALL_POS.indexOf(String(pos || "").toUpperCase()); }
  function posAt(i) { return ALL_POS[i]; }
  function isPos(s) { return posIndex(s) >= 0; }

  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const sd = a => {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  };
  const round3 = x => Math.round(x * 1000) / 1000;
  const trunc3 = x => Math.floor(x * 1000 + 1e-9) / 1000;
  const num = x => (x === null || x === undefined || x === "" || !isFinite(Number(x))) ? null : Number(x);

  function formula(f, baseMean) {
    if (!f || !isFinite(baseMean)) return { value: NaN, floorApplied: false };
    let b = baseMean, floorApplied = false;
    if (f.floor != null && b < f.floor) { b = f.floor; floorApplied = true; }
    return { value: b * (f.mult ?? 1) + (f.add ?? 0), floorApplied };
  }

  function band(assay, ratio) {
    for (const b of assay.bands) {
      // small tolerance so a value exactly on a boundary (e.g. OD = 3 x NC) is not moved by rounding
      if (b.inclusiveMax ? ratio <= b.max + 1e-9 : ratio < b.max - 1e-9) return b;
    }
    return assay.bands[assay.bands.length - 1];
  }

  const isReactiveCode = code => code === "POS" || code === "IR";

  /* Apply the insert's rule for dropping one outlying control replicate. */
  function applyDiscard(assay, ctrl, values) {
    const notes = [], unresolved = [];
    let used = values.slice();
    for (const rule of assay.discard || []) {
      if (rule.ctrl !== ctrl || used.length === 0) continue;
      const m = mean(used);
      if (rule.skipIfMeanBelow != null && m < rule.skipIfMeanBelow) continue;
      if (rule.maxDevPct != null) {
        const devs = used.map(v => Math.abs(v - m) / m * 100);
        const worst = devs.indexOf(Math.max(...devs));
        if (devs[worst] > rule.maxDevPct) {
          if (used.length >= 3) {
            notes.push(`${ctrl} replicate ${used[worst].toFixed(4)} is ${devs[worst].toFixed(0)}% from the mean and was discarded.`);
            used.splice(worst, 1);
          } else {
            notes.push(`${ctrl} replicates differ by more than ${rule.maxDevPct}%, but with only ${used.length} wells the discard rule cannot be applied.`);
            if (rule.failIfUnresolvable) unresolved.push(rule);
          }
        }
      }
      if (rule.maxAbovePct != null || rule.maxOD != null) {
        let worst = -1, worstScore = 0;
        used.forEach((v, i) => {
          const above = (v - m) / m * 100;
          const over = (rule.maxAbovePct != null && above > rule.maxAbovePct) || (rule.maxOD != null && v > rule.maxOD);
          if (over && v > worstScore) { worst = i; worstScore = v; }
        });
        if (worst >= 0) {
          if (used.length >= 2) {
            notes.push(`${ctrl} replicate ${used[worst].toFixed(4)} is outside the insert's range and was discarded.`);
            used.splice(worst, 1);
          }
        }
      }
    }
    return { used, notes, unresolved };
  }

  function checkRule(rule, values, cutoff, used) {
    if (!values.length) return { pass: rule.optional ? null : false, missing: true };
    const test = v => {
      switch (rule.op) {
        case "<": return v < rule.value;
        case "<=": return v <= rule.value;
        case ">": return v > rule.value;
        case ">=": return v >= rule.value;
        case "between": return v >= rule.value[0] && v <= rule.value[1];
        case "<cutoffx": return v < cutoff * rule.value;
        case ">=ref": { const r = mean((used && used[rule.ref]) || []); return isFinite(r) && v >= r * rule.value - 1e-9; }
        default: return false;
      }
    };
    const pass = rule.stat === "each" ? values.every(test) : test(mean(values));
    return { pass, missing: false };
  }

  /* Does a register OD match the slip OD, allowing for 3-decimal rounding or truncation? */
  function odMatches(reg, od) {
    if (reg == null || od == null) return null;
    const eps = 0.00051;
    return Math.abs(reg - od) < 0.00006 || Math.abs(reg - round3(od)) < eps || Math.abs(reg - trunc3(od)) < eps;
  }

  /* Does a register calculation match, allowing for the NC and OD being rounded or truncated first? */
  function unitsMatch(assay, regUnits, od, regOD, baseMean) {
    if (regUnits == null || od == null || !isFinite(baseMean)) return null;
    const factor = assay.units ? assay.units.factor : 1;
    const ods = [od, round3(od), trunc3(od)];
    if (regOD != null) ods.push(regOD);
    const bases = [baseMean, round3(baseMean), trunc3(baseMean)];
    let best = Infinity;
    for (const o of ods) for (const b of bases) {
      const c = formula(assay.cutoff, b).value;
      const v = o / c * factor;
      best = Math.min(best, Math.abs(v - regUnits));
    }
    return { match: best <= 0.015 * (factor === 1 ? 0.1 : 1), diff: best };
  }

  function evaluate(run, assay) {
    const wells = (run.wells || []).filter(w => w && num(w.od) != null || (w && w.role === "S"));
    const ctrlVals = { NC: [], PC: [], BLK: [] };
    wells.forEach(w => { if (ctrlVals[w.role] && num(w.od) != null) ctrlVals[w.role].push(Number(w.od)); });

    const discardNotes = [], unresolved = [];
    const used = {};
    for (const k of Object.keys(ctrlVals)) {
      const d = applyDiscard(assay, k, ctrlVals[k]);
      used[k] = d.used; discardNotes.push(...d.notes); unresolved.push(...d.unresolved);
    }

    const baseMean = mean(used[assay.cutoff.base]);
    const co = formula(assay.cutoff, baseMean);
    const cutoff = co.value;

    const checks = assay.validity.map(rule => {
      const r = checkRule(rule, used[rule.ctrl] || [], cutoff, used);
      const vals = used[rule.ctrl] || [];
      return { rule, ...r, value: rule.stat === "each" ? vals : mean(vals) };
    });
    const unreadable = (run.wells || []).filter(w => w && w.role !== "S" && num(w.od) == null);
    if (unreadable.length) checks.push({ rule: { ctrl: unreadable[0].role, text: "Every control well readable on the slip" }, pass: false, missing: false,
      value: [], unreadable: unreadable.map(w => `${w.role} ${w.pos}`) });
    unresolved.forEach(rule => checks.push({ rule: { ctrl: rule.ctrl, text: `${rule.ctrl} replicates within ${rule.maxDevPct}% of their mean (outlier cannot be identified with ${ctrlVals[rule.ctrl].length} wells)` },
      pass: false, missing: false, value: ctrlVals[rule.ctrl] }));
    const valid = checks.every(c => c.pass !== false) && isFinite(cutoff);

    const replicateNotes = [];
    for (const [ctrl, n] of Object.entries(assay.replicates || {})) {
      const have = (run.wells || []).filter(w => w && w.role === ctrl && num(w.od) != null).reduce((t, w) => t + (w.meanOf || 1), 0);
      if (have < n) replicateNotes.push({ ctrl, have, need: n });
    }

    // Reader program comparison
    const printed = run.printed && num(run.printed.cutoff) != null ? Number(run.printed.cutoff) : null;
    let readerExpected = NaN;
    if (assay.readerProgram) readerExpected = formula(assay.readerProgram, mean(ctrlVals[assay.readerProgram.base])).value;

    let n = 0;
    const samples = [];
    for (const w of run.wells || []) {
      if (w.role !== "S") continue;
      n++;
      const od = num(w.od);
      const s = { ...w, n: w.n ?? n, od };
      if (od == null) { s.missing = true; samples.push(s); continue; }
      const odCalc = (assay.negZero != null && od < 0 && od >= assay.negZero) ? 0 : od;
      if (odCalc !== od) s.negTakenAsZero = true;
      s.ratio = odCalc / cutoff;
      s.units = assay.units ? s.ratio * assay.units.factor : null;
      s.band = band(assay, s.ratio);
      if (printed != null) {
        const pr = num(w.printedRatio);
        if (pr != null) {
          // The reader prints OD and cutoff to 4 decimals but divides unrounded values, so allow 0.00005 either way on both
          const h = 0.00005, cuts = [printed, readerExpected].filter(c => isFinite(c) && c > h);
          s.printedRatioMismatch = !cuts.some(c => {
            const lo = Math.max(0, od - h) / (c + h), hi = (od + h) / (c - h);
            return pr >= lo * 0.995 - 0.002 && pr <= hi * 1.005 + 0.002;
          });
        }
        if (w.printedFlag) {
          const readerR = /^R$/i.test(w.printedFlag);
          const insertR = isReactiveCode(s.band.code);
          s.readerDiscordant = readerR !== insertR;
          s.readerMissedGrey = !readerR && s.band.code === "GZ";
        }
        s.inGap = isFinite(cutoff) && od >= Math.min(printed, cutoff) && od < Math.max(printed, cutoff) && Math.abs(printed - cutoff) > 0.0006;
      }
      s.regODMatch = odMatches(num(w.regOD), od);
      const um = unitsMatch(assay, num(w.regUnits), od, num(w.regOD), baseMean);
      s.regUnitsMatch = um ? um.match : null;
      s.regUnitsDiff = um ? um.diff : null;
      samples.push(s);
    }

    const counts = {};
    samples.forEach(s => { if (s.band) counts[s.band.code] = (counts[s.band.code] || 0) + 1; });

    // Findings, most serious first
    const F = [];
    const add = (sev, title, detail) => F.push({ sev, title, detail });
    if (!isFinite(cutoff)) add("bad", "Cutoff cannot be calculated", `No ${assay.cutoff.base} value was found. Mark the control wells for this run.`);
    checks.filter(c => c.pass === false).forEach(c =>
      add("bad", `Run invalid: ${c.rule.text}`, c.unreadable ? `${c.unreadable.join(", ")} could not be read, so the run cannot be confirmed valid.` : c.missing ? "This control was not read on the plate." :
        `Value ${Array.isArray(c.value) ? c.value.map(v => v.toFixed(4)).join(", ") : Number(c.value).toFixed(4)}. The insert requires the run to be repeated.`));
    const disc = samples.filter(s => s.readerDiscordant);
    if (disc.length) add("bad", `${disc.length} sample${disc.length > 1 ? "s" : ""} flagged differently by the reader and the insert`,
      `Sample${disc.length > 1 ? "s" : ""} ${disc.map(s => s.n).join(", ")}. Check what was reported for ${disc.length > 1 ? "these patients" : "this patient"}.`);
    const regUnitsBad = samples.filter(s => s.regUnitsMatch === false);
    if (regUnitsBad.length) add("warn", `${regUnitsBad.length} register calculation${regUnitsBad.length > 1 ? "s do" : " does"} not match`,
      regUnitsBad.map(s => `${s.pos}: register ${Number(s.regUnits).toFixed(2)}, correct ${s.units != null ? s.units.toFixed(2) : s.ratio.toFixed(2)}${s.regUncertain ? " (to verify)" : ""}`).join("; ") + ".");
    const regODBad = samples.filter(s => s.regODMatch === false);
    if (regODBad.length) add("warn", `${regODBad.length} register OD${regODBad.length > 1 ? "s differ" : " differs"} from the slip`,
      regODBad.map(s => `${s.pos}: register ${s.regOD}, slip ${s.od.toFixed(4)}${s.regUncertain ? " (to verify)" : ""}`).join("; ") + ".");
    if (printed != null && isFinite(cutoff) && Math.abs(printed - cutoff) > 0.0006) {
      const gap = samples.filter(s => s.inGap);
      add("warn", `Reader cutoff ${printed.toFixed(4)} differs from insert cutoff ${cutoff.toFixed(4)}`,
        (co.floorApplied ? `Mean ${assay.cutoff.base} is below ${assay.cutoff.floor}, so the insert uses the floor value; the reader program (${run.printed.formula || assay.readerProgram?.text || "as printed"}) does not. ` : "") +
        `${gap.length} sample${gap.length === 1 ? "" : "s"} in this run had OD between the two cutoffs.`);
    }
    if (printed != null && !run.printed.otherProgram && isFinite(readerExpected) && Math.abs(printed - readerExpected) > 0.0006)
      add("warn", "Printed cutoff does not match the reader's own formula", `From the controls, the program should give ${readerExpected.toFixed(4)}. Check the control values entered.`);
    const prBad = samples.filter(s => s.printedRatioMismatch);
    if (prBad.length) add("warn", `${prBad.length} printed ratio${prBad.length > 1 ? "s do" : " does"} not match OD ÷ printed cutoff`,
      `Samples ${prBad.map(s => s.n).join(", ")}. Usually a misread digit. Recheck against the slip.`);
    const eqv = samples.filter(s => s.band && (s.band.code === "EQV" || s.band.code === "GZ"));
    if (eqv.length) add("warn", `${eqv.length} sample${eqv.length > 1 ? "s" : ""} in the ${assay.bands.find(b => b.code === "EQV") ? "equivocal" : "grey"} zone`,
      `${eqv.map(s => `${s.pos} (${s.units != null ? s.units.toFixed(2) + " units" : "ratio " + s.ratio.toFixed(3)})`).join(", ")}. Confirm how ${eqv.length > 1 ? "these were" : "this was"} reported.`);
    const greyMissed = samples.filter(s => s.readerMissedGrey);
    if (greyMissed.length) add("warn", "Reader grey zone is off", `Samples ${greyMissed.map(s => s.n).join(", ")} fall in the insert's grey zone but were printed NR.`);
    else if (run.printed && /^NO/i.test(run.printed.greyZone || "") && assay.bands.some(b => b.code === "GZ"))
      add("info", "Reader grey zone is off", "The insert defines a grey zone (ratio 0.9 to 1.0) that the reader program does not apply.");
    const reactive = samples.filter(s => s.band && s.band.code === "IR");
    if (reactive.length) add("info", `${reactive.length} initially reactive sample${reactive.length > 1 ? "s" : ""} need duplicate retesting`,
      `Samples ${reactive.map(s => s.n).join(", ")}, as the insert requires before reporting.`);
    replicateNotes.forEach(r => {
      if (r.ctrl === "BLK") add("info", "No blank well read", "The insert reads OD against a blank well. Record whether the lab omits it by policy.");
      else add("info", `${r.ctrl} run in ${r.have} well${r.have === 1 ? "" : "s"}; the insert uses ${r.need}`, "Fewer replicates weakens the outlier rule and the cutoff estimate.");
    });
    discardNotes.forEach(t => add("info", "Control replicate rule applied", t));
    const meanWells = (run.wells || []).filter(w => w && w.meanOf > 1);
    if (meanWells.length) add("info", "Control entered as a mean", meanWells.map(w => `${w.role} is the mean of ${w.meanOf} wells`).join("; ") + ". Only the mean was transcribed, so a limit for each well is checked on the mean.");
    if (run.slip && !samples.length) add("info", "Control values only",
      `Sample ODs were not transcribed for this run. From the slip: ${run.slip.samples} samples, ${run.slip.reactive} reactive (${run.slip.reactiveBy || "reader flags"}).`);
    if (assay.linearMax != null) {
      const over = ["PC", "NC"].flatMap(k => ctrlVals[k].filter(v => v > assay.linearMax).map(v => `${k} ${v.toFixed(4)}`));
      if (over.length) add("info", `Control above the reader's linear range (${assay.linearMax} OD)`,
        `${over.join(", ")}. The run is still valid under the insert; this value is left out of the QC chart limits.`);
    }
    const negZ = samples.filter(s => s.negTakenAsZero);
    if (negZ.length) add("info", `${negZ.length} negative OD${negZ.length > 1 ? "s" : ""} taken as zero`, `Wells ${negZ.map(s => s.pos).join(", ")}, as the insert allows down to ${assay.negZero}.`);
    const missing = samples.filter(s => s.missing);
    if (missing.length) add("warn", `${missing.length} sample OD${missing.length > 1 ? "s are" : " is"} missing`, `Wells ${missing.map(s => s.pos).join(", ")} could not be read from the slip.`);
    const unsure = (run.wells || []).filter(w => w.uncertain);
    if (unsure.length) add("info", `${unsure.length} value${unsure.length > 1 ? "s" : ""} marked as hard to read`, `Wells ${unsure.map(w => w.pos).join(", ")}. Faded or overwritten on the slip.`);
    if (!F.some(f => f.sev === "bad" || f.sev === "warn")) F.unshift({ sev: "ok", title: "No discrepancies found", detail: "Controls meet the insert, and every check on this run agrees." });

    return {
      assay, cutoff, floorApplied: co.floorApplied, baseMean, ctrlVals, used,
      checks, valid, printed, readerExpected, samples, counts, findings: F, replicateNotes
    };
  }

  /* Sample and reactive counts: from the sample wells, or from the slip summary when only controls were transcribed. */
  function counts(run, ev) {
    if (!ev.samples.length && run.slip) return { samples: run.slip.samples || 0, reactive: run.slip.reactive || 0, equivocal: 0, fromSlip: true };
    return { samples: ev.samples.filter(s => !s.missing).length, reactive: ev.samples.filter(s => s.band && isReactiveCode(s.band.code)).length,
      equivocal: ev.samples.filter(s => s.band && (s.band.code === "EQV" || s.band.code === "GZ")).length, fromSlip: false };
  }

  /* Westgard rules on a series of control values in run order. */
  function westgard(values, baselineN = 20) {
    const base = values.slice(0, Math.min(baselineN, values.length));
    const m = mean(base), s = sd(base);
    const pts = values.map((v, i) => ({ v, i, z: s > 0 ? (v - m) / s : 0, rules: [] }));
    if (!(s > 0) || values.length < 3) return { mean: m, sd: s, pts, provisional: true, enough: false };
    pts.forEach((p, i) => {
      const z = p.z, prev = pts[i - 1];
      if (Math.abs(z) > 3) p.rules.push({ id: "1-3s", reject: true });
      else if (Math.abs(z) > 2) p.rules.push({ id: "1-2s", reject: false });
      if (prev && ((z > 2 && prev.z > 2) || (z < -2 && prev.z < -2))) p.rules.push({ id: "2-2s", reject: true });
      if (prev && ((z > 2 && prev.z < -2) || (z < -2 && prev.z > 2))) p.rules.push({ id: "R-4s", reject: true });
      if (i >= 3) { const w = pts.slice(i - 3, i + 1).map(q => q.z); if (w.every(x => x > 1) || w.every(x => x < -1)) p.rules.push({ id: "4-1s", reject: true }); }
      if (i >= 9) { const w = pts.slice(i - 9, i + 1).map(q => q.z); if (w.every(x => x > 0) || w.every(x => x < 0)) p.rules.push({ id: "10x", reject: true }); }
    });
    return { mean: m, sd: s, cv: s / m * 100, pts, provisional: base.length < baselineN, enough: true, baselineN: base.length };
  }

  /* Summary across runs of one assay, for the audit. */
  function summarise(runs, assay) {
    const evs = runs.map(r => ({ run: r, ev: evaluate(r, assay) })).sort((a, b) => (a.run.date || "").localeCompare(b.run.date || ""));
    const S = { runs: evs.length, samples: 0, reactive: 0, equivocal: 0, invalidRuns: 0, samplesInInvalid: 0, reactiveInInvalid: 0,
      regUnitsChecked: 0, regUnitsErrors: 0, regUnitsToVerify: 0, regODChecked: 0, regODErrors: 0, regODToVerify: 0, readerDiscordant: 0, gapSamples: 0,
      cutoffDiffRuns: 0, replicateShortRuns: 0, blankMissingRuns: 0, slipRuns: 0, from: evs[0]?.run.date, to: evs[evs.length - 1]?.run.date };
    for (const { run, ev } of evs) {
      const c = counts(run, ev);
      const ns = c.samples, nr = c.reactive;
      if (c.fromSlip) S.slipRuns++;
      S.samples += ns; S.reactive += nr;
      S.equivocal += ev.samples.filter(s => s.band && (s.band.code === "EQV" || s.band.code === "GZ")).length;
      if (!ev.valid) { S.invalidRuns++; S.samplesInInvalid += ns; S.reactiveInInvalid += nr; }
      for (const s of ev.samples) {
        if (s.regUnitsMatch != null) { S.regUnitsChecked++; if (!s.regUnitsMatch) { if (s.regUncertain) S.regUnitsToVerify++; else S.regUnitsErrors++; } }
        if (s.regODMatch != null) { S.regODChecked++; if (!s.regODMatch) { if (s.regUncertain) S.regODToVerify++; else S.regODErrors++; } }
        if (s.readerDiscordant) S.readerDiscordant++;
        if (s.inGap) S.gapSamples++;
      }
      if (ev.printed != null && isFinite(ev.cutoff) && Math.abs(ev.printed - ev.cutoff) > 0.0006) S.cutoffDiffRuns++;
      if (ev.replicateNotes.some(r => r.ctrl !== "BLK")) S.replicateShortRuns++;
      if (ev.replicateNotes.some(r => r.ctrl === "BLK")) S.blankMissingRuns++;
    }
    return { S, evs };
  }

  /* Is a control value usable for QC limits (inside the reader's linear range)? */
  const inLinear = (assay, v) => !(assay && assay.linearMax != null && v > assay.linearMax);

  const api = { counts, inLinear, ROWS, ALL_POS, posIndex, posAt, isPos, mean, sd, round3, trunc3, formula, band, evaluate, westgard, summarise, isReactiveCode, odMatches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(this);
