# Deck Design

How to make a deck that looks designed, not generated. The writer enforces
mechanics (`slide-overfull`, `check`); this file is about the judgment the
mechanics can't encode. Read it once per session before `create`.

## One idea per slide

A slide is a claim, not a container. If the title reads like a table of
contents ("Overview", "Details"), split it. If you need "and" in the title,
you probably need two slides. Dense slides fail `slide-overfull` on purpose —
splitting at a natural section is the fix, never smaller text.

## Vary the layout, deliberately

`check` flags decks where most slides are title-and-bullets. A good rhythm
over ~10 slides (kickers — small caps section labels in ` ```kicker ` fences
— carry the deck's spine from slide to slide):

- **Title slide** (`:: title`) — deck name, subtitle, nothing else.
- **Hero** (`:: hero`) — the thesis slide. Accent tagline paragraph, a
  terminal card showing the product, a link row. Use it once, near the start.
- **Stats row** (` ```stats `) — when the point is "these numbers are big",
  let the numbers be the slide.
- **Cards** (` ```cards `) — 2–4 parallel concepts (features, principles,
  workstreams). Numbered badges for sequences, plain for sets.
- **Flow** (` ```flow `) — any pipeline or lifecycle. Highlight the stage
  the narrative is standing on with `*`.
- **Quote** (` ```quote `) — one voice, one sentence, one attribution.
  Quotes are evidence; use a real one or skip it.
- **Table/Chart** (`:: table` / `:: chart`) — for actual tabular or numeric
  detail. Dollar amounts go in tables, never pie slices.

Two adjacent slides should not use the same shape. Two consecutive
bullet-only slides is the smell `check` catches.

## Contrast first, decoration never

- Dark backgrounds need light text — the writer derives light text/surfaces
  from a dark `background` automatically; don't fight it by hand-picking
  mid-grays. `check` flags dark-on-dark runs.
- One accent color, used for numbers, highlights, and the hero tagline. If
  everything is accent-colored, nothing is.
- Body text in `text`, labels/captions in `muted`. Never more than two text
  colors on one slide.
- No gradients, shadows, or clip-art. Whitespace is the decoration; an
  underfilled slide is fine, an overstuffed one is not.

## Type discipline

- Pair fonts, don't collect them: `headingFont` + `font`, plus `monoFont`
  for terminals/code. Three families is the hard ceiling.
- Headings say the takeaway ("Costs fell 38%"), not the topic ("Costs").
- Long strings of body text signal a doc, not a deck — move it to notes
  (`Notes:`) and keep the slide scannable.

## Palette recipes

Dark-first (the writer's default — light decks opt in with a light
`background`):

```json
{
	"font": "Arial", "headingFont": "Arial Black", "monoFont": "Courier New",
	"accent": "#FF521D", "background": "#0E0F13",
	"surface": "#181A21", "surface2": "#20242E",
	"text": "#ECEDEF", "muted": "#9BA1AB"
}
```

Light corporate:

```json
{
	"font": "Aptos", "accent": "#1F4E79",
	"background": "#FFFFFF", "surface": "#F3F5F8", "surface2": "#E9EDF2",
	"text": "#1A1A1A", "muted": "#5A6472"
}
```

In `--template` mode keep the org theme — set content only.

## QA loop

1. `create` → `check`. Fix every finding (split overfull slides, recolor
   low-contrast runs, break up monotony).
2. `render --out pngs/` when LibreOffice is available; Read the PNGs of the
   title slide, one dense slide, and one visual slide. You are looking for:
   text touching box edges, misaligned rows, colors that die on the bg.
3. Iterate on the markdown, never by hand-editing the .pptx — the deck file
   is a build artifact.
