import { describe, expect, it } from "vitest"
import { TipPresenter } from "./presenter.js"
import { TipRegistry } from "./registry.js"
import type { TipProvider } from "./types.js"

function provider(
	source: string,
	tips: readonly { id: string; message?: string }[],
	scope: "general" | "contextual" = "general",
) {
	return {
		source,
		getTips: () => tips.map((tip) => ({ id: tip.id, scope, message: tip.message ?? tip.id })),
	} satisfies TipProvider
}

describe("TipPresenter", () => {
	function immediateRotationPresenter(registry: TipRegistry): TipPresenter {
		return new TipPresenter(registry, { minCompletedTurnsVisible: 1, minVisibleMs: 0 })
	}

	it("prefers contextual tips and resumes general tips when contextual tips disappear", () => {
		const registry = new TipRegistry()
		let contextualActive = false
		registry.registerProvider(provider("general", [{ id: "general" }]))
		registry.registerProvider({
			source: "contextual",
			getTips: () => (contextualActive ? [{ id: "contextual", scope: "contextual", message: "contextual" }] : []),
		})
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("general")

		contextualActive = true
		expect(presenter.getCurrentTip()?.id).toBe("contextual")

		contextualActive = false
		expect(presenter.getCurrentTip()?.id).toBe("general")
	})

	it("keeps the current tip stable until three turns and one minute have elapsed", () => {
		const registry = new TipRegistry()
		registry.registerProvider(provider("general", [{ id: "first" }, { id: "second" }]))
		let now = 0
		const presenter = new TipPresenter(registry, { now: () => now })

		expect(presenter.getCurrentTip()?.id).toBe("first")
		expect(presenter.getCurrentTip()?.id).toBe("first")

		expect(presenter.onTurnEnd()?.id).toBe("first")
		expect(presenter.onTurnEnd()?.id).toBe("first")
		expect(presenter.onTurnEnd()?.id).toBe("first")

		now = 60_000
		expect(presenter.onTurnEnd()?.id).toBe("second")
		expect(presenter.getCurrentTip()?.id).toBe("second")
	})

	it("does not rotate after one minute until the tip has been visible for three completed turns", () => {
		const registry = new TipRegistry()
		registry.registerProvider(provider("general", [{ id: "first" }, { id: "second" }]))
		let now = 0
		const presenter = new TipPresenter(registry, { now: () => now })

		expect(presenter.getCurrentTip()?.id).toBe("first")

		now = 60_000
		expect(presenter.onTurnEnd()?.id).toBe("first")
		expect(presenter.onTurnEnd()?.id).toBe("first")
		expect(presenter.onTurnEnd()?.id).toBe("second")
	})

	it("refreshes current tip content from provider state without rotating", () => {
		const registry = new TipRegistry()
		let message = "first message"
		registry.registerProvider({
			source: "general",
			getTips: () => [
				{ id: "stable", scope: "general", message },
				{ id: "next", scope: "general", message: "next message" },
			],
		})
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.message).toBe("first message")

		message = "updated message"

		expect(presenter.getCurrentTip()).toMatchObject({ id: "stable", message: "updated message" })
	})

	it("rotates fairly by provider, then by tip within each provider", () => {
		const registry = new TipRegistry()
		registry.registerProvider(provider("alpha", [{ id: "a1" }, { id: "a2" }]))
		registry.registerProvider(provider("beta", [{ id: "b1" }]))
		const presenter = immediateRotationPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("a1")
		expect(presenter.onTurnEnd()?.id).toBe("b1")
		expect(presenter.onTurnEnd()?.id).toBe("a2")
		expect(presenter.onTurnEnd()?.id).toBe("b1")
		expect(presenter.onTurnEnd()?.id).toBe("a1")
	})

	it("moves to the next eligible provider after unregistering the current provider", () => {
		const registry = new TipRegistry()
		const unregisterAlpha = registry.registerProvider(provider("alpha", [{ id: "a1" }]))
		registry.registerProvider(provider("beta", [{ id: "b1" }]))
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("a1")

		unregisterAlpha()

		expect(presenter.getCurrentTip()?.id).toBe("b1")
	})

	it("restarts a provider's tip order when its context becomes active again", () => {
		const registry = new TipRegistry()
		let contextualActive = false
		registry.registerProvider(provider("general", [{ id: "general" }]))
		registry.registerProvider({
			source: "contextual",
			getTips: () =>
				contextualActive
					? [
							{ id: "first", scope: "contextual", message: "first" },
							{ id: "second", scope: "contextual", message: "second" },
						]
					: [],
		})
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("general")

		contextualActive = true

		expect(presenter.getCurrentTip()?.id).toBe("first")

		contextualActive = false
		expect(presenter.getCurrentTip()?.id).toBe("general")

		contextualActive = true
		expect(presenter.getCurrentTip()?.id).toBe("first")
	})

	it("skips providers that throw while computing tips", () => {
		const registry = new TipRegistry()
		registry.registerProvider({
			source: "broken",
			getTips: () => {
				throw new Error("broken provider")
			},
		})
		registry.registerProvider(provider("general", [{ id: "general" }]))
		const presenter = new TipPresenter(registry)

		expect(presenter.getCurrentTip()?.id).toBe("general")
	})
})
