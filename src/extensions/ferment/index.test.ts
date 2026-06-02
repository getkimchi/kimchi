import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { FermentStorage, clearFermentCache } from "../../ferment/store.js"
import type { Ferment } from "../../ferment/types.js"
import { globalTipRegistry } from "../tips/registry.js"
import fermentExtension from "./index.js"
import { resetAllReactiveContinuationNudgeCounts } from "./nudge.js"
import { clearAllPendingPlanReviews, getPendingPlanReview, setPendingPlanReview } from "./plan-review.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import {
	clearActiveFermentId,
	getActive,
	getActiveFermentId,
	isAutomatedContinuationEnabled,
	setActive,
	setContinuationPolicy,
} from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { completeFerment, scopeFerment } from "./tools/lifecycle.js"

const requestSharedFooterRenderMock = vi.hoisted(() => vi.fn())

vi.mock("../shared-footer.js", () => ({
	requestSharedFooterRender: requestSharedFooterRenderMock,
}))

// Stub the journey-grade judge so completeFerment doesn't try to call a real
// Opus endpoint during tests. Returns a clean A by default.
vi.mock("./judge.js", async () => {
	const actual = await vi.importActual<typeof import("./judge.js")>("./judge.js")
	return {
		...actual,
		judgeJourneyGrade: vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean delivery; gates substantiated.",
		})),
	}
})

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown
type CommandHandler = (args: string, ctx: unknown) => Promise<unknown> | unknown
type ShortcutHandler = (ctx: unknown) => Promise<unknown> | unknown

function registerFermentExtension(runtime?: FermentRuntime, flagValues: Record<string, boolean | string> = {}) {
	const handlers = new Map<string, EventHandler>()
	const allHandlers = new Map<string, EventHandler[]>()
	const commands = new Map<string, CommandHandler>()
	const shortcuts = new Map<string, { description?: string; handler: ShortcutHandler }>()
	const registeredFlags = new Set<string>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			// `handlers` keeps the first registration per event for tests that fetch a
			// known handler (e.g. ferment's session_start). `allHandlers` keeps every
			// registration so the test fixture mirrors pi-mono's broadcast behavior.
			if (!handlers.has(event)) handlers.set(event, handler)
			const list = allHandlers.get(event) ?? []
			list.push(handler)
			allHandlers.set(event, list)
		},
		registerCommand: (name: string, command: { handler: CommandHandler }) => {
			commands.set(name, command.handler)
		},
		registerShortcut: (shortcut: string, options: { description?: string; handler: ShortcutHandler }) => {
			shortcuts.set(shortcut, options)
		},
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerFlag: vi.fn((name: string) => {
			registeredFlags.add(name)
		}),
		getFlag: vi.fn((name: string) => (registeredFlags.has(name) ? flagValues[name] : undefined)),
		getActiveTools: vi.fn(() => ["read", "bash", "start_ferment_step"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "start_ferment_step" }]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI

	fermentExtension(pi, runtime)
	return { commands, handlers, pi, shortcuts }
}

afterEach(() => {
	setActive(undefined)
	setContinuationPolicy("manual")
	globalTipRegistry.clear()
	clearAllPendingPlanReviews()
	requestSharedFooterRenderMock.mockClear()
	resetAllReactiveContinuationNudgeCounts()
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	vi.unstubAllEnvs()
	clearActiveFermentId()
	clearFermentCache()
	const storage = new FermentStorage()
	for (const item of storage.list()) {
		storage.delete(item.id)
	}
})

