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
| `title`           | Large title, optional subtitle           |
| `content`         | Title + body (default)                   |
| `two-column`      | Title + two body columns                 |
| `table`           | Title plus a full-width table            |
| `chart`           | Title plus a full-width chart            |
| `blank`           | Freeform shapes only                     |

Hints riding the first heading: `# Q3 Review :: two-column`.

## Themes

`--theme FILE` points at a JSON file; every field optional:

```json
{
	"font": "Aptos",
	"accent": "#00A3A1",
	"slideWidth": 13.33,
	"slideHeight": 7.5
}
```

Defaults: Calibri, kimchi teal `#00A3A1`, 13.33″ × 7.5″ (16:9). In
`--template` mode the template's own theme wins and conflicting `--theme`
fields are ignored with a warning.

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
