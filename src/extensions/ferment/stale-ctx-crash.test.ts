import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { applyCommand } from "../../ferment/state-machine.js"
import fermentExtension from "./index.js"
import { resetAllFermentStopNudgeCounts } from "./nudge.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { clearActiveFermentId, setContinuationPolicy, writeFermentLock } from "./state.js"

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()."

describe("stale-ctx crash on ferment oneshot transition", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ferment-stale-ctx-"))
	})
	afterEach(() => {
		clearActiveFermentId()
		setContinuationPolicy("manual")
		resetAllFermentStopNudgeCounts()
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		rmSync(tmpDir, { recursive: true, force: true })
	})
	afterAll(() => {
		vi.useRealTimers()
	})

	it("does not crash when continuation sendMessage and appendEntry fire against a stale ctx", async () => {
		const handlers = new Map<string, EventHandler>()
		const sendMessage = vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE)
		})
		const appendEntry = vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE)
		})
		let activeTools = ["read", "bash", "start_ferment_step"]
		const pi = {
			on: (event: string, handler: EventHandler) => {
				if (!handlers.has(event)) handlers.set(event, handler)
			},
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerFlag: vi.fn(),
			getFlag: vi.fn((name: string) => (name === "ferment-oneshot" ? true : undefined)),
			getActiveTools: vi.fn(() => activeTools),
			getAllTools: vi.fn(() => [
				{ name: "read" },
				{ name: "bash" },
				{ name: "list_ferments" },
				{ name: "scope_ferment" },
				{ name: "activate_ferment_phase" },
				{ name: "start_ferment_step" },
			]),
			setActiveTools: vi.fn((tools: string[]) => {
				activeTools = tools
			}),
			appendEntry,
			sendMessage,
			sendUserMessage: vi.fn(),
			setModel: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
		} as unknown as ExtensionAPI

		// Create the ferment through the real event store so the lock + snapshot
		// exist, then advance it in-memory via applyCommand. The mock storage
		// returned by getStorage() always reflects the latest in-memory ferment
		// so refreshActiveFermentFromStorage sees the running/activated state.
		const realStorage = new FermentEventStore(tmpDir)
		let ferment = realStorage.create("stale-ctx repro")
		writeFermentLock(ferment.id)

		const now = new Date().toISOString()
		const scopeCmd = {
			type: "scope" as const,
			title: "stale-ctx repro",
			goal: "repro",
			successCriteria: ["c1"],
			phases: [{ name: "p", goal: "g", steps: [{ description: "s" }] }],
		}
		const scoped = applyCommand(ferment, scopeCmd, { now })
		if (!scoped.ok) throw new Error("scope failed")
		ferment = scoped.ferment

		const activateCmd = { type: "activate_phase" as const, phaseId: "phase-1" }
		const activated = applyCommand(ferment, activateCmd, { now })
		if (!activated.ok) throw new Error("activate_phase failed")
		ferment = activated.ferment

		const mockStorage = {
			get: () => ferment,
			list: () => [],
		} as unknown as FermentEventStore
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => mockStorage,
		}
		setContinuationPolicy("automated")
		runtime.setActive(ferment)

		fermentExtension(pi, runtime)

		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		// Text-only assistant turn, stopReason "stop", no tool calls. This routes
		// through maybeInjectReactiveContinuationNudge → scheduleNextFermentAction
		// → `tryPiAction(() => { pi.appendEntry(...); safeSendMessage(...) })`.
		// When appendEntry or sendMessage throw synchronously the surrounding
		// tryPiAction must catch the stale-ctx error; otherwise it propagates as
		// an uncaught rejection from the turn_end handler.
		await turnEnd(
			{
				type: "turn_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done planning" }],
					stopReason: "stop",
					usage: { totalTokens: 100 },
				},
			},
			{ isIdle: () => true },
		)

		expect(appendEntry).toHaveBeenCalled()
	})
})
