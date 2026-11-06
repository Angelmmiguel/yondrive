# Spike A: keeping files intact

Question: does "unedited content is written back verbatim" (PLAN 6.2) hold, and how much of a typical file falls in the editor subset?

**Verdict: the mechanism holds. The pass criteria are only partly met, because the real-file corpus and the Word/Excel open check could not be run here.**

## What was tested

Kept, with tests (`web/src/lib/formats/`, 12 vitest cases):

- `zip.ts`: reader and writer on native `CompressionStream`/`DecompressionStream` (`deflate-raw`). An entry that is not replaced is copied with its original local record (header, data, any data descriptor) and its original central directory record, only the offset patched. Order is preserved. Replaced entries are recompressed; new ones are appended. Checks CRC on read. No ZIP64, no encryption (both throw).
- `xml.ts`: pull parser with `start`/`end` offsets on every token and `findSpans`, which returns the source range of each outermost matching element. Edits are string splices on the decoded source, so every byte outside the edited block is the original. `decodeXml` keeps the BOM so re-encoding is lossless.

Throwaway experiment (not committed), run in plain Node 22 against the same modules:

1. `.docx`: replace the text of one paragraph by splicing only its span.
2. `.xlsx`: change one cell value in a sheet part, and one shared string.
3. `.odt`: edit one paragraph in `content.xml`.
4. A 3.2 MB `document.xml` (8,081 paragraphs) for cost.
5. A block census against the PLAN's editor subset.

Assertions per run: same entry names in the same order; every other entry has an identical local record (header and compressed bytes) and CRC; inside the edited part, the text before and after the edit window is identical.

## Numbers

| Case | Result |
| --- | --- |
| docx, 17 entries, edit 1 paragraph | 16/16 other entries byte-identical; in `document.xml` the changed window is the edited paragraph only |
| xlsx, 14 entries, edit 1 cell | 13/13 other entries identical; changed window is 1 character |
| xlsx, edit a shared string | 13/13 identical |
| odt, 10 entries | 9/9 identical; `mimetype` stays first and stored |
| 3.2 MB `document.xml` | inflate and decode 24 ms, parse 144 ms, splice and write 22 ms (Node, not a phone) |

Census against the PLAN subset (simple rules in the experiment; paragraphs with tracked changes, equations, charts, text boxes, fields, content controls, comment anchors and footnote references are counted as locked, tables with merges or locked content too):

- Synthetic report with every hostile feature in it (`report.docx`): 19 body blocks, 13 editable (68%). The 6 locked are 1 chart, 1 comment anchor, 2 equations, 1 footnote reference, 1 tracked change. This is an adversarial mix, not a typical one.
- Pandoc-generated plain document, 8,081 paragraphs: 100% editable. Also not typical.
- Hand-authored xlsx sheet, 18 cells: 17 editable (94%); the one locked cell holds `XLOOKUP`, outside the formula subset. Chart, drawing, comments and calc chain stay untouched as separate parts.

The percentages say only that the classifier works and that locked blocks are isolated by block. They are not a share of "typical content".

## What could not be tested

- **Real files.** There are none on this machine. The fixtures are synthetic: `pandoc` for docx/odt, hand-written OOXML for xlsx, with tracked changes, a comment, a footnote, equations and a chart part added. Producer quirks (Word's `mc:AlternateContent`, revision ids, `xml:space`, Excel's data descriptors and extra fields, LibreOffice and Google exports) are not represented. This is **not** the real-file corpus.
- **Opening in Word or Excel.** Neither is available. Whether the saved files open "without complaint" is unverified. The synthetic xlsx also has a `legacyDrawing` reference with no VML part, so it is not a faithful Excel file.
- The census rules were written by us against our fixtures, so the shares are optimistic by construction.
- ZIP64, files with data descriptors written by a streaming producer, and archives with prefix bytes or comments were not exercised.
- Browser behaviour of `CompressionStream` (the tests run in Node's implementation) and speed on a mid-range phone.

## What it means for Phase 5

- The 6.2 rule is sound at the ZIP and XML level: part-level and block-level verbatim write-back is straightforward and cheap. The file-level guarantee is "all other parts byte-identical, the edited part identical outside the edited blocks". The edited part is recompressed whole, so its compressed bytes always change.
- Keep the Spike A exit open for two items before Phase 5 closes: a corpus of real files (Word, LibreOffice, Google Docs, Excel exports) and a manual Word/Excel/LibreOffice open check of saved outputs. Add these to the Phase 5 and 6 exit criteria and the test plan.
- Spreadsheet edits are not purely local. Changing a cell leaves cached `<v>` values of dependents stale, so those cells must be rewritten too, or the workbook flagged `fullCalcOnLoad`, and `calcChain.xml` must be updated or dropped. Shared strings must be appended, not mutated, because cells share them. Plan this explicitly in Phase 6.
- Dependents cached values: an unknown function (XLOOKUP here) makes the cell read-only, which matches 6.3.
- ODF needs `mimetype` first and stored; the writer already preserves that.
- Locked-block granularity works at top-level blocks. Paragraphs mixing editable text and tracked changes lock whole, as the PLAN says. Whether that locks too much in real documents depends on the corpus.
- No change to the plan's structure. The format table in the README should keep "best effort" wording for anything not checked against a real application.
