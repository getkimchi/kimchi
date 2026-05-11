import { randomUUID } from "node:crypto"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentStorage, clearFermentCache } from "../../ferment/store.js"
import type { Ferment } from "../../ferment/types.js"
import fermentExtension from "./index.js"
import { getActive, setActive } from "./state.js"

vi.mock("../../ferment/shorten-title.js", () => ({
	shortenTitle: vi.fn(async (input: string) => input),
}))

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown
type CommandHandler = (args: string, ctx: unknown) => Promise<unknown> | unknown

function registerFermentExtension() {
	const handlers = new Map<string, EventHandler>()
	const commands = new Map<string, CommandHandler>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		registerCommand: (name: string, command: { handler: CommandHandler }) => {
			commands.set(name, command.handler)
		},
		registerTool: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI

	fermentExtension(pi)
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
