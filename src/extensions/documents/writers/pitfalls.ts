/**
 * Pitfalls as code: every pptxgenjs foot-gun we've met (or that its issue
 * tracker documents) gets a guard here, and every guard has a fixture in
 * writers/pitfalls.test.ts that corrupts or repairs the file without it.
 * The writer calls each guard against the normalized DeckSpec before it
 * touches pptxgenjs, so these rules run in tests, in the CLI, and — later —
 * inside create_document.
 */

import { estimateOverflow } from "./pptx-layout.js"
import type { DeckTheme, SlideSpec } from "./pptx-model.js"

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

/** Overfull slides: the writer's flow allocator uses the same estimator —
 * content that cannot fit would render past the slide. Refuse with the
 * measured numbers and the fix (split), so overflow can never ship silently.
 * Built per-theme because region heights depend on slide size and footer. */
const slideOverfull = (theme: DeckTheme): Pitfall => ({
	id: "slide-overfull",
	why: "estimated content height exceeds the content region; the slide must be split or trimmed",
	check: (slide) => {
		const over = estimateOverflow(slide, theme)
		if (over > 0.15) {
			throw new Error(
				`slide-overfull: slide "${slide.heading ?? "(untitled)"}" overruns the content region by ~${over.toFixed(2)}" — split it into two slides or thin the content`,
			)
		}
	},
})

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

export const PPTX_WRITING_PITFALLS: readonly Pitfall[] = [
	CHART_VALUES_MUST_BE_NUMERIC,
	CHART_NEEDS_SERIES,
	TABLE_NEEDS_ROWS,
]

/** Run every guard against every slide. */
export function enforcePitfalls(slides: SlideSpec[], theme: DeckTheme = {}): void {
	const rules = [...PPTX_WRITING_PITFALLS, slideOverfull(theme)]
	for (const slide of slides) {
		for (const rule of rules) rule.check(slide)
	}
}
