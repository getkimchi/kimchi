import { CustomMessageComponent } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import type { CustomMessage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js"
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { FINDING_SCHEMA_VERSION } from "../review-submit/store.js"
import { REVIEW_RESULT_CUSTOM_TYPE, type ReviewResultDetails, reviewResultRenderer } from "./result-message.js"

const message: CustomMessage<ReviewResultDetails> = {
	role: "custom",
	customType: REVIEW_RESULT_CUSTOM_TYPE,
	content: "",
	display: true,
	timestamp: 0,
	details: {
		branch: "feature",
		base: "HEAD",
		coverage: {
			status: "complete",
			unfinished_lenses: [],
			selected_lenses: 1,
			submitted_lenses: 1,
			failed_lenses: 0,
			cancelled_lenses: 0,
			candidate_count: 1,
			final_finding_count: 1,
			provenance_truncated_count: 0,
			findings_by_priority: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 },
		},
		findings: [
			{
				schema_version: FINDING_SCHEMA_VERSION,
				id: "critical-1",
				writer: "final",
				seq: 1,
				created_at: "2026-11-25T12:00:00Z",
				path: "very/long/directory/éxxxxx.ts",
				line: 1,
				title: "Flag bypasses authorization 🚨 認可",
				description:
					"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 長い説明文 🚨🚀 gives é combining marks and an unbroken word that must wrap safely at every width.",
				explanation:
					"Static inspection abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ confirms 長い説明文 and 🚨🚀 without losing full content where it fits.",
				priority: "P0",
				type: "security",
				suggestion:
					"Remove the unsafe export supercalifragilisticexpialidocious and retain é, é, 認可, and 🚨🚀 in the full suggestion.",
			},
		],
		summaryPath: "/private/var/folders/a-very-long-path/review/summary/final.json",
	},
}

const RENDER_WIDTHS = [...Array.from({ length: 40 }, (_, index) => index + 1), 60, 80, 120]
const FULL_CONTENT_WIDTHS = RENDER_WIDTHS.filter((width) => width > 1)

function compactText(value: string): string {
	return stripTerminalSequences(value).replace(/\s+/g, "")
}

describe("review result CustomMessageComponent", () => {
	it.each([60, 80, 100])("fits collapsed and expanded rows within width %i", (width) => {
		initTheme("kimchi")
		const component = new CustomMessageComponent(message, (_message, options, theme) =>
			reviewResultRenderer(message, options, theme),
		)
		for (const expanded of [false, true]) {
			component.setExpanded(expanded)
			const rows = component.render(width)
			expect(rows.some((row) => row.includes("Review done"))).toBe(true)
			expect(
				rows.some((row) => row.includes(expanded ? "ctrl+o to collapse details" : "ctrl+o for full details")),
			).toBe(true)
			expect(rows.map(visibleWidth).every((lineWidth) => lineWidth <= width)).toBe(true)
		}
	})

	it.each(RENDER_WIDTHS)("keeps ANSI, Unicode, and indented rows within width %i", (width) => {
		initTheme("kimchi")
		const component = new CustomMessageComponent(message, (_message, options, theme) =>
			reviewResultRenderer(message, options, theme),
		)
		for (const expanded of [false, true]) {
			component.setExpanded(expanded)
			const rows = component.render(width)
			const overflow = rows
				.map((row, index) => ({ index, width: visibleWidth(row), row }))
				.filter((row) => row.width > width)
			expect(overflow, `${expanded ? "expanded" : "collapsed"}: ${JSON.stringify(overflow.slice(0, 3))}`).toEqual([])
		}
	})

	it.each(FULL_CONTENT_WIDTHS)("retains every complete expanded field at width %i", (width) => {
		initTheme("kimchi")
		const component = new CustomMessageComponent(message, (_message, options, theme) =>
			reviewResultRenderer(message, options, theme),
		)
		component.setExpanded(true)
		const output = compactText(component.render(width).join(""))
		const details = message.details
		if (!details) throw new Error("Expected the test result details")
		const finding = details.findings[0]
		if (!finding) throw new Error("Expected the test finding")
		const fields = [
			finding.title,
			`${finding.path}:${finding.line}`,
			finding.description,
			finding.explanation,
			finding.suggestion,
		]
		for (const field of fields) expect(output).toContain(compactText(field))
	})
})
