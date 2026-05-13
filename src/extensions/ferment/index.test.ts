import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { FermentStorage, clearFermentCache } from "../../ferment/store.js"
import type { Ferment } from "../../ferment/types.js"
import fermentExtension from "./index.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { getActive, setActive } from "./state.js"

vi.mock("../../ferment/shorten-title.js", () => ({
	shortenTitle: vi.fn(async (input: string) => input),
}))

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown
type CommandHandler = (args: string, ctx: unknown) => Promise<unknown> | unknown

function registerFermentExtension(runtime?: FermentRuntime, flagValues: Record<string, boolean | string> = {}) {
	const handlers = new Map<string, EventHandler>()
	const commands = new Map<string, CommandHandler>()
	const registeredFlags = new Set<string>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		registerCommand: (name: string, command: { handler: CommandHandler }) => {
			commands.set(name, command.handler)
		},
		registerTool: vi.fn(),
		registerFlag: vi.fn((name: string) => {
			registeredFlags.add(name)
		}),
		getFlag: vi.fn((name: string) => (registeredFlags.has(name) ? flagValues[name] : undefined)),
		getActiveTools: vi.fn(() => ["read", "bash", "create_ferment", "start_step"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "create_ferment" }, { name: "start_step" }]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI

	fermentExtension(pi, runtime)
	return { commands, handlers, pi }
}

afterEach(() => {
	setActive(undefined)
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
	clearFermentCache()
	const storage = new FermentStorage()
	for (const item of storage.list()) {
		storage.delete(item.id)
	}
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
})

describe("fermentExtension one-shot bootstrap", () => {
	it("creates an exec-mode ferment and rewrites the initial message into a nudge", async () => {
		const { handlers, pi } = registerFermentExtension(undefined, { "ferment-oneshot": true })
		const sessionStart = handlers.get("session_start")
		const input = handlers.get("input")
		if (!sessionStart) throw new Error("session_start handler was not registered")
		if (!input) throw new Error("input handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(pi.registerFlag).toHaveBeenCalledWith("ferment-oneshot", expect.objectContaining({ type: "boolean" }))
		expect(getActive()).toBeUndefined()

		const intent = "Add a CSV export endpoint that streams the orders table"
		const result = (await input({ type: "input", text: intent, source: "interactive" }, {})) as
			| { action: "transform"; text: string }
			| undefined

		const created = getActive()
		expect(created).toBeDefined()
		expect(created?.mode).toBe("exec")
		expect(created?.description).toBe(intent)

		expect(result?.action).toBe("transform")
		expect(result?.text).toContain("one-shot ferment")
		expect(result?.text).toContain(intent)
		expect(result?.text).toContain(created?.id ?? "")

		// Bootstrap is a one-shot — a second input must pass through untouched.
		const next = await input({ type: "input", text: "follow-up", source: "interactive" }, {})
		expect(next).toBeUndefined()

		// Side-effects: ack entry + ferment_reference entry get appended.
		const calls = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
		expect(calls).toContain("ferment_ack")
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
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_oneshot_failed",
			expect.objectContaining({ text: expect.stringContaining("storage unavailable") }),
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
	it('strips the add subcommand from /ferment add "Title"', async () => {
		const { commands } = registerFermentExtension()
		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		const title = `Rewrite login ${randomUUID()}`

		await fermentCommand(`add "${title}"`, { hasUI: false, ui: { notify: vi.fn() } })

		const created = getActive()
		expect(created?.name).toBe(title)
		expect(created?.description).toBe(title)
	})

	it("uses injected runtime storage for headless add and scoping nudge", async () => {
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

		await fermentCommand(`add "${title}"`, { hasUI: false, ui: { notify: vi.fn() } })

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
		mode: "plan",
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

	it("does not show a second draft confirmation after propose_phases already asked", async () => {
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
						{ type: "toolCall", name: "propose_phases" },
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
