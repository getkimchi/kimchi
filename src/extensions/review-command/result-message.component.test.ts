import { CustomMessageComponent } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
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
				path: "value.ts",
				line: 2,
				title: "Additional exported flag bypasses authorization",
				description:
					"The additional exported flag creates a critical authorization bypass because every caller now enables the privileged path without checking the current principal or preserving the previous deny-by-default behavior.",
				explanation:
					"Static inspection of the head revision confirmed that every caller enables the privileged path without an authorization check.",
				priority: "P0",
				type: "security",
				suggestion:
					"Remove the unsafe export, restore deny-by-default authorization, and add a regression test proving an unauthenticated principal cannot enter the privileged path.",
			},
		],
		summaryPath: "/private/var/folders/a-very-long-path/review/summary/final.json",
	},
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
})
