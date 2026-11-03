# ELI-Check

**Ensuring Laboratory Integrity.** A web app for the serology and virology laboratory.
It reads ELISA plate reader slips, recalculates the cutoff and sample results from the ODs to check each run against the kit insert, tracks controls with
Levey-Jennings charts and Westgard rules, and audits what was written in the run register.

It runs in any phone or computer browser, needs no account, and keeps its data on the device.
After the first visit it also works offline.

**Open the app:** https://shaileshsengar-lab.github.io/ELI-Check/

## What it does

- **Reads the slip.** Photograph the reader slip; text recognition runs inside the phone's browser,
  so photos never leave the device. Values can also be pasted or typed.
- **Shows every value for checking before saving.** Faded or unclear values, missed lines and
  printed ratios that do not match OD ÷ cutoff are highlighted.
- **Recalculates results.** From the ODs it works out run validity, the insert cutoff, the ratio or units, and the result category for
  each sample, using the rules in `js/assays.js`.
- **Compares the reader with the insert.** For readers that print a cutoff, it checks the
  programmed formula against the insert and lists samples falling between the two cutoffs.
- **Checks the register.** Optional register OD and result columns are compared with the slip,
  allowing for values rounded or truncated to three decimals.
- **Tracks controls.** Levey-Jennings charts per assay, kit and lot, with the insert limit drawn on
  the chart and Westgard rules 1-2s, 1-3s, 2-2s, R-4s, 4-1s and 10x.
- **Monthly IQC report.** Choose assay, lot and month and print or save as PDF: control limits in
  use, Levey-Jennings charts for the month, each run's accept or reject decision, a summary, space
  for corrective action and signature blocks. The signed copy is the controlled record.
- **Audit summary and export.** Invalid runs, results from invalid runs, discrepancies by type,
  and sample-level CSV for analysis.

## Assays included

| Assay | Kit | Rules |
|---|---|---|
| Scrub typhus IgM | J. Mitra Scrub Typhus IgM Microlisa | Confirmed against insert |
| Chikungunya IgM | NIV Chikungunya IgM Capture ELISA | Provisional |
| HEV IgM | Athenese-Dx TRUSTwell HEV IgM | Confirmed against insert |
| HAV IgM | Athenese-Dx TRUSTwell HAV IgM | Confirmed against insert |
| HBsAg | ErbaLisa SEN HBsAg | From insert |
| HBsAg | Bio-Rad Monolisa HBs Ag ULTRA | From insert |
| Anti HCV | ErbaLisa HCV Gen 3 | Provisional |
| Anti HCV | Bio-Rad Monolisa Anti-HCV PLUS v3 | From insert |

Each kit is a separate assay in the app, so its controls get their own QC charts.
To add an assay or update a rule after an insert revision, copy a block in `js/assays.js` and
change the values to match the insert. Nothing else needs to change.

## Where the data is kept

Runs are saved in the browser's storage on that device only. Clearing the browser's site data
deletes them. Use **Audit → Back up all runs** regularly and keep the file somewhere safe; it can
be restored on any device with **Restore from backup**. Backup files are not part of this repository.

## Scope and limits

- The tool is a quality control and verification aid. The reader output, the kit insert and the
  signed register remain the record of the reported result.
- Text recognition can misread digits on faded thermal paper. Every value must be checked against
  the slip before saving; the app highlights the ones most likely to be wrong, but cannot catch all.
- Westgard limits are set from the first 20 runs of each assay, lot and reader (shown as provisional with fewer).

## Files

| Path | Contents |
|---|---|
| `index.html`, `css/app.css` | Page and styles |
| `js/assays.js` | Kit insert rules, one block per kit |
| `js/engine.js` | Calculations: cutoff, validity, results, register checks, Westgard, audit |
| `js/parse.js` | Reads slip text from OD-only and cutoff-printing readers |
| `js/ocr.js` | Photo handling and text recognition |
| `js/app.js` | Screens, saving, export |
| `vendor/tesseract/` | Text recognition library (Tesseract.js 5.1.1, Apache 2.0) and English data |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and home screen icon |

© 2026 Dr. Shailesh Sengar. Software code was developed with AI assistance (Claude, Anthropic).
Assay rules were taken from the kit inserts and checked against hand calculations.
