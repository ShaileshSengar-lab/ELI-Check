# Changes

## v1.3.3 (4 November 2026)
- When no cutoff can be calculated (controls not marked or not read), samples are no longer classified.
  Previously every sample was shown as reactive in that case.
- Photo reading of Erba LisaScan slips made much more tolerant of recognition errors, tested on a real
  marked slip (correct sample values rose from 0 to about 35 of 49, with the rest flagged or left empty):
  - sample number run into the OD (for example "92.1007" for sample 9, OD 2.1007) is split correctly;
  - "SMP" and "NR" misread (SHP, sup, Np, NK) are recognised; a cutoff line with stray marks is still found;
  - a control whose label was not read fills the expected control slot; missing controls get an empty
    row to type in, so the cutoff can be calculated once filled;
  - sample numbers read from the slip anchor the order, so one stray line can no longer shift every
    later sample; a sample line that was not read gets an empty row so later wells keep their places;
  - each OD is checked against printed ratio × printed cutoff and flagged if they disagree; an OD lost
    entirely is estimated from the ratio and flagged.
- Photo preparation uses the red channel, so highlighter and red pen marks interfere less.
- "Read the slip" now labels the reader machine as "Reader: …", so it is not mistaken for the kit.

## v1.3.2 (3 November 2026)
First public release as ELI-Check (Ensuring Laboratory Integrity).

- Reads ELISA plate reader slips by photo, pasted text or typed values; text recognition runs on the device.
- Applies kit insert rules for run validity, cutoff, ratio or units and result category.
- Compares a reader's programmed cutoff with the insert cutoff and lists samples between the two.
- Compares optional register entries with the slip.
- Levey-Jennings charts by assay, kit lot and reader, with Westgard rules 1-2s, 1-3s, 2-2s, R-4s, 4-1s and 10x.
- Monthly IQC report for printing or saving as PDF, with signature blocks.
- Audit summary, CSV export, and backup and restore of all runs on a device.
- Works offline after the first visit and can be added to a phone's home screen.