function makeActiveFerment(status: Ferment["status"]): Ferment {
	return {
		id: `shortcut-${status}`,
		name: "Shortcut Ferment",
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

describe("fermentExtension tips", () => {
	it("registers a contextual provider backed by the active Ferment state", () => {
		globalTipRegistry.clear()

		registerFermentExtension()

		const provider = globalTipRegistry.getProviders().find((candidate) => candidate.source === "kimchi.ferment")
		expect(provider).toBeDefined()
		expect(provider?.getTips()).toHaveLength(0)

		setActive(makeActiveFerment("running"))

		expect(provider?.getTips().map((tip) => tip.id)).toContain("progress-navigation")
	})
})

describe("fermentExtension stop-policy shortcut", () => {
	it("registers f6 for toggling the active ferment stop policy", () => {
		const { shortcuts } = registerFermentExtension()

		expect(shortcuts.get("f6")).toEqual(expect.objectContaining({ description: "Toggle Ferment stop policy" }))
	})

	it("toggles manual and automated policies for active executable ferments without notifying", async () => {
		const { shortcuts } = registerFermentExtension()
		const shortcut = shortcuts.get("f6")
		if (!shortcut) throw new Error("f6 shortcut was not registered")
		const notify = vi.fn()

		setActive(makeActiveFerment("running"))
		setContinuationPolicy("manual")

		await shortcut.handler({ hasUI: true, ui: { notify } })
		expect(isAutomatedContinuationEnabled()).toBe(true)
		expect(notify).not.toHaveBeenCalled()
		expect(requestSharedFooterRenderMock).toHaveBeenCalledTimes(1)

		await shortcut.handler({ hasUI: true, ui: { notify } })
		expect(isAutomatedContinuationEnabled()).toBe(false)
		expect(notify).not.toHaveBeenCalled()
		expect(requestSharedFooterRenderMock).toHaveBeenCalledTimes(2)
	})

	it("allows toggling while the active ferment is paused", async () => {
		const { shortcuts } = registerFermentExtension()
		const shortcut = shortcuts.get("f6")
		if (!shortcut) throw new Error("f6 shortcut was not registered")

		setActive(makeActiveFerment("paused"))
		setContinuationPolicy("manual")

		await shortcut.handler({ hasUI: true, ui: { notify: vi.fn() } })

		expect(isAutomatedContinuationEnabled()).toBe(true)
		expect(requestSharedFooterRenderMock).toHaveBeenCalledTimes(1)
	})

	it("silently no-ops when no executable ferment is active", async () => {
		const { shortcuts } = registerFermentExtension()
		const shortcut = shortcuts.get("f6")
		if (!shortcut) throw new Error("f6 shortcut was not registered")

		await shortcut.handler({ hasUI: true, ui: { notify: vi.fn() } })
		setActive(makeActiveFerment("draft"))
		await shortcut.handler({ hasUI: true, ui: { notify: vi.fn() } })

		expect(isAutomatedContinuationEnabled()).toBe(false)
		expect(requestSharedFooterRenderMock).not.toHaveBeenCalled()
	})
})

describe("fermentExtension session resume", () => {
	it("clears stale active ferment env when resume id no longer exists", async () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "missing-ferment-id")
		const { handlers } = registerFermentExtension()
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(getActive()).toBeUndefined()
		expect(getActiveFermentId()).toBeUndefined()
	})

	it("does not send continuation nudges or active references for completed ferments", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-terminal-resume-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Completed Resume")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completedPhase = applyAndPersist(draft.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completedPhase.ok) throw new Error(completedPhase.error.message)
		const completed = await completeFerment(runtime, {
			ferment_id: draft.id,
			final_summary: "done",
			gates: [
				{ id: "C1", verdict: "pass", rationale: "ok", evidence: "n/a" },
				{ id: "C2", verdict: "pass", rationale: "ok", evidence: "n/a" },
				{ id: "C3", verdict: "pass", rationale: "ok", evidence: "n/a" },
			],
		})
		if ("isError" in completed && completed.isError) throw new Error(completed.content[0].text)

		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", draft.id)
		const { handlers, pi } = registerFermentExtension(runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(storage.get(draft.id)?.status).toBe("complete")
		expect(getActiveFermentId()).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining("Resumed ferment") }),
		)
	})
})

