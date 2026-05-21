import { describe, expect, it } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { canToggleFermentStopPolicy, formatFermentFooterDisplay, getFermentStopLabel } from "./footer-status.js"

const plainStyle = {
	dim: (text: string) => text,
	accent: (text: string) => text,
}

function makeFerment(status: FermentStatus): Ferment {
	return {
		id: `ferment-${status}`,
		name: "Checkout Rewrite",
		status,
		worktree: { path: "/tmp/project" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}
}

describe("ferment footer status", () => {
	it("hides absent and terminal ferments", () => {
		expect(formatFermentFooterDisplay(undefined, "manual", plainStyle)).toBeNull()
		expect(formatFermentFooterDisplay(makeFerment("complete"), "manual", plainStyle)).toBeNull()
		expect(formatFermentFooterDisplay(makeFerment("abandoned"), "manual", plainStyle)).toBeNull()
	})

	it("shows drafts without stop-policy controls", () => {
		const display = formatFermentFooterDisplay(makeFerment("draft"), "manual", plainStyle)

		expect(display?.text).toBe("Ferment: Checkout Rewrite · Draft")
		expect(display?.text).not.toContain("Stop:")
		expect(display?.text).not.toContain("F6")
	})

	it("labels manual policy as stopping at a phase boundary", () => {
		const display = formatFermentFooterDisplay(makeFerment("running"), "manual", plainStyle)

		expect(getFermentStopLabel("manual")).toBe("Phase Boundary")
		expect(display?.text).toBe("Ferment: Checkout Rewrite · Running · Stop: Phase Boundary → F6")
	})

	it("labels automated policy as stopping at completion", () => {
		const display = formatFermentFooterDisplay(makeFerment("paused"), "automated", plainStyle)

		expect(getFermentStopLabel("automated")).toBe("Completion")
		expect(display?.text).toBe("Ferment: Checkout Rewrite · Paused · Stop: Completion → F6")
	})

	it("allows toggling only for executable active statuses", () => {
		expect(canToggleFermentStopPolicy(makeFerment("draft"))).toBe(false)
		expect(canToggleFermentStopPolicy(makeFerment("planned"))).toBe(true)
		expect(canToggleFermentStopPolicy(makeFerment("running"))).toBe(true)
		expect(canToggleFermentStopPolicy(makeFerment("paused"))).toBe(true)
		expect(canToggleFermentStopPolicy(makeFerment("complete"))).toBe(false)
		expect(canToggleFermentStopPolicy(makeFerment("abandoned"))).toBe(false)
	})
})
