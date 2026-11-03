/*
  Assay rule sets, one per kit, taken from the kit insert in use.

  Kits included: scrub typhus IgM and chikungunya IgM (serology); HEV IgM,
  HAV IgM, HBsAg and anti HCV (virology). HBsAg and anti HCV have two kits
  each, and each kit has its own block.

  provisional  if set, the rules are not yet confirmed against the insert; the
           app shows this text on every run of the assay

  To add an assay, copy an existing block, change the values to match its
  insert, and give it a new id. Nothing else in the app needs to change.

  cutoff   how the insert defines the cutoff
           base   control whose mean the formula starts from ("NC" or "PC")
           add    number added to the base mean (0 if none)
           mult   number the base mean is multiplied by (1 if none)
           floor  if the base mean is below this, the floor value is used instead
  reader   the formula the plate reader is programmed with, as printed on its
           slip ("CUTOFF EQ."). Leave null when the reader prints OD only.
  bands    result categories by ratio (sample OD / cutoff)
  units    if set, results are reported as ratio x units.factor (e.g. IgM units)
  validity run acceptance rules from the insert, checked on control ODs
           stat "mean" checks the mean of the control wells, "each" every well
           op ">=ref" compares with another control: value x mean of "ref"
  linearMax  if set, control ODs above it are beyond the reader's linear range;
           the run stays valid, but these points are left out of the QC
           charts and Westgard limits
  negZero  if set, negative sample ODs down to this value are taken as zero
  replicates  number of wells the insert asks for, per control
  discard  rules for dropping one outlying control replicate
           skipIfMeanBelow  the rule is not applied when the control mean is below this
  layout   where controls are placed by default (can be changed per run)
           "start": controls listed first, from A1, in this order
           "end":   controls are the last wells read, in this order
*/
(function (root) {
  const ASSAYS = [
    {
      id: "scrub-igm-jmitra",
      name: "Scrub typhus IgM",
      kit: "Scrub Typhus IgM Microlisa",
      maker: "J. Mitra & Co.",
      insert: "MN/EST/074 VER-01 R-01 (Oct 2021)",
      section: "Serology",
      reader: "Merilyzer EIAQuant (OD only)",
      cutoff: { base: "NC", add: 0.35, mult: 1, floor: null, text: "Mean NC + 0.350" },
      readerProgram: null,
      units: { factor: 10, label: "IgM units" },
      bands: [
        { max: 0.9, code: "NEG", label: "Negative" },
        { max: 1.1, code: "EQV", label: "Equivocal", inclusiveMax: true },
        { max: Infinity, code: "POS", label: "Positive" }
      ],
      validity: [
        { ctrl: "NC", stat: "mean", op: "<", value: 0.15, text: "Negative control OD < 0.15" },
        { ctrl: "PC", stat: "mean", op: ">", value: 1.1, text: "Positive control OD > 1.1" }
      ],
      replicates: { NC: 2, PC: 1 },
      discard: [],
      layout: { where: "end", order: ["NC", "PC"] },
      notes: "Negative < 9 units, equivocal 9 to 11, positive > 11. Reactive samples to be confirmed by a confirmatory test."
    },
    {
      id: "hev-igm-trustwell",
      name: "HEV IgM",
      kit: "TRUSTwell HEV IgM ELISA",
      maker: "Athenese-Dx",
      insert: "PL-AE0105 Rev. C",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      cutoff: { base: "NC", add: 0.15, mult: 1, floor: 0.05, text: "Mean NC + 0.15, using 0.05 if mean NC is below 0.05" },
      readerProgram: { base: "NC", add: 0.15, mult: 1, floor: null, text: "mNC + 0.15" },
      units: null,
      bands: [
        { max: 1.0, code: "NEG", label: "Negative" },
        { max: Infinity, code: "POS", label: "Positive" }
      ],
      validity: [
        { ctrl: "PC", stat: "mean", op: ">=", value: 0.5, text: "Mean positive control ≥ 0.50" },
        { ctrl: "NC", stat: "mean", op: "<=", value: 0.1, text: "Mean negative control ≤ 0.10" },
        { ctrl: "BLK", stat: "mean", op: "<=", value: 0.1, text: "Blank ≤ 0.10", optional: true }
      ],
      replicates: { PC: 1, NC: 2, BLK: 1 },
      discard: [],
      layout: { where: "start", order: ["PC", "NC", "NC"] },
      notes: "Ratio < 1.0 negative, ≥ 1.0 positive. Read against a blank well."
    },
    {
      id: "hav-igm-trustwell",
      name: "HAV IgM",
      kit: "TRUSTwell HAV IgM ELISA",
      maker: "Athenese-Dx",
      insert: "PL-AE0100 Rev. B",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      cutoff: { base: "NC", add: 0, mult: 2.1, floor: 0.05, text: "Mean NC × 2.1, using 0.05 if mean NC is below 0.05" },
      readerProgram: { base: "NC", add: 0, mult: 2.1, floor: null, text: "mNC * 2.1" },
      units: null,
      bands: [
        { max: 1.0, code: "NEG", label: "Negative" },
        { max: Infinity, code: "POS", label: "Positive" }
      ],
      validity: [
        { ctrl: "PC", stat: "mean", op: ">=", value: 0.5, text: "Mean positive control ≥ 0.50" },
        { ctrl: "NC", stat: "mean", op: "<=", value: 0.1, text: "Mean negative control ≤ 0.10" },
        { ctrl: "BLK", stat: "mean", op: "<=", value: 0.1, text: "Blank ≤ 0.10", optional: true }
      ],
      replicates: { PC: 1, NC: 2, BLK: 1 },
      discard: [],
      layout: { where: "start", order: ["PC", "NC", "NC"] },
      notes: "Ratio < 1.0 negative, ≥ 1.0 positive. With the 0.05 floor the insert cutoff is 0.105 whenever mean NC is below 0.05. Read against a blank well."
    },
    {
      id: "chik-igm-niv",
      name: "Chikungunya IgM",
      kit: "NIV Chikungunya IgM Capture ELISA",
      maker: "ICMR National Institute of Virology, Pune",
      insert: "Version 3.4, effective 01/02/2013",
      section: "Serology",
      reader: "OD only reader (Test: ABS, 450/630 nm)",
      provisional: "Validity and interpretation are from the insert (version 3.4). Control well layout and reader settings are still to be confirmed.",
      cutoff: { base: "NC", add: 0, mult: 2, floor: null, text: "Mean NC × 2.0 (negative at or below); positive at or above NC × 3.0" },
      readerProgram: null,
      units: null,
      bands: [
        { max: 1.0, code: "NEG", label: "Negative", inclusiveMax: true },
        { max: 1.5, code: "EQV", label: "Equivocal, test a second sample 8 to 10 days later" },
        { max: Infinity, code: "POS", label: "Positive" }
      ],
      validity: [
        { ctrl: "NC", stat: "mean", op: "<=", value: 0.18, text: "Negative control OD ≤ 0.18" },
        { ctrl: "PC", stat: "mean", op: ">=ref", ref: "NC", value: 6, text: "Positive control OD ≥ 6 × negative control OD" }
      ],
      replicates: { NC: 1, PC: 1 },
      discard: [],
      layout: { where: "end", order: ["NC", "NC", "NC", "PC"] },
      notes: "Sample OD ≤ NC × 2.0 negative, ≥ NC × 3.0 positive, in between equivocal. Ratios shown are sample OD ÷ (NC × 2.0), so 1.0 to 1.5 is the equivocal zone."
    },
    {
      id: "hbsag-erbalisa-sen",
      name: "HBsAg (ErbaLisa SEN)",
      kit: "ErbaLisa SEN HBsAg",
      maker: "Transasia Bio Medicals (Erba)",
      insert: "Code 132140 (revision to be confirmed)",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      cutoff: { base: "NC", add: 0.15, mult: 1, floor: null, text: "Mean NC + 0.15" },
      readerProgram: { base: "NC", add: 0.15, mult: 1, floor: null, text: "0.15 + mNC" },
      units: null,
      bands: [
        { max: 1.0, code: "NEG", label: "Non reactive" },
        { max: Infinity, code: "IR", label: "Initially reactive, retest in duplicate", inclusiveMin: true }
      ],
      validity: [
        { ctrl: "BLK", stat: "mean", op: "<", value: 0.2, text: "Blank OD < 0.2", optional: true },
        { ctrl: "NC", stat: "each", op: "<", value: 0.1, text: "Each negative control < 0.1" },
        { ctrl: "PC", stat: "mean", op: ">", value: 1.0, text: "Positive control > 1.0" }
      ],
      linearMax: 2.5,
      negZero: -0.05,
      replicates: { BLK: 1, NC: 3, PC: 1 },
      discard: [],
      layout: { where: "start", order: ["NC", "NC", "PC"] },
      notes: "Repeatedly reactive samples (either duplicate reactive) must be confirmed by CLIA, NAT or neutralisation. A PC above 2.5 OD is beyond the reader's linear range; the run is still valid if every NC is below 0.1. Negative ODs down to minus 0.05 are taken as zero."
    },
    {
      id: "hbsag-monolisa-ultra",
      name: "HBsAg (Monolisa ULTRA)",
      kit: "Monolisa HBs Ag ULTRA",
      maker: "Bio-Rad",
      insert: "IFU 0001344 (2021/11), cat. 72348",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      cutoff: { base: "NC", add: 0.05, mult: 1, floor: null, text: "Mean NC + 0.050" },
      readerProgram: { base: "NC", add: 0.05, mult: 1, floor: null, text: "mNC + 0.05" },
      units: null,
      bands: [
        { max: 0.9, code: "NEG", label: "Negative" },
        { max: 1.0, code: "GZ", label: "Grey zone, retest in duplicate" },
        { max: Infinity, code: "IR", label: "Initially reactive, retest in duplicate and confirm by neutralisation", inclusiveMin: true }
      ],
      validity: [
        { ctrl: "NC", stat: "each", op: "<=", value: 0.08, text: "Each negative control ≤ 0.080" },
        { ctrl: "PC", stat: "mean", op: ">=", value: 1.0, text: "Positive control ≥ 1.000" }
      ],
      replicates: { NC: 4, PC: 1 },
      discard: [{ ctrl: "NC", maxDevPct: 40, skipIfMeanBelow: 0.01, text: "One NC more than 40% from the mean is discarded, unless mean NC is below 0.010" }],
      layout: { where: "start", order: ["PC", "NC", "NC"] },
      notes: "Grey zone ratio 0.9 to 1.0. Initially reactive samples are retested in duplicate; positive if either repeat ratio ≥ 1. Confirm by neutralisation (Bio-Rad cat. 72408)."
    },
    {
      id: "hcv-erbalisa-gen3",
      name: "Anti HCV (ErbaLisa Gen 3)",
      kit: "ErbaLisa HCV Gen 3",
      maker: "Transasia Bio Medicals (Erba)",
      insert: "To be confirmed",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      provisional: "Cutoff (mean NC + 0.3) and control limits (NC below 0.1, PC above 0.5) are provisional. Confirm the wording, whether the NC limit applies to each well or the mean, and the number of control wells against the Erba insert.",
      cutoff: { base: "NC", add: 0.3, mult: 1, floor: null, text: "Mean NC + 0.3" },
      readerProgram: { base: "NC", add: 0.3, mult: 1, floor: null, text: "0.3 + mNC" },
      units: null,
      bands: [
        { max: 1.0, code: "NEG", label: "Non reactive" },
        { max: Infinity, code: "IR", label: "Initially reactive, retest in duplicate", inclusiveMin: true }
      ],
      validity: [
        { ctrl: "NC", stat: "each", op: "<", value: 0.1, text: "Each negative control < 0.1 (provisional)" },
        { ctrl: "PC", stat: "mean", op: ">", value: 0.5, text: "Positive control > 0.5 (provisional)" }
      ],
      linearMax: 2.5,
      replicates: { NC: 2, PC: 1 },
      discard: [],
      layout: { where: "start", order: ["NC", "NC", "PC"] },
      notes: "The insert asks for a duplicate retest on the same kit, then RIBA or HCV RNA PCR."
    },
    {
      id: "hcv-monolisa-plus-v3",
      name: "Anti HCV (Monolisa PLUS)",
      kit: "Monolisa Anti-HCV PLUS Version 3",
      maker: "Bio-Rad",
      insert: "883635 (2013/09)",
      section: "Virology",
      reader: "Erba LisaScan EM (programmed cutoff)",
      cutoff: { base: "PC", add: 0, mult: 0.4, floor: null, text: "Mean PC × 0.4" },
      readerProgram: { base: "PC", add: 0, mult: 0.4, floor: null, text: "mPC * 0.4" },
      units: null,
      bands: [
        { max: 0.9, code: "NEG", label: "Negative" },
        { max: 1.0, code: "GZ", label: "Grey zone, retest in duplicate" },
        { max: Infinity, code: "IR", label: "Initially reactive, retest in duplicate", inclusiveMin: true }
      ],
      validity: [
        { ctrl: "PC", stat: "mean", op: "between", value: [0.8, 2.7], text: "Mean positive control 0.800 to 2.700" },
        { ctrl: "NC", stat: "each", op: "<cutoffx", value: 0.6, text: "Negative control < cutoff × 0.6" }
      ],
      replicates: { NC: 1, PC: 3 },
      discard: [{ ctrl: "PC", maxDevPct: 30, failIfUnresolvable: true, text: "One PC replicate more than 30% from the mean is discarded; with 2 wells an outlier cannot be identified and the run fails" }],
      layout: { where: "start", order: ["PC", "PC", "NC"] },
      notes: "Initially reactive samples are retested in duplicate; positive if at least one repeat ratio ≥ 1."
    }
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = ASSAYS;
  else root.ASSAYS = ASSAYS;
})(this);