describe("fermentExtension one-shot bootstrap", () => {
	it("creates an automated one-shot ferment and rewrites the initial message into a nudge", async () => {
		const { handlers, pi } = registerFermentExtension(undefined, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(pi.registerFlag).toHaveBeenCalledWith("ferment-oneshot", expect.objectContaining({ type: "boolean" }))
		expect(getActive()).toBeUndefined()
		expect(isAutomatedContinuationEnabled()).toBe(true)

		const intent = "Add a CSV export endpoint that streams the orders table"
		const result = (await input({ type: "input", text: intent, source: "interactive" }, {})) as
			| { action: "transform"; text: string }
			| undefined

		const created = getActive()
		expect(created).toBeDefined()
		expect(created?.description).toBe(intent)

		expect(result?.action).toBe("transform")
		expect(result?.text).toContain("one-shot ferment")
		expect(result?.text).toContain(intent)
		expect(result?.text).toContain(created?.id ?? "")
		expect(result?.text).toContain("After complete_ferment returns")

		// Bootstrap is a one-shot — a second input must pass through untouched.
		const next = await input({ type: "input", text: "follow-up", source: "interactive" }, {})
		expect(next).toBeUndefined()

		// Side-effects: ack message sent + ferment_reference entry recorded.
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_ack" }),
			expect.anything(),
		)
	})

	it("records a diagnostic when one-shot bootstrap fails", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: vi.fn(() => {
				throw new Error("storage unavailable")
			}),
		}
		const { handlers, pi } = registerFermentExtension(runtime, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })
		const result = await input({ type: "input", text: "Fix the task", source: "interactive" }, {})

		expect(result).toBeUndefined()
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_oneshot_failed",
				details: expect.objectContaining({ text: expect.stringContaining("storage unavailable") }),
			}),
			expect.anything(),
		)
	})

	it("prefers active-ferment resume over the one-shot flag", async () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "missing-id")
		const { handlers } = registerFermentExtension(undefined, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(getActiveFermentId()).toBeUndefined()

		// And the input handler does NOT bootstrap a ferment for the next message.
		const result = await input({ type: "input", text: "first message", source: "interactive" }, {})
		expect(result).toBeUndefined()
		expect(getActive()).toBeUndefined()
	})

	it("skips bootstrap inside a subagent process", async () => {
		process.env.KIMCHI_SUBAGENT = "1"
		const { handlers } = registerFermentExtension(undefined, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })

		// Subagent short-circuits session_start, so the input handler will not
		// perform a bootstrap (pendingOneshot stays false).
		const result = await input({ type: "input", text: "anything", source: "interactive" }, {})
		expect(result).toBeUndefined()
		expect(getActive()).toBeUndefined()
	})
})

describe("/ferment command", () => {
	it('strips the new subcommand from /ferment new "Title"', async () => {
		const { commands } = registerFermentExtension()
		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		const title = `Rewrite login ${randomUUID()}`

		await fermentCommand(`new "${title}"`, { hasUI: false, ui: { notify: vi.fn() } })

		const created = getActive()
		expect(created?.name).toBe(title)
		expect(created?.description).toBe(title)
	})

	it("uses injected runtime storage for headless new and scoping nudge", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { commands, pi } = registerFermentExtension(runtime)
		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		const title = `Injected runtime ${randomUUID()}`

		await fermentCommand(`new "${title}"`, { hasUI: false, ui: { notify: vi.fn() } })

		const created = storage.list().find((f) => f.name === title)
		expect(created).toBeDefined()
		expect(runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(getActive()?.name).not.toBe(title)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("Scope:") })],
			}),
			{ triggerTurn: true },
		)
	})
})

function makeActivePlanFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

