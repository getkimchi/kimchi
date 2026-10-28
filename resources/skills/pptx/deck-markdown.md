# Deck Markdown

The input format for `pptx.mjs create --content FILE`. Phase 2's native
`create_document` tool will accept the same format, so everything documented
here is a contract, not an implementation detail. Every example lives in the
writer tests (`writers/pptx.test.ts`).

A deck is a sequence of slides separated by `---` (or a form-feed `\f`) on
its own line. Everything the `read` command prints is valid input — a read
followed by a create round-trips titles, bullets, tables, notes, and slide
count. Locator markers (`## Slide N`, `[shape "..."]`) are accepted and
ignored on create.

```markdown
# Q3 Review

- Revenue up 12%
- Costs flat

---

## Roadmap

| Workstream | Owner |
| ---------- | ----- |
| Scaling    | Infra |

```chart
{ "type": "bar", "labels": ["Q1", "Q2"], "series": [{ "name": "ARR", "values": [9.4, 11.3] }] }
```

Notes: remember to thank sponsors
```

## Slides

- The first `#` heading (or `#`-level locator `## Slide N` followed by a
  heading) names the slide. A slide without a heading starts untitled.
- `##`, `###` … are treated as plain headings inside a slide.
- A top-level ordered or unordered list renders as bullets, nested up to 4
  levels deep.
- Tables render as tables.
- A paragraph starting with `Notes:` (alone on its line) is speaker notes
  for the current slide.
- Regular paragraphs render as body text. `**bold**`, `*italic*` and
  \`code\` map to run properties; links keep their text only.

## Charts

A fenced code block with the language tag `chart` becomes a real chart (not
an image). The block body is JSON:

```json
{
	"type": "bar" | "line" | "pie" | "doughnut",
	"title": "optional chart title",
	"labels": ["Q1", "Q2"],
	"series": [{ "name": "ARR", "values": [9.4, 11.3] }]
}
```

Unknown `type` values are a typed error naming the slide. Empty `series` is
an error. Insufficient axis space is not an error — the chart renders anyway.

## Design blocks

Fenced code blocks with the language tags below become composed visual
elements — cards, terminal windows, quote plates — not code. Use them to
vary slide layouts; a deck where every slide is title-plus-bullets reads as
lazy (and `check` says so).

- ` ```stats ` — one metric per line, `value | label`. Rendered as a row of
  number cards in the accent color:

  ~~~markdown
  ```stats
  4.2× | faster cold starts
  $1.1M | annual savings
  38 | clusters migrated
  ```
  ~~~

- ` ```quote ` — the quote text, optionally followed by an attribution line
  starting with `|`. Rendered as a large-type quote plate:

  ~~~markdown
  ```quote
  The deck wrote itself before lunch.
  | Head of Platform, customer name
  ```
  ~~~

- ` ```cards ` — one card per line, `title | body`; a `1. ` prefix turns
  into a numbered badge. Grid fills left-to-right (3 per row on 13.33″
  slides):

  ~~~markdown
  ```cards
  1. Bin packing | Consolidates workloads automatically
  2. Rightsizing | Matches nodes to actual usage
  3. Spot orchestration | Checkpoints stateful work
  ```
  ~~~

- ` ```flow ` — pipeline stages, one per line or joined with `→` (at least
  two). Prefix a stage with `*` to highlight it:

  ~~~markdown
  ```flow
  Commit → *Build → Scan → Deploy
  ```
  ~~~

- ` ```code ` (or any untyped fence) — a terminal-style card: dark
  background, monospace, traffic-light dots. Good for command output and
  config snippets:

  ~~~markdown
  ```code
  $ kimchi deploy --cluster prod
  ✓ 3 nodes consolidated
  ```
  ~~~

An unknown fenced language is a typed error naming the supported types.

## Images

- Written as standard markdown: `![alt text](path/to/image.png)`.
- Local filesystem paths only; `http:`/`data:` URLs are a typed error naming
  the slide. Relative paths resolve against the content file's directory.
- The reader enforces the same safety rules as the `read` command (no
  traversal outside the project, 20 MB cap per image file).
- PNG, JPEG, GIF and SVG are supported; anything else is a typed error.

## Layouts

Each slide takes a layout hint, matched against the template's slide layouts
by name (case-insensitive, whitespace-tolerant). In `--template` mode the
hint must match exactly one layout or creation fails naming the slide.

| Hint              | Purpose                                  |
| ----------------- | ---------------------------------------- |
| `title`           | Composed lockup: kicker, big wordmark, subtitle, install card |
| `hero`            | Title face: accent tagline, terminal card, link row |
| `content`         | Title + body (default)                   |
| `two-column`      | Title + two body columns                 |
| `table`           | Title plus a full-width table            |
| `chart`           | Title plus a full-width chart            |
| `closing`         | Big statement face: 40pt heading, no footer |
| `blank`           | Freeform shapes only                     |

Hints riding the first heading: `# Q3 Review :: two-column`.

## Kicker

A fenced block with the language tag `kicker` sets a small caps accent label
above the slide's heading — the section label the eye reads first:

~~~markdown
```kicker
Platform Overview
```

# One gatekeeper for every request
~~~

First line only; the block is a slot, not a flow element.

## Themes

`--theme FILE` points at a JSON file; every field optional:

```json
{
	"font": "Aptos",
	"headingFont": "Aptos Display",
	"monoFont": "Courier New",
	"accent": "#F4572E",
	"background": "#0E0F13",
	"surface": "#181A21",
	"surface2": "#20242E",
	"text": "#ECEDEF",
	"muted": "#9BA1AB",
	"footer": "{title} · {n}",
	"slideWidth": 13.33,
	"slideHeight": 7.5
}
```

Defaults: dark-first — near-black `#0E0F13` background with derived light
text and surfaces, Calibri body, kimchi teal `#00A3A1` accent, 13.33″ × 7.5″
(16:9). Set `background` to a light value to opt out.

- A dark `background` flips the derived text/surface colors to light
  automatically — set the palette fields only to override the derived ones.
- `line` is the card/table outline color; on-brand monochrome by default.
- Charts take their series colors from the accent (monochrome ramp) —
  never an off-brand rainbow; bar charts show value labels.
- The content flow absorbs leftover slide height: design blocks stretch
  (bounded), gaps widen, and the stack centers — slides never die in the
  bottom half.
- `footer` renders small at the bottom-right of content slides (never on
  `title`/`hero`/`closing`/`blank`); `{n}` expands to the slide number,
  `{title}` to the frontmatter deck title.
- In `--template` mode the template's own theme wins and conflicting
  `--theme` fields are ignored with a warning.

## Frontmatter

Deck-level metadata in YAML frontmatter (same fences as a SKILL.md):

```markdown
---
title: Q3 Review
author: Platform Team
---
```

Both set the file's document properties; unknown keys are ignored.

## Errors

Unknown or malformed construct → a typed error naming the slide and the
line, never silently dropped content. Examples: unclosed table row, a chart
block that isn't valid JSON, an image URL scheme we don't accept.

`error [slide-overfull]`: the slide's estimated content overruns the
available region (title bar, footer, margins). Split the slide at a natural
section with `---` or thin the content — the writer refuses to shrink text
below readable sizes.
