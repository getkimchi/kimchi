import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { runScopingFlow } from "./scoping.js"

function createRuntime(): { runtime: FermentRuntime; storage: FermentEventStore } {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-scoping-flow-test-")))
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
	}
	return { runtime, storage }
}

function makePi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
}

function makeCtx(inputResponses: (string | undefined)[]): ExtensionCommandContext {
	const inputMock = vi.fn()
	for (const response of inputResponses) {
		inputMock.mockResolvedValueOnce(response)
	}
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			input: inputMock,
		},
	} as unknown as ExtensionCommandContext
}

describe("attachPendingProposal", () => {
	it("replaces pending buffer wholesale — omitted fields become undefined", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Test")
		// Seed a full buffer
		runtime.setPendingScope(ferment.id, {
			goal: "old goal",
			successCriteria: "old criteria",
			constraints: ["old constraint"],
			assumptions: "old assumption",
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		// Replace with only goal+phases; other fields should be cleared
		const replaced = runtime.attachPendingProposal(ferment.id, {
			title: "New Title",
			goal: "new goal",
			phases: [{ name: "P2", goal: "Ship", steps: [{ description: "Deploy" }] }],
		})

		expect(replaced).toBe(true)
		const pending = runtime.getPendingScope(ferment.id)
		expect(pending?.title).toBe("New Title")
		expect(pending?.goal).toBe("new goal")
		expect(pending?.successCriteria).toBe("")
		expect(pending?.constraints).toEqual([])
		expect(pending?.assumptions).toBeUndefined()
		expect(pending?.phases?.[0]?.name).toBe("P2")
	})

	it("returns false when no pending scope exists for the ferment", () => {
		const { runtime } = createRuntime()
		const result = runtime.attachPendingProposal("nonexistent-id", { goal: "g" })
		expect(result).toBe(false)
	})
})

describe("runScopingFlow", () => {
	it("single non-empty input → markScopingInteractive called + sendMessage fired with intent embedded in content", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx(["I want to build a login system"])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).toHaveBeenCalledWith(ferment.id)
		// Now sends 3 messages: breadcrumb + request + nudge
		expect(pi.sendMessage).toHaveBeenCalledTimes(3)
		const requestCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_request")
		expect(requestCall?.[0]).toMatchObject({
			customType: "ferment_request",
			display: true,
			details: { intent: "I want to build a login system" },
		})
		const nudgeCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_created_nudge")
		const msg = nudgeCall?.[0] as { content: { type: string; text: string }[] }
		const text = msg.content.map((c) => c.text).join("")
		expect(text).toContain("Task:\nDraft a complete Ferment scoping proposal.")
		expect(text).toContain("Context:")
		expect(text).toContain("I want to build a login system")
		expect(text).toContain(`ferment_id "${ferment.id}"`)
		expect(text).toContain("Do NOT call create_ferment")
		expect(text).toContain('<phase_0_inventory required="true"')
		expect(text).toContain(
			"First response action: print a concise inventory of all available skills and subagent types",
		)
		expect(text).toContain('<discovery_sequence required="true">')
		expect(text).toContain("Do not use unbounded Read calls")
		expect(text).toContain("first get the file's line count or tool-reported length")
		expect(text).toContain("read at most a short snippet, about 60 lines or less")
		expect(text).toContain("Only read an implementation/UI/style file end-to-end")
		expect(text).toContain("If a file is longer than about 120 lines")
		expect(text).toContain("Immediately spawn 1-4 narrow Explore subagents")
		expect(text).toContain('subagent_type: "Explore"')
		expect(text).toContain("start with token_budget: 120000")
		expect(text).toContain('Do not "round out the initial scan"')
		expect(text).toContain("Forbidden pattern: reading entire implementation, UI, or style files")
		expect(text).toContain("Question policy:")
		expect(text).toContain("Planning policy:")
		expect(text).toContain("Output contract:")
		expect(text).toContain("title is required")
		expect(text).toContain("ask those questions through the propose_ferment_scoping questions array")
		expect(text).toContain("questions must be in propose_ferment_scoping.questions")
		expect(text).toContain("gates array is required")
		expect(text).toContain("exactly P1, P2, and P3")
		expect(text).not.toContain("Don't research with file/bash tools first")
		expect(text).toContain("Call propose_ferment_scoping")
	})

	it("prefers ctx.ui.editor for the free-form scoping prompt", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValue("I want to build reports\nwith export tests"),
			input: vi.fn().mockResolvedValue("single-line fallback"),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(ui.editor).toHaveBeenCalledWith("What do you want to do?\nDescribe what you want to accomplish…", "")
		expect(ui.input).not.toHaveBeenCalled()
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				details: { intent: "I want to build reports\nwith export tests" },
			}),
		)
	})

	it("undefined input (Esc) → no sendMessage, no markScopingInteractive, no pendingScope", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([undefined])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(runtime.getPendingScope(ferment.id)).toBeUndefined()
	})

	it("empty string input → no sendMessage, no markScopingInteractive (rejected pre-LLM)", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([""])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("headless (no ctx.ui.input) → falls through to existing nudge path (sendMessage fired)", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		// Headless: ctx with no input function
		const ctx = {
			hasUI: false,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("pre-captured intent → does NOT call ctx.ui.input and proceeds directly to sendMessage", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([])
		// biome-ignore lint/style/noNonNullAssertion: makeCtx always populates ctx.ui.input
		const inputSpy = vi.mocked(ctx.ui.input!)

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime, "Pre-captured intent text")

		expect(inputSpy).not.toHaveBeenCalled()
		expect(markSpy).toHaveBeenCalledWith(ferment.id)
		// Now sends 2 messages: breadcrumb + nudge
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
		expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customType: "ferment_request" }))
		const nudgeCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_created_nudge")
		const msg = nudgeCall?.[0] as { content: { type: string; text: string }[] }
		const text = msg.content.map((c) => c.text).join("")
		expect(text).toContain("Pre-captured intent text")
	})
})
