import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentStorage, clearFermentCache } from "../../ferment/store.js"
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

		await fermentCommand('add "Rewrite login"', { hasUI: false, ui: { notify: vi.fn() } })

		const created = new FermentStorage().list()
		expect(created).toHaveLength(1)
		expect(created[0].name).toBe("Rewrite login")
		expect(created[0].description).toBe("Rewrite login")
	})
})
