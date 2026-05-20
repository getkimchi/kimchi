import { describe, expect, it } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { TipPresenter } from "../tips/presenter.js"
import { TipRegistry } from "../tips/registry.js"
import { renderTipRow } from "../tips/tip-row.js"
import type { TipCandidate } from "../tips/types.js"
import { FERMENT_TIPS, createFermentTipProvider, getFermentTips } from "./tips.js"

const plainTheme = {
	fg: (_color: string, text: string) => text,
} as never

function makeFerment(status: FermentStatus): Ferment {
	return {
		id: `ferment-${status}`,
		name: "Test Ferment",
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

describe("Ferment tips", () => {
	it("returns state-specific ordered tips for active Ferments", () => {
		expect(getFermentTips(undefined)).toEqual([])
		expect(getFermentTips(makeFerment("draft")).map((tip) => tip.id)).toEqual([
			"continuation-policy",
			"progress-navigation",
			"switch-ferments",
		])
		expect(getFermentTips(makeFerment("planned")).map((tip) => tip.id)).toEqual([
			"continuation-policy",
			"progress-navigation",
			"switch-ferments",
		])
		expect(getFermentTips(makeFerment("running")).map((tip) => tip.id)).toEqual([
			"progress-navigation",
			"pause-resume",
			"switch-ferments",
		])
		expect(getFermentTips(makeFerment("paused")).map((tip) => tip.id)).toEqual([
			"pause-resume",
			"progress-navigation",
			"switch-ferments",
		])
		expect(getFermentTips(makeFerment("complete")).map((tip) => tip.id)).toEqual(["review-work", "progress-navigation"])
		expect(getFermentTips(makeFerment("abandoned")).map((tip) => tip.id)).toEqual(["start-ferment"])
	})

	it("covers the expected Ferment workflows with highlightable commands", () => {
		expect(Object.values(FERMENT_TIPS).map((tip) => tip.id)).toEqual([
			"continuation-policy",
			"progress-navigation",
			"switch-ferments",
			"pause-resume",
			"review-work",
			"start-ferment",
		])

		for (const tip of Object.values(FERMENT_TIPS)) {
			expect(tip.message, tip.id).toMatch(/`[^`]+`/)
		}
		expect(FERMENT_TIPS.continuationPolicy.message).toContain("/ferment manual")
	})

	it("fits every built-in Ferment tip in an 80-column row without truncation", () => {
		for (const tip of Object.values(FERMENT_TIPS)) {
			const [line] = renderTipRow({ ...tip, source: "kimchi.ferment" } as TipCandidate, plainTheme, 80)

			expect(line, tip.id).not.toContain("...")
		}
	})

	it("returns Ferment tips from the provider according to current state", () => {
		let active: Ferment | undefined
		const provider = createFermentTipProvider({ getActive: () => active })

		expect(provider.getTips()).toHaveLength(0)

		active = makeFerment("running")
		expect(provider.getTips().map((tip) => tip.id)).toEqual(["progress-navigation", "pause-resume", "switch-ferments"])

		active = makeFerment("complete")
		expect(provider.getTips().map((tip) => tip.id)).toEqual(["review-work", "progress-navigation"])

		active = makeFerment("abandoned")
		expect(provider.getTips()).toEqual([FERMENT_TIPS.startFerment])
	})

	it("shows the first Ferment tip whenever Ferment context becomes active", () => {
		let active: Ferment | undefined
		const registry = new TipRegistry()
		registry.registerProvider({
			source: "kimchi.general",
			getTips: () => [{ id: "general", scope: "general", message: "General tip." }],
		})
		registry.registerProvider(createFermentTipProvider({ getActive: () => active }))
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.general",
			scope: "general",
			id: "general",
		})

		active = makeFerment("planned")
		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.ferment",
			scope: "contextual",
			id: "continuation-policy",
		})

		active = undefined
		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.general",
			scope: "general",
			id: "general",
		})

		active = makeFerment("planned")
		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.ferment",
			scope: "contextual",
			id: "continuation-policy",
		})
	})

	it("restarts at the first relevant tip when Ferment status changes", () => {
		let active: Ferment | undefined = makeFerment("planned")
		const registry = new TipRegistry()
		registry.registerProvider(createFermentTipProvider({ getActive: () => active }))
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("continuation-policy")

		active = makeFerment("running")
		expect(presenter.getCurrentTip()?.id).toBe("progress-navigation")

		active = makeFerment("complete")
		expect(presenter.getCurrentTip()?.id).toBe("review-work")
	})

	it("falls back to a general Ferment suggestion when the active Ferment is abandoned", () => {
		let active: Ferment | undefined = makeFerment("abandoned")
		const registry = new TipRegistry()
		registry.registerProvider(createFermentTipProvider({ getActive: () => active }))
		registry.registerProvider({
			source: "kimchi.general",
			getTips: () => [{ id: "general", scope: "general", message: "General tip." }],
		})
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.ferment",
			scope: "general",
			id: "start-ferment",
		})

		active = makeFerment("running")
		expect(presenter.getCurrentTip()).toMatchObject({
			source: "kimchi.ferment",
			scope: "contextual",
			id: "progress-navigation",
		})
	})
})
