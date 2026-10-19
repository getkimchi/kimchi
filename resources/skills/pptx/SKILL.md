---
name: pptx
description: Read, inspect, check, create, edit, and visually render PowerPoint decks (.pptx) locally. Use whenever the user mentions a .pptx file or slides.
requires-resource: skills.pptx
disables-skills: pptx
---

# pptx

All commands run the bundled runtime. Replace `<deck>` with the user's path.
- With the kimchi binary: `BUN_BE_BUN=1 kimchi <skill>/scripts/pptx.mjs <command> ...`
  (`<skill>` = this skill's directory e.g. `<kimchi-data>/extensions/skills/pptx`)
- On Windows/Git Bash the same `BUN_BE_BUN=1 kimchi ...` prefix works.
- Fallback if `kimchi` is not on PATH and Node is: `node <skill>/scripts/pptx.mjs ...`

## read `<deck> [start-end]`

Slides as Markdown with locators — `[shape "…"]` names, `[table N]` indices — the exact
names `edit` needs. Speaker notes print under `Notes:`.

- **20 slides per call.** For longer decks, read ranges: `read deck.pptx 1-20`, then
  `21-40`, etc. The output tells you the next range to request.
- **Summarize numbers, never retype them.** Quote a number only when you'd burn it into
  the deck again; otherwise reference it ("Q3 ARR row") to keep summaries accurate.

## inspect `<deck>`

Name every slide layout, its placeholders (type, idx), and slide dimensions; list every
shape by exact name. Run this before `edit` — edit ops take the names printed here,
unchanged. **No `inspect` → no `edit`.**

## check `<deck>`

Static review. Exit code 1 when anything is flagged — treat flags as
**heuristics**, named plainly ("likely text overflow"). Run after every edit
pass; if `check` reports findable defects, review a flagged area before
finishing. Heuristics can false-positive on tight text — read the exact slide
before rewriting.

- `text-overflow` — text estimated past its shape box.
- `overlap` — two text shapes whose boxes intersect (spilled text colliding
  with the shape below it).
- `low-contrast` — dark text on a dark slide background (explicit or
  inherited).
- `off-slide` — shapes past the slide edge.
- `missing-alt-text` — pictures without alt text.
- `monotony` — deck-level: most slides are title-and-text only. Vary layouts
  (see `deck-design.md`).

## render `<deck> --out <dir> [--slides N-M]`

Visual QA: LibreOffice converts the deck to PDF, then per-slide PNGs land in
`--out` (one path per line on stdout). **Optional** — needs LibreOffice
(`brew install --cask libreoffice` / `apt install libreoffice`); every other
command works without it. Read the PNGs of the slides you just wrote before
calling the deck done: you are looking for text touching box edges,
misalignment, and colors that die against the background. `error
[tool-missing]` names the install command — fall back to `check` instead of
stalling. Out of range `--slides` is an error; the intermediate PDF is kept
and named in the message.

## create `<out.pptx> --content deck.md [--theme theme.json] [--template branded.pptx]`

Write the deck as Markdown (format reference: the extension's `deck-markdown.md`;
design judgment: `deck-design.md` — read it once per session). Slides split by
`---`; `# title` with `:: layout` hints; ` ```kicker ` section labels; bullets;
tables; ` ```chart ` blocks; design blocks (` ```stats `, `quote`, `cards`,
`flow`, `code`); a `Notes:` paragraph for speaker notes.

- `--theme theme.json`: palette and type (`font`, `accent`, `background`,
  `surface`, `text`, `muted`, `headingFont`, `monoFont`, `footer`) — see
  `deck-markdown.md`. A dark `background` derives the light text/surfaces for you.
- `--template branded.pptx`: keeps the org master/theme/floating images and fills title
  and content placeholders per layout. Charts, design blocks and images are NOT filled
  in template mode — create without `--template` first if you need them, then copy
  static brand images over manually if asked.
- **Always run `check` on the created deck.** Its output tells you what to fix before
  handing the file to the user.
- Standard layouts the writer accepts: `title`, `hero`, `content`, `two-column`,
  `table`, `chart`, `closing`, `blank`.
- The writer refuses overfull slides (`error [slide-overfull]`) — split the slide,
  don't shrink the text.

### Create checklist (read once per session)

1. One idea per slide; at most 6 bullets per content slide; sub-bullets by
   indenting two spaces.
2. Vary layouts across the deck — adjacent slides shouldn't share a shape.
   Reach for `stats`/`cards`/`flow`/`quote` before another bullet list.
3. Ship a complete theme (palette + `line` + fonts), never font-and-accent
   only — a bare theme wastes the derived dark/light machinery and washes
   out card borders.
4. One ` ```chart ` per `:: chart` slide; bar/line/pie/doughnut with `labels` and
   `series[].values` of equal length — the parser rejects mismatches.
5. Dollar amounts always text or tables, never pie slices.
6. When LibreOffice is available, `render` and Read the PNGs of the title slide
   and one dense slide before handing over.

## edit `<in.pptx> --out <out.pptx> --ops ops.json`

Apply ops from a JSON array. **Edits never write in place** — the output path must
differ from the input. The input stays byte-identical, so iterating is safe.

Any failed op aborts the whole edit with nothing written; errors name the exact fix
(the known shapes are listed when a name is wrong). Validate the result with
`read`/`check` before handing it over, and re-`inspect` after adding slides.

Ops:

```json
{"type": "set_shape_text", "slide": 1, "shape": "Title 3", "value": "New headline"}
{"type": "set_shape_notes", "slide": 1, "value": "Speaker notes"}
{"type": "set_table_cell", "slide": 3, "table": 1, "cell": "B3", "value": "18%"}
{"type": "set_table_row", "slide": 3, "table": 1, "row": 2, "values": ["EMEA", "21%", "trending up"]}
{"type": "append_slide", "layout": "Title and Content", "title": "Recap"}
{"type": "delete_slide", "index": 4}
{"type": "reorder_slides", "order": [1, 2, 4, 3]}
{"type": "set_deck_core_property", "name": "title", "value": "Q3 Review FINAL"}
```

- Slide/row indices are 1-based; `cell` is A1-style; `values` must match the column count.
- Formatting inherits: new paragraphs clone the shape's last paragraph, so bullets,
  indent, and the last character styling carry over — **if a paragraph is bullet-styled
  it stays bullet-styled**.
- `layout` names come from `inspect` (e.g. "Title Slide" — exact, case-insensitive).

Requesting an unsupported op reports which ops exist; requesting an unknown
shape/table/slide reports what exists on the slide. **If the user asks for flaky
formatting (fonts on one span, gradients, motion), say no and explain** — these ops
cover structure and text only.

## Validation errors to know

- `error [package-validation]`: the edited package would not open — fix the op
  (usually an out-of-range index) and retry. The input is unchanged.
- `error [unsupported-format]`: the deck shape is real but this skill refuses it
  (e.g. charts inside `--template`, editing notes without a notes part); the
  message says what to do instead.
- `error [corrupt]` / `[safety-limit]`: the file itself failed to parse or tripped a
  safety cap. Don't retry blindly — report the exact message.
- `error [too-large]`: the deck is over the 20 MB input cap. The cap can be
  raised with `KIMCHI_DOCUMENT_MAX_MB`; document moves, zipping, or copying to a
  smaller deck are the usual fixes.
