# Label Swipe: swipe labeler for the #636 calibration review

A local-only page that turns the owner columns of a calibration packet (#636, corrections scaffolds #648) into one swipe card per judgment, plus two scripts that connect it to the packet: `build-deck.mts` turns the review sheets into decks, and `import-labels.mts` writes the downloaded labels back into the sheets. The swipe mechanics (100 px threshold, 10 px before a press becomes a drag, card stack and buttons) are adapted from swipewatch. Its analytics, coins and modes are not carried over.

The page is vanilla HTML/CSS/JS with no build step. It makes no network calls: the Content-Security-Policy in `index.html` sets `connect-src 'none'` and loads nothing from other origins.

## Privacy rules

- **Decks are private.** They contain résumé and JD text, extracted Units and owner labels. They live under `~/.matchline/eval-analysis/calibration-2a/decks/` and never in a repository. Both scripts refuse to write inside any git work tree.
- The page reads decks through a file picker. Card content stays in the tab's memory. `localStorage` keeps only item ids, labels, notes, timings, the seed and the session id (key `label-swipe:v1:<deck_id>`), so a closed tab can resume where it stopped. Clear site data to forget a session.
- Downloaded `labels-*.json` files hold item ids (which include label ids such as `u_…` and `r_…`), labels and your notes. Treat them as private too, and keep them out of the repo.
- Neither script opens `KEY.json`, and the cards show no scores, no `≥0.5?` flags, no `endpoints mapped` column, no model names and no extracted-Unit refs (A3, R2, …). Arms appear only in item ids, as "A"/"B", exactly as in the packet.
- The only committed fixture, `fixtures/packet/`, is synthetic: every name and number in it is invented.

## Workflow

### 1. Build the decks

```bash
npx tsx tools/label-swipe/build-deck.mts
```

This reads `~/.matchline/eval-analysis/calibration-2a/<cell>.md` (every `*.md` except `README.md` and `SUMMARY.md`) and writes `decks/<cell>.json` next to them, mode 0600. Options: `--packet <dir>`, `--out <dir>` (must be outside any git work tree) and `--fixtures <dir>` (public fixture root for catch cards, default `tests/fixtures`). It is read-only over the sheets and does not read `corrections/`.

To try the page without private data, build the synthetic deck into a scratch folder:

```bash
npx tsx tools/label-swipe/build-deck.mts --packet tools/label-swipe/fixtures/packet --out /tmp/label-swipe-demo
```

### 2. Open the page

Open `tools/label-swipe/index.html` directly from the file system, or serve the folder:

```bash
npx serve tools/label-swipe
```

Click **Choose deck files…** and select one or all four decks. Cells run in the packet README's order: the nathan cell first, then the others alphabetically (`cell_order` in each deck). Each cell ends on its own screen with counts, median time per card and undo count, a **Download labels** button and **Next cell**.

### 3. Label

| Gesture | Key | Button | Label | Sheet value |
|---|---|---|---|---|
| Swipe right | → | True | `true` | `Y` |
| Swipe left | ← | False | `false` | `N` |
| Swipe down | ↓ | Mixed | `mixed` | `partial` (only on cards that allow it) |
| Swipe up | ↑ | Can't tell | `unsure` | left blank, note "can't tell" |
| Tap the card | Space | Show full source | expands the whole résumé / JD with the evidence lines highlighted | |
| | Z | Undo | undoes the last decision or re-queue (unlimited within a session) | |
| | N | Add a note… | one-line note on the last `false` / `mixed` card (Enter saves, Esc cancels) | |

- **Can't tell** moves the card to the end of the cell, and it comes back with its full source already open. A second **Can't tell** on the same card is recorded as `unsure`.
- **Mixed** is only accepted on `fact-correct` and `requirement-equivalent` cards, the two sheet columns that take `partial`. On the other cards the button is disabled, and a down swipe snaps back.
- Each card shows the question, the claim on the left and the evidence on the right. The evidence is the closest one or two lines of the source text, found by word overlap, or the expected requirement for `requirement-equivalent`. When no line is close, the card says so. Open the full source before answering N in that case.

### 4. Download

**Download labels** (in the header at any time, or on the end screen) saves `labels-<deck_id>-<UTC timestamp>.json`:

```json
{
  "deck_id": "<cell>",
  "seed": 12345,
  "session_id": "<uuid>",
  "items": [
    { "item_id": "ext:u_example:A/fact-correct", "type": "fact-correct", "label": "mixed", "note": "wrong year", "ms": 5210, "order": 1, "undos": 0, "catch": false }
  ],
  "attention": { "catch_cards": 4, "catch_correct": 4 }
}
```

`ms` is the time on the card, summed over every time it was shown (including before a **Can't tell** or an undo), and paused while the tab is hidden or the note field is open. `order` is the decision sequence. `undos` counts undos of that item. `seed` reproduces the card order: `LabelCore.shuffle(ids, seed)` over the deck's item ids in file order.

### 5. Import

```bash
npx tsx tools/label-swipe/import-labels.mts ~/Downloads/labels-<cell>-<timestamp>.json
```

This writes Y / N / partial into the owner columns of `<packet>/<deck_id>.md` and the notes into each row's `note` column. When a row has two cards with notes, the note reads `fact: …; verbatim: …`. Catch cards are skipped. Every arm A Unit and requirement labelled False, Mixed or Can't tell, with its note, also goes into the `notes` field of `corrections/<deck_id>.json`, as one block:

```text
[label-swipe deck=<cell> session=<session_id>]
A2 fact-correct: N — invented metric
R1 requirement-equivalent: partial — drops a qualifier
[/label-swipe]
```

Any text already in `notes` is kept. The importer does not set `owner_verdict` or the corrected fields; those remain for the #648 correction pass. Re-importing the same file changes nothing. A cell (or label-swipe block) that already holds a different value stops the import with a list of the conflicting row keys and nothing written; add `--force` to overwrite. `--dry-run` checks without writing, and `--packet <dir>` points at another packet. When every owner column is filled, the packet README's KEY.json comparison runs unchanged.

## How the sheets map to cards

Columns are found by header text, not position. A sheet whose table headers change fails loudly instead of filling the wrong column.

| Sheet section | Row key | Card type(s) | Owner column(s) | Claim · evidence |
|---|---|---|---|---|
| `## a. Extraction review`, one row per expected Unit × arm (`″` rows inherit the label above) | `ext:<label id>:<arm>` | `fact-correct` (true/false/mixed), `verbatim` (true/false) | `fact correct?`, `verbatim?`, `note` | extracted `raw_text` + `normalized_summary` · closest résumé lines |
| `### Extracted Units the scorer left unmatched`, one table per `**Arm X**` | `unit:<A3>` | `keep-unmatched-unit` (true/false) | `keep?`, `note` | `raw_text`, summary, skills · closest résumé lines + closest expected Unit id (score removed) |
| `## b. Requirements review` | `req:<label id>` | `requirement-equivalent` (true/false/mixed), `must-have-right` (true/false) | `correct?`, `must-have right?`, `note` | parsed requirement · expected requirement; parsed flag · JD section heading + JD line |
| `### Parsed Requirements the scorer left unmatched` | `ureq:<R3>` | `keep-unmatched-requirement` (true/false) | `keep?`, `note` | parsed requirement, category, flag · closest JD line |
| `## c. Match review` | `pair:<unit>:<requirement>` | `match-pair-agree` (true/false) | `still agree?`, `note` | Unit label and requirement label · closest résumé and JD lines |

Item ids are `<row key>/<card type>`. Extraction rows with no extracted Unit (`*(no extracted Unit assigned…)*`) and requirement rows with no parsed requirement have nothing to judge and get no card. `keep-unmatched-requirement` is a seventh card type beyond the six in the brief: the packet README's step 3 asks for `keep?` on unmatched parsed Requirements too.

## Catch cards

Each deck mixes in up to four attention-check cards with known answers, built only from the public fixture texts `tests/fixtures/resumes/<resumeId>.txt` and `tests/fixtures/jds/<jdId>.txt` (or from the sheet's own source section, which reproduces those fixtures, if the file is missing). The four checks are a true fact, the same kind of fact with one number changed (false), a verbatim quote (true), and a requirement paired with a different JD line (false). They are shuffled in with the real cards, look like them on screen, are marked `"catch": true` in the export, are skipped by the importer, and are summarised in `attention`. Their selection is deterministic per deck id.

## Bias notes

- **Fatigue.** A cell is about 120–150 cards. Take the end-of-cell screen as a break, and compare `ms` and catch accuracy across the first and second half of a cell before trusting late labels.
- **Right-swipe drift.** Most cards are true, so the easy gesture becomes a habit. Check the catch cards: a missed `false` catch card is the clearest drift signal. A high share of `true` with falling `ms` deserves a second look.
- **Catch-card use.** Treat `catch_correct / catch_cards` as an attention estimate, not a score. With four per cell it flags gross inattention only. Don't drop real labels on its basis without looking at the cards.
- **Undo.** Undo is unlimited, and each item's `undos` count is kept, so changed minds stay visible. Frequent undos on one card type suggest an unclear question, not a careless labeler.
- **Order.** Cards are shuffled within a cell, so one arm's rows aren't seen as a block, and the seed is recorded so the order can be reconstructed. Cells themselves run in a fixed order (nathan first), so a learning effect across cells is not randomised away.
- **Evidence excerpt.** The closest-line excerpt is a word-overlap guess, the same kind of proxy this review is calibrating. A claim that matches no line, or the wrong line, needs the full source (Space) before an N.

## Files

- `index.html`, `styles.css`, `app.js`: the page (classic scripts, so it also works from `file://`).
- `core.js` (+ `core.d.ts`): shuffle, decision reducer (label, unsure re-queue, undo, notes) and export, published as `globalThis.LabelCore`.
- `build-deck.mts`, `import-labels.mts`: the two CLIs. `lib/sheet.mts` parses sheets, `lib/deck.mts` builds cards and catch cards, `lib/importer.mts` writes labels back, and `lib/cli.mts` holds the outside-the-repo guard.
- `*.test.ts`: vitest suites, run by `npm test` and typechecked through `tsconfig.tests.json`.
- `fixtures/packet/`: the synthetic sheet and scaffold the tests use.
