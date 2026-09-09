// Behavior tests for the Chunk 7 print-mode registration gates
// (token-optimization Phase 1). Each owning extension skips its
// interactive/ferment-only tool registrations when the gate says so; the
// gates themselves are unit-tested in print-mode.test.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { withPrintGate } from "../extensions/print-mode.js"
import { resolveMultiModelEnabled } from "./multi-model.js"
import questionnaireExtension from "./questionnaire/questionnaire.js"
import tagsExtension from "./tags.js"

vi.mock("./multi-model.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./multi-model.js")>()
	return { ...actual, resolveMultiModelEnabled: vi.fn(() => ({ value: false, source: "cli" })) }
})

/** Minimal extension API stub: factories under test only call registration
 *  methods at factory scope (handlers are captured, never fired). */
function makePi() {
	const handlers = new Map<string, unknown[]>()
	const tools: Array<{ name: string }> = []
	const pi = {
		on: (event: string, handler: unknown) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		registerTool: (tool: { name: string }) => {
			tools.push(tool)
		},
		registerCommand: vi.fn(),
		// createToolVisibility (questionnaire, non-gated path) reads these:
		events: { on: vi.fn(), emit: vi.fn() },
		getActiveTools: () => tools.map((t) => t.name),
		setActiveTools: vi.fn(),
		getFlag: () => undefined,
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI
	return { pi, handlers, tools }
}

describe("questionnaire print gate (Chunk 7)", () => {
	it("interactive run: registers the tool and the UI-visibility vote", () => {
		const { pi, handlers, tools } = makePi()
		questionnaireExtension(pi)
		expect(tools.map((t) => t.name)).toContain("questionnaire")
		expect(handlers.has("session_start")).toBe(true)
		expect(handlers.has("before_agent_start")).toBe(true)
	})

	it("print run: skips registration but keeps the autonomous-mode block", () => {
		return withPrintGate({ print: true }, async () => {
			const { pi, handlers, tools } = makePi()
			questionnaireExtension(pi)
			expect(tools.map((t) => t.name)).not.toContain("questionnaire")
			// The UI-visibility vote is gone too (no tool to hide).
			expect(handlers.has("session_start")).toBe(false)
			// …but the load-bearing headless steer must stay.
			expect(handlers.has("before_agent_start")).toBe(true)
		})
	})
})

describe("set_phase ferment-mode gate (Chunk 7)", () => {
	it("interactive run: registers set_phase", () => {
		const { pi, tools } = makePi()
		tagsExtension(pi)
		expect(tools.map((t) => t.name)).toContain("set_phase")
	})

	it("plain print run: does not register set_phase", () => {
		return withPrintGate({ print: true }, async () => {
			const { pi, tools } = makePi()
			tagsExtension(pi)
			expect(tools.map((t) => t.name)).not.toContain("set_phase")
		})
	})

	it("print + ferment-oneshot run: keeps set_phase (Chunk 7 composition)", () => {
		return withPrintGate({ print: true, fermentOneshot: true }, async () => {
			const { pi, tools } = makePi()
			tagsExtension(pi)
			expect(tools.map((t) => t.name)).toContain("set_phase")
		})
	})

	it("multi-model print run: keeps set_phase registered (orchestrator prompt needs it)", () => {
		vi.mocked(resolveMultiModelEnabled).mockReturnValue({ value: true, source: "cli" })
		try {
			return withPrintGate({ print: true }, async () => {
				const { pi, tools } = makePi()
				tagsExtension(pi)
				expect(tools.map((t) => t.name)).toContain("set_phase")
			})
		} finally {
			vi.mocked(resolveMultiModelEnabled).mockReturnValue({ value: false, source: "cli" })
		}
	})
})
