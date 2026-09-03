import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createToolVisibility, getDisabledToolNames } from "./tool-visibility.js"

type ShutdownHandler = () => void

/** Minimal synchronous event bus mirroring pi-mono's EventBus contract. */
interface MiniBus {
	emit(channel: string, data: unknown): void
	on(channel: string, handler: (data: unknown) => void): () => void
}

function createMiniBus(): MiniBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>()
	return {
		emit(channel, data) {
			for (const h of [...(handlers.get(channel) ?? [])]) h(data)
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>()
			set.add(handler)
			handlers.set(channel, set)
			return () => set.delete(handler)
		},
	}
}

type MockPi = ExtensionAPI & { active: string[]; fireShutdown: () => void }

function makePi(toolNames: string[], bus?: MiniBus): MockPi {
	const tools = toolNames.map((name) => ({ name }) as ToolInfo)
	const shutdownHandlers: ShutdownHandler[] = []
	const state = {
		active: [...toolNames],
		fireShutdown: () => {
			for (const h of shutdownHandlers) h()
		},
		getAllTools: () => tools,
		getActiveTools() {
			return state.active
		},
		setActiveTools(names: string[]) {
			state.active = names
		},
		on(event: string, handler: ShutdownHandler) {
			if (event === "session_shutdown") shutdownHandlers.push(handler)
		},
		events: bus
			? {
					emit: (channel: string, data: unknown) => bus.emit(channel, data),
					on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
				}
			: undefined,
	}
	return state as unknown as MockPi
}

