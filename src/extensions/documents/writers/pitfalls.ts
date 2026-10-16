/**
 * Pitfalls as code: every pptxgenjs foot-gun we've met (or that its issue
 * tracker documents) gets a guard here, and every guard has a fixture in
 * writers/pitfalls.test.ts that corrupts or repairs the file without it.
 * The writer calls each guard against the normalized DeckSpec before it
 * touches pptxgenjs, so these rules run in tests, in the CLI, and — later —
 * inside create_document.
 */

import type { SlideSpec } from "./pptx-model.js"

export interface Pitfall {
	/** Stable id, named in error messages and tests. */
	id: string
	/** Human description of what goes wrong when the rule is violated. */
	why: string
	/** Throws with `${id}: …` on violation. */
	check: (slide: SlideSpec) => void
}

/** Charts: pptxgenjs silently writes non-numeric values into chart XML,
 * which Excel marks repaired. Reject anything but finite numbers. */
const CHART_VALUES_MUST_BE_NUMERIC: Pitfall = {
	id: "chart-values-must-be-numeric",
	why: "non-numeric chart values produce a chart PowerPoint repairs",
	check: (slide) => {
		for (const el of slide.elements) {
			if (el.type !== "chart") continue
			for (const series of el.spec.series) {
				for (const value of series.values) {
					if (!Number.isFinite(value)) {
						throw new Error(`chart-values-must-be-numeric: ${JSON.stringify(value)} in series "${series.name}"`)
					}
				}
			}
		}
	},
}

/** Charts: an empty series array produces a chart part without series
 * references, which PowerPoint repairs away. */
const CHART_NEEDS_SERIES: Pitfall = {
	id: "chart-needs-series",
	why: "a chart without series XML is repaired away by PowerPoint",
	check: (slide) => {
		for (const el of slide.elements) {
			if (el.type === "chart") {
				if (el.spec.series.length === 0 || el.spec.labels.length === 0) {
					throw new Error(`chart-needs-series: chart on "${slide.heading ?? "(untitled)"}" has no series or labels`)
				}
				for (const [si, series] of el.spec.series.entries()) {
					if (series.values.length !== el.spec.labels.length) {
						const who = series.name === undefined ? `series ${si + 1}` : `series "${series.name}"`
						throw new Error(
							`chart-needs-series: ${who} has ${series.values.length} values for ${el.spec.labels.length} labels`,
						)
					}
				}
			}
		}
	},
}

/** Two-column: pptxgenjsLays both text arrays vertically unless the writer
 * splits them into two addText calls — model-level, no silent "both columns
 * stacked" decks. The rule: a slide may not carry two body blocks unless the
 * hint is two-column. */
const TWO_COLUMN_NEEDS_HINT: Pitfall = {
	id: "two-column-needs-hint",
	why: "without the two-column hint two body blocks stack vertically",
	check: (slide) => {
		const bodies = slide.elements.filter((e) => e.type === "bullets" || e.type === "paragraphs")
		if (bodies.length > 1 && slide.layoutHint !== "two-column") {
			throw new Error(
				`two-column-needs-hint: slide "${slide.heading ?? "(untitled)"}" has ${bodies.length} body blocks but no two-column hint`,
			)
		}
	},
}

/** Tables: pptxgenjs requires `options.tableStyle` internally consistent —
 * degenerate empty tables (header-only) render as a lone row PowerPoint
 * users can't distinguish; refuse to create them. */
const TABLE_NEEDS_ROWS: Pitfall = {
	id: "table-needs-rows",
	why: "a header-only table reads as broken in PowerPoint",
	check: (slide) => {
		for (const el of slide.elements) {
			if (el.type === "table" && el.rows.length === 0) {
				throw new Error(`table-needs-rows: slide "${slide.heading ?? "(untitled)"}" table has no data rows`)
			}
		}
	},
}

/** Dark backgrounds: pptxgenjs leaves text color untouched — default dark
 * text on a dark slide. The rule acts at model level: when a slide sets a
 * background below luminance 0.35, every block without an explicit color
 * gets one assigned by the writer (documented here so tests can pin it). */
export const DARK_BG_LIGHT_TEXT_LUMINANCE = 0.35

export function slideNeedsLightText(background: string | undefined): boolean {
	if (!background) return false
	const hex = background.replace("#", "")
	if (hex.length !== 6) return false
	const r = Number.parseInt(hex.slice(0, 2), 16) / 255
	const g = Number.parseInt(hex.slice(2, 4), 16) / 255
	const b = Number.parseInt(hex.slice(4, 6), 16) / 255
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < DARK_BG_LIGHT_TEXT_LUMINANCE
}

export const PPTX_WRITING_PITFALLS: readonly Pitfall[] = [
	CHART_VALUES_MUST_BE_NUMERIC,
	CHART_NEEDS_SERIES,
	TWO_COLUMN_NEEDS_HINT,
	TABLE_NEEDS_ROWS,
]

/** Run every guard against every slide. */
export function enforcePitfalls(slides: SlideSpec[]): void {
	for (const slide of slides) {
		for (const rule of PPTX_WRITING_PITFALLS) rule.check(slide)
	}
}
