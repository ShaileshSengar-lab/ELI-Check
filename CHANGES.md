# Changes

## v1.4.0 (4 November 2026)
- Scan with camera: a live view from the rear camera with a frame to fit the slip in, a Capture button,
  and a light (torch) button where the phone supports it. Where live camera access is not available, the
  phone's own camera opens instead. Images stay on the device.
- Scanning, for camera shots and chosen photos: when one clear slip is found, its four corners are
  located, the slip is straightened into an upright rectangle and the light is evened out before reading.
  "Use original photo" switches back. Several strips side by side, or a slip that already fills the
  photo, are left as they are. On the real HBsAg slip: all 52 lines read (the PC for the first time),
  41 of 49 samples correct (was 37), 2 empty (was 6), none wrong without a flag. Straightening without
  the light evening was tested and not used (it added 2 unflagged errors).

## v1.3.9 (4 November 2026)
- Doubtful values are read a second time, each cut out and enlarged on its own and restricted to
  digits. On slips with a printed ratio and cutoff (Erba LisaScan), the reading that agrees with
  ratio × cutoff is kept; otherwise the flag is cleared only when both readings agree confidently,
  and the second reading is shown when they differ. On three real slips (117 values): correct values
  100 → 102, amber rows to check 58 → 34, no wrong value left unflagged. Adds about a second per slip.
- Whole-image enlargement and black-and-white conversion were tested and not adopted: each helped
  one slip but made another worse.
- Photo tips on the Add run screen updated (photograph before marking; strips may be side by side).

## v1.3.8 (4 November 2026)
- Controls are entered one row per control: control type, well, and the OD typed from the slip. This
  replaces the well-list boxes of v1.3.7.
  - The typed OD is used for the calculation, so controls are right even when the photo reading is not.
  - Each typed OD is compared with what was read for that well. A difference must be corrected, or
    confirmed as what the slip shows, before the run can be saved.
  - If the typed OD was read in a different well, that well is named, which catches misread well labels.
  - A control outside its insert limit (for example a PC that looks like a sample), or far from this
    lot's usual value (beyond 3 SD over at least 5 earlier runs), is flagged for a second look.
  - Wells are pre-filled as before (last run of the assay, kit layout, or the slip's control lines).
  - The control check (well, typed OD, read OD, confirmed) is saved with the run for the audit.

## v1.3.7 (4 November 2026)
- New "Control wells on this plate" box in Add run: type the NC, PC and blank wells (for example
  E4 F4 G4, or a range E4-G4). Wells are filled in the same way as the last saved run of that assay
  (last wells, first wells or fixed wells), or from the kit's usual layout the first time; for Erba
  LisaScan slips they come from the control lines on the slip. A control well missing from the slip
  gets an empty row to type in.
- "PC not run on this plate" can be ticked. The run stays invalid, as the insert requires, and the
  reason is recorded on the run instead of looking like a reading error. Such a run does not change
  the remembered control pattern.

## v1.3.6 (4 November 2026)
- OD-only (Merilyzer) slips: strips photographed side by side are read correctly. The photo is read a
  second time in page-layout mode, values are grouped into columns, and each readable well label pins
  its value to that well; values between labels are placed in order and flagged if their place is
  uncertain, so one unreadable line cannot shift the rest. Tested on a real three-strip scrub typhus
  slip: 33 of 36 values correct, the rest flagged or left empty, none wrong without a flag.
- A well whose label was read but whose value was covered (for example by ink) keeps its row, so the
  controls at the end of the run are still marked in the right wells.
- When the slips fill most of the photo, the whole photo is read instead of a box.

## v1.3.5 (4 November 2026)
- The slip is found and boxed automatically when a photo is opened (thermal paper is whiter than
  register sheets), so text from the register beside it is not mixed in. The box can still be redrawn.
- Controls whose label was not read are placed using the slip's own cutoff line (for example
  mNC + 0.05 = 0.0515 means the NCs average about 0.0015), and a small value is never taken as the PC.
  A control that cannot be read is left as an empty row to type in, instead of being filled wrongly.

## v1.3.4 (4 November 2026)
- Updates now show on the next open: app files are fetched fresh when online and the saved copy is
  used only offline. Previously a device could keep showing the old version after an update.

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