describe("tool-visibility", () => {
	it("disable removes named tools from pi.getActiveTools, enable restores them", () => {
		const pi = makePi(["read", "bash", "edit"])
		const v = createToolVisibility(pi)

		v.disable(["bash"])
		expect(pi.active).toEqual(["read", "edit"])

		v.enable(["bash"])
		expect(pi.active.sort()).toEqual(["bash", "edit", "read"])
	})

	it("disable is idempotent for a handle that already hid the tool", () => {
		const pi = makePi(["read", "bash"])
		const v = createToolVisibility(pi)

		v.disable(["bash"])
		v.disable(["bash"])
		expect(pi.active).toEqual(["read"])

		v.enable(["bash"])
		expect(pi.active.sort()).toEqual(["bash", "read"])
	})

	it("enable is a no-op for names this handle never hid", () => {
		const pi = makePi(["read", "bash"])
		const v = createToolVisibility(pi)

		v.enable(["bash"])
		expect(pi.active).toEqual(["read", "bash"])
	})

	it("two handles refcount: tool stays hidden until every handle releases it", () => {
		const pi = makePi(["bash"])
		const extA = createToolVisibility(pi)
		const extB = createToolVisibility(pi)

		extA.disable(["bash"])
		extB.disable(["bash"])
		expect(pi.active).toEqual([])

		extA.enable(["bash"])
		expect(pi.active).toEqual([]) // extB still hides it

		extB.enable(["bash"])
		expect(pi.active).toEqual(["bash"])
	})

	it("one handle's enable cannot release another handle's hide", () => {
		const pi = makePi(["bash"])
		const extA = createToolVisibility(pi)
		const extB = createToolVisibility(pi)

		extA.disable(["bash"])
		extB.enable(["bash"]) // extB never hid it — no-op
		expect(pi.active).toEqual([])
	})

	it("isolates state across sessions (no shared bus)", () => {
		const piA = makePi(["bash"])
		const piB = makePi(["bash"])

		createToolVisibility(piA).disable(["bash"])

		expect(piA.active).toEqual([])
		expect(piB.active).toEqual(["bash"])
		expect(getDisabledToolNames(piB).size).toBe(0)
	})

	it("enable can broaden active beyond the baseline (reactivation from baseline inactive)", () => {
		// Registry has both tools, but bash starts excluded from the active set —
		// e.g. a peer extension narrowed it. This test documents the deliberate
		// invariant that disable+enable restores bash to active even though it
		// was never in the baseline active set.
		const pi = makePi(["read", "bash"])
		pi.active = ["read"]
		const v = createToolVisibility(pi)

		v.disable(["bash"])
		expect(pi.active).toEqual(["read"])

		v.enable(["bash"])
		expect(pi.active.sort()).toEqual(["bash", "read"])
	})

	it("two handles starting from baseline inactive: last enable restores bash", () => {
		const pi = makePi(["read", "bash"])
		pi.active = ["read"]
		const extA = createToolVisibility(pi)
		const extB = createToolVisibility(pi)

		extA.disable(["bash"])
		extB.disable(["bash"])
		expect(pi.active).toEqual(["read"])

		extA.enable(["bash"])
		expect(pi.active).toEqual(["read"]) // extB still disables it

		extB.enable(["bash"])
		expect(pi.active.sort()).toEqual(["bash", "read"])
	})

	it("after shutdown, a new handle on the same pi sees a fresh registry", () => {
		const pi = makePi(["read", "bash"])
		createToolVisibility(pi).disable(["bash"])
		expect(pi.active).toEqual(["read"])

		pi.fireShutdown()

		// Real pi-mono discards the pi entirely and creates a new one; the test
		// approximates this by resetting active to the baseline so we can
		// observe handleB's operations independently of A's prior writes.
		pi.active = ["read", "bash"]

		const handleB = createToolVisibility(pi)

		// B owns nothing — A's prior disable left no record in the registry.
		handleB.enable(["bash"])
		expect(pi.active).toEqual(["read", "bash"])

		// B can disable/enable from a clean slate.
		handleB.disable(["bash"])
		expect(pi.active).toEqual(["read"])

		handleB.enable(["bash"])
		expect(pi.active.sort()).toEqual(["bash", "read"])
	})

	it("session_shutdown drops the per-session map for that pi only", () => {
		const piA = makePi(["bash"])
		const piB = makePi(["bash"])

		createToolVisibility(piA).disable(["bash"])
		const handleB = createToolVisibility(piB)
		handleB.disable(["bash"])

		piA.fireShutdown()

		// piB's state is intact; its handle can still release normally.
		handleB.enable(["bash"])
		expect(piB.active).toEqual(["bash"])
	})

	// ------------------------------------------------------------------
	// Cross-extension votes (every extension gets its own pi; the session
	// event bus is the shared identity — see module docstring).
	// ------------------------------------------------------------------

	it("late reader sees earlier votes via sync-request (the DAP→ferment case)", () => {
		const bus = createMiniBus()
		const piDap = makePi(["read", "bash"], bus)
		const piFerment = makePi(["read", "bash"], bus)

		// DAP votes at session_start.
		createToolVisibility(piDap).disable(["bash"])

		// Ferment's applyCore reads at before_agent_start — its registry only
		// exists from this moment. The sync-request must surface DAP's vote.
		expect(getDisabledToolNames(piFerment)).toEqual(new Set(["bash"]))
	})

	it("live disable/enable deltas propagate to a peer on the same bus", () => {
		const bus = createMiniBus()
		const piA = makePi(["bash"], bus)
		const piB = makePi(["bash"], bus)
		const vA = createToolVisibility(piA)
		// Register B's registry before the vote so delivery is via delta.
		expect(getDisabledToolNames(piB)).toEqual(new Set())

		vA.disable(["bash"])
		expect(getDisabledToolNames(piB)).toEqual(new Set(["bash"]))

		vA.enable(["bash"])
		expect(getDisabledToolNames(piB)).toEqual(new Set())
	})

	it("refcounts across extensions: a peer's enable does not release another peer's vote", () => {
		const bus = createMiniBus()
		const piA = makePi(["bash"], bus)
		const piB = makePi(["bash"], bus)
		const piC = makePi(["bash"], bus)
		const vA = createToolVisibility(piA)
		const vB = createToolVisibility(piB)
		expect(getDisabledToolNames(piC)).toEqual(new Set())

		vA.disable(["bash"])
		vB.disable(["bash"])
		// One vote from each of two peers — the union reads as a single "hidden".
		expect(getDisabledToolNames(piC)).toEqual(new Set(["bash"]))

		vA.enable(["bash"])
		expect(getDisabledToolNames(piC)).toEqual(new Set(["bash"])) // B still hides

		vB.enable(["bash"])
		expect(getDisabledToolNames(piC)).toEqual(new Set())
	})

	it("a peer's enable does not re-surface a tool another peer still hides", () => {
		const bus = createMiniBus()
		const piA = makePi(["bash"], bus)
		const piB = makePi(["bash"], bus)
		const vA = createToolVisibility(piA)
		const vB = createToolVisibility(piB)

		vA.disable(["bash"])
		vB.disable(["bash"])
		expect(piA.active).toEqual([])

		vA.enable(["bash"])
		// A released its own vote but B still hides bash — A's active set must
		// not grow it back.
		expect(piA.active).toEqual([])
	})

	it("session shutdown withdraws votes from peers on the same bus", () => {
		const bus = createMiniBus()
		const piA = makePi(["bash"], bus)
		const piB = makePi(["bash"], bus)
		const vA = createToolVisibility(piA)
		expect(getDisabledToolNames(piB)).toEqual(new Set())

		vA.disable(["bash"])
		expect(getDisabledToolNames(piB)).toEqual(new Set(["bash"]))

		piA.fireShutdown()
		expect(getDisabledToolNames(piB)).toEqual(new Set())
	})
})