describe("fermentExtension question dropdown", () => {
	it("reactively nudges automated ferments after a text-only assistant turn regardless of legacy mode", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-reactive-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setContinuationPolicy("automated")
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Reactive Turn")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		setActive(scoped.ferment)
		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I am waiting." }],
				},
			},
			{},
		)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: "activate_ferment_phase: activate the first planned phase" })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("reactively nudges automated ferments across a completed phase boundary", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-boundary-nudge-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setContinuationPolicy("automated")
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Boundary Turn")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(draft.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)
		setActive(completed.ferment)
		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Phase 1 is done." }],
				},
			},
			{},
		)

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: "activate_ferment_phase: activate the first planned phase" })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("does not reactively nudge from subagent processes", async () => {
		process.env.KIMCHI_SUBAGENT = "1"
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-subagent-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Subagent Turn")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		setActive(scoped.ferment)
		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I am waiting." }],
				},
			},
			{},
		)

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("does not create a post-completion nudge after completeFerment", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-complete-nudge-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Completed Turn")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completedPhase = applyAndPersist(draft.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completedPhase.ok) throw new Error(completedPhase.error.message)
		setActive(completedPhase.ferment)

		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		await completeFerment(runtime, {
			ferment_id: draft.id,
			final_summary: "done",
			gates: [
				{ id: "C1", verdict: "pass", rationale: "ok", evidence: "n/a" },
				{ id: "C2", verdict: "pass", rationale: "ok", evidence: "n/a" },
				{ id: "C3", verdict: "pass", rationale: "ok", evidence: "n/a" },
			],
		})

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
				},
			},
			{},
		)

		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("intercepts contextual option lists even when the message ends with an option", async () => {
		setActive(makeActivePlanFerment())
		const { handlers, pi } = registerFermentExtension()
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Skip"),
				input: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: `What should we do?
1) Retry
2) Skip`,
						},
					],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalledWith("What should we do?", ["Retry", "Skip", "Let me say something else"])
		expect(pi.sendUserMessage).toHaveBeenCalledWith("Skip", { deliverAs: "followUp" })
	})

	it("passes through a running-state contextual option named like the default confirmation", async () => {
		setActive(makeActivePlanFerment())
		const { handlers, pi } = registerFermentExtension()
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Yes, proceed"),
				input: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: `What should we do?
1) Yes, proceed
2) Pause`,
						},
					],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalledWith("What should we do?", [
			"Yes, proceed",
			"Pause",
			"Let me say something else",
		])
		expect(pi.sendUserMessage).toHaveBeenCalledWith("Yes, proceed", { deliverAs: "followUp" })
	})

	it("uses a ferment-specific prompt at manual phase boundaries and stops without follow-up", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-manual-boundary-stop-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setContinuationPolicy("manual")
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Manual Boundary")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(draft.id, { type: "complete_phase", phaseId: "phase-1", summary: "done" })
		if (!completed.ok) throw new Error(completed.error.message)
		setActive(completed.ferment)

		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Pause here"),
				input: vi.fn(),
				notify: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Ready for Phase 2?" }],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalledWith("Ready for Phase 2?", ["Continue to next phase", "Pause here"])
		expect(pi.sendUserMessage).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
		expect(storage.get(draft.id)?.status).toBe("paused")
	})

	it("keeps automated ferments on the contextual question path when user input is needed", async () => {
		setActive(makeActivePlanFerment())
		const runtime = createDefaultFermentRuntime()
		runtime.setContinuationPolicy("automated")
		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Pause"),
				input: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: `What should we do?
1) Continue
2) Pause`,
						},
					],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalledWith("What should we do?", ["Continue", "Pause", "Let me say something else"])
		expect(pi.sendUserMessage).toHaveBeenCalledWith("Pause", { deliverAs: "followUp" })
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("does not send a hidden continuation nudge when scopeFerment succeeds under automated policy", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-handoff-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setContinuationPolicy("automated")
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Plan Handoff")
		setActive(draft)
		const { pi } = registerFermentExtension(runtime)

		// Drive scopeFerment directly; scoping must not enqueue a hidden continuation nudge.
		await scopeFerment(
			runtime,
			{
				ferment_id: draft.id,
				title: "Plan Handoff",
				goal: "Goal",
				success_criteria: ["Works"],
				constraints: [],
				phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
				gates: [
					{ id: "P1", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "P2", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "P3", verdict: "pass", rationale: "ok", evidence: "n/a" },
				],
			},
			{ pi },
		)

		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("turn_end no longer emits hidden scoping nudges for planned ferments", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-planned-turn-end-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("No Nudge From Turn End")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		// Manual policy confirms turn_end does NOT nudge planned ferments.
		setActive(scoped.ferment)
		const { handlers, pi } = registerFermentExtension(runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const ctx = { ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() } }

		// Fire a text-only turn — in the old code this triggered the nudge loop.
		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Plan saved." }],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("opens pending plan review after agent_end macrotask and starts execution", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-start-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			runtime.setContinuationPolicy("automated")
			const draft = storage.create("Deferred Review")
			runtime.setActive(draft)
			runtime.setPendingScope(draft.id, {
				goal: "Goal",
				successCriteria: ["Works"],
				constraints: [],
				phases: [{ name: "Phase", goal: "Build", steps: [] }],
			})
			setPendingPlanReview({
				fermentId: draft.id,
				planMarkdown: "# Plan: Deferred Review",
			})

			const { handlers, pi } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "start" }),
					notify: vi.fn(),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			expect(ctx.ui.custom).not.toHaveBeenCalled()

			await vi.runOnlyPendingTimersAsync()

			expect(ctx.ui.custom).toHaveBeenCalled()
			expect(storage.get(draft.id)?.status).toBe("planned")
			expect(getPendingPlanReview(draft.id)).toBeUndefined()
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "ferment_continuation_nudge", display: false }),
				expect.objectContaining({ triggerTurn: true, deliverAs: "followUp" }),
			)
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					content: [
						expect.objectContaining({
							text: expect.stringContaining(
								`Call activate_ferment_phase with ferment_id "${draft.id}" and phase_id "phase-1"`,
							),
						}),
					],
				}),
				expect.anything(),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("starts pending plan review in automated policy when auto option is selected", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-auto-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			runtime.setContinuationPolicy("manual")
			const draft = storage.create("Auto Deferred Review")
			runtime.setActive(draft)
			runtime.setPendingScope(draft.id, {
				goal: "Goal",
				successCriteria: ["Works"],
				constraints: [],
				phases: [{ name: "Phase", goal: "Build", steps: [] }],
			})
			setPendingPlanReview({
				fermentId: draft.id,
				planMarkdown: "# Plan: Auto Deferred Review",
			})

			const { handlers, pi } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "start_auto" }),
					notify: vi.fn(),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			await vi.runOnlyPendingTimersAsync()

			expect(runtime.getContinuationPolicy()).toBe("automated")
			expect(requestSharedFooterRenderMock).toHaveBeenCalled()
			expect(storage.get(draft.id)?.status).toBe("planned")
			expect(getPendingPlanReview(draft.id)).toBeUndefined()
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "ferment_continuation_nudge", display: false }),
				expect.objectContaining({ triggerTurn: true, deliverAs: "followUp" }),
			)
			expect(pi.appendEntry).toHaveBeenCalledWith(
				"ferment_breadcrumb",
				expect.objectContaining({ text: expect.stringContaining("policy automated") }),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("runs the pending plan review captured before the agent_end timer", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-race-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			runtime.setContinuationPolicy("automated")
			const firstDraft = storage.create("First Deferred Review")
			const secondDraft = storage.create("Second Deferred Review")
			runtime.setActive(firstDraft)
			runtime.setPendingScope(firstDraft.id, {
				goal: "First goal",
				successCriteria: ["First works"],
				constraints: [],
				phases: [{ name: "First phase", goal: "Build first", steps: [] }],
			})
			runtime.setPendingScope(secondDraft.id, {
				goal: "Second goal",
				successCriteria: ["Second works"],
				constraints: [],
				phases: [{ name: "Second phase", goal: "Build second", steps: [] }],
			})
			setPendingPlanReview({
				fermentId: firstDraft.id,
				planMarkdown: "# Plan: First Deferred Review",
			})
			setPendingPlanReview({
				fermentId: secondDraft.id,
				planMarkdown: "# Plan: Second Deferred Review",
			})

			const { handlers } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "start" }),
					notify: vi.fn(),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			runtime.setActive(secondDraft)
			await vi.runOnlyPendingTimersAsync()

			expect(storage.get(firstDraft.id)?.status).toBe("planned")
			expect(storage.get(secondDraft.id)?.status).toBe("draft")
			expect(getPendingPlanReview(firstDraft.id)).toBeUndefined()
			expect(getPendingPlanReview(secondDraft.id)).toBeDefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it("routes pending plan review feedback as hidden replanning input after agent_end", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-feedback-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			const draft = storage.create("Deferred Feedback")
			runtime.setActive(draft)
			runtime.setPendingScope(draft.id, {
				goal: "Goal",
				successCriteria: ["Works"],
				constraints: [],
				phases: [{ name: "Phase", goal: "Build", steps: [] }],
			})
			setPendingPlanReview({
				fermentId: draft.id,
				planMarkdown: "# Plan: Deferred Feedback",
			})

			const { handlers, pi } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "feedback", text: "drop phase 2" }),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			await vi.runOnlyPendingTimersAsync()

			expect(storage.get(draft.id)?.status).toBe("draft")
			expect(getPendingPlanReview(draft.id)).toBeDefined()
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "ferment_scoping_iteration",
					display: false,
					content: expect.stringContaining("drop phase 2"),
				}),
				{ triggerTurn: true, deliverAs: "followUp" },
			)
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringContaining(`ferment_id "${draft.id}"`),
				}),
				expect.anything(),
			)
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringContaining("Do not call scope_ferment"),
				}),
				expect.anything(),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps pending plan review when the review dialog is cancelled", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-cancel-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			const draft = storage.create("Cancelled Review")
			runtime.setActive(draft)
			runtime.setPendingScope(draft.id, {
				goal: "Goal",
				successCriteria: ["Works"],
				constraints: [],
				phases: [{ name: "Phase", goal: "Build", steps: [] }],
			})
			setPendingPlanReview({
				fermentId: draft.id,
				planMarkdown: "# Plan: Cancelled Review",
			})

			const { handlers, pi } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "cancelled", reason: "decision_cancelled" }),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			await vi.runOnlyPendingTimersAsync()

			expect(storage.get(draft.id)?.status).toBe("draft")
			expect(getPendingPlanReview(draft.id)).toBeDefined()
			expect(pi.sendMessage).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps pending plan review when start confirmation fails", async () => {
		vi.useFakeTimers()
		try {
			const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-index-plan-review-fail-test-")))
			const runtime: FermentRuntime = {
				...createDefaultFermentRuntime(),
				getStorage: () => storage,
			}
			const draft = storage.create("Failed Confirmation")
			runtime.setActive(draft)
			runtime.setPendingScope(draft.id, {
				goal: "Goal",
				successCriteria: ["Works"],
				constraints: [],
			})
			setPendingPlanReview({
				fermentId: draft.id,
				planMarkdown: "# Plan: Failed Confirmation",
			})

			const { handlers, pi } = registerFermentExtension(runtime)
			const agentEnd = handlers.get("agent_end")
			if (!agentEnd) throw new Error("agent_end handler was not registered")
			const ctx = {
				ui: {
					custom: vi.fn().mockResolvedValue({ kind: "start" }),
					notify: vi.fn(),
					setWorkingVisible: vi.fn(),
				},
			}

			await agentEnd({ type: "agent_end" }, ctx)
			await vi.runOnlyPendingTimersAsync()

			expect(storage.get(draft.id)?.status).toBe("draft")
			expect(getPendingPlanReview(draft.id)).toBeDefined()
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save plan"), "error")
			expect(pi.sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "ferment_continuation_nudge" }),
				expect.anything(),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("intercepts a trailing confirmation question after tool calls", async () => {
		setActive(makeActivePlanFerment({ status: "draft" }))
		const { handlers, pi } = registerFermentExtension()
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("No, revise"),
				input: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Proposal received." },
						{ type: "toolCall" },
						{
							type: "text",
							text: `1. Phase one
2. Phase two

Does this plan look right?`,
						},
					],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).toHaveBeenCalledWith("Does this plan look right?", [
			"Yes, this looks right",
			"No, revise",
			"Let me say something else",
		])
		expect(pi.sendUserMessage).toHaveBeenCalledWith("No — please revise.", { deliverAs: "followUp" })
	})

	it("does not show a second draft confirmation after propose_ferment_scoping already asked", async () => {
		setActive(makeActivePlanFerment({ status: "draft" }))
		const { handlers, pi } = registerFermentExtension()
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")

		const ctx = {
			ui: {
				select: vi.fn(),
				input: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "1. Phase one\n2. Phase two\n" },
						{ type: "toolCall", name: "propose_ferment_scoping" },
						{ type: "text", text: "Does this plan look right?" },
					],
				},
			},
			ctx,
		)

		expect(ctx.ui.select).not.toHaveBeenCalled()
		expect(pi.sendUserMessage).not.toHaveBeenCalled()
	})
})
