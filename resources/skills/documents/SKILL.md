---
name: documents
description: Read PDF, DOCX, PPTX, and XLSX (plus XLS/ODS/CSV) files as Markdown with stable locators, via the read_document tool, plain read, and @file arguments.
requires-resource: extensions.documents
---

# Documents

Kimchi reads office documents natively; no skills, plugins, or external tools are required. This skill ships in phases — creation and editing land under the separate `extensions.documents-write` toggle (not yet available).

## Reading

`read` and `@file` handle whole small documents transparently. Use `read_document` when you need control:

- **Large documents.** Output is capped at 20 units and 50 KB per call. Read by range: `read_document({ path, pages: "1-5" })` works for pages (PDF), slides (PPTX), and sheet numbers (XLSX). A truncated reply contains a continuation pointer — call again with a narrower range.
- **Specific sheets and rows.** `read_document({ path, sheet: "Totals", rows: "20-60" })`. A missing sheet name returns the list of valid names.
- **Formulas.** `read_document({ path, formulas: true })` shows formula strings instead of computed values (XLSX/XLS/ODS).
- **Scanned / image-only PDFs.** Pages with no text layer are rendered to images and attached automatically when your model accepts image input — just `read` them. The text notes `N scanned page(s) attached as images.` when this happens. On a text-only model you get a "no text layer" warning instead; switch to a vision-capable model (`/model`, rows with the IMG marker) to read them.

## Locators — why the output looks the way it does

Extraction output carries stable locators that later editing phases operate on. They are part of the contract; do not edit them out of quotes or round-trips:

- PDF: `## Page N` headings; form field names.
- PPTX: `## Slide N` headings plus `[shape "Title 1"]`; hidden slides are marked `*hidden slide*`; charts appear as `[chart]` markers; speaker notes follow a `Notes:` line.
- XLSX: sheet tables print column letters (A, B, …) and 1-based row numbers; hidden sheets are marked; values are formatted by the cell's number format (dates are deterministic).
- DOCX: tables carry `[table N]` markers; headings keep their level.

Pass `locators: false` to read for content only.

## Failures are typed, not silent

Encrypted PDFs, files over the 20 MB cap (raise with `KIMCHI_DOCUMENT_MAX_MB`), corrupt packages, and legacy `.doc`/`.ppt` all return an explicit typed error naming the cause. Legacy formats are intentionally unreadable until the LibreOffice phase; do not attempt to parse them with shell hacks.
