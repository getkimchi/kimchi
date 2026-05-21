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
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { getActive, isAutomatedContinuationEnabled, setActive, setContinuationPolicy } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { completeFerment, scopeFerment } from "./tools/lifecycle.js"

vi.mock("../../ferment/shorten-title.js", () => ({
	shortenTitle: vi.fn(async (input: string) => input),
}))

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
	const commands = new Map<string, CommandHandler>()
	const shortcuts = new Map<string, { description?: string; handler: ShortcutHandler }>()
	const registeredFlags = new Set<string>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
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
	requestSharedFooterRenderMock.mockClear()
	resetAllReactiveContinuationNudgeCounts()
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
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
		process.env.KIMCHI_ACTIVE_FERMENT = "missing-ferment-id"
		const { handlers } = registerFermentExtension()
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(getActive()).toBeUndefined()
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
		expect(Object.hasOwn(process.env, "KIMCHI_ACTIVE_FERMENT")).toBe(false)
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
			successCriteria: "Works",
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
		const completed = await completeFerment(
			runtime,
			{
				ferment_id: draft.id,
				final_summary: "done",
				gates: [
					{ id: "C1", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "C2", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "C3", verdict: "pass", rationale: "ok", evidence: "n/a" },
				],
			},
			{ pi: {} as never },
		)
		if ("isError" in completed && completed.isError) throw new Error(completed.content[0].text)

		process.env.KIMCHI_ACTIVE_FERMENT = draft.id
		const { handlers, pi } = registerFermentExtension(runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(storage.get(draft.id)?.status).toBe("complete")
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
		expect(Object.hasOwn(process.env, "KIMCHI_ACTIVE_FERMENT")).toBe(false)
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
		process.env.KIMCHI_ACTIVE_FERMENT = "missing-id"
		const { handlers } = registerFermentExtension(undefined, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(Object.hasOwn(process.env, "KIMCHI_ACTIVE_FERMENT")).toBe(false)

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
			successCriteria: "Works",
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
			successCriteria: "Works",
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
			successCriteria: "Works",
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
			successCriteria: "Works",
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
		await completeFerment(
			runtime,
			{
				ferment_id: draft.id,
				final_summary: "done",
				gates: [
					{ id: "C1", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "C2", verdict: "pass", rationale: "ok", evidence: "n/a" },
					{ id: "C3", verdict: "pass", rationale: "ok", evidence: "n/a" },
				],
			},
			{ pi: {} as never },
		)

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
			successCriteria: "Works",
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
				goal: "Goal",
				success_criteria: "Works",
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
			successCriteria: "Works",
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
