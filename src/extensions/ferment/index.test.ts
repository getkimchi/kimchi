import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import fermentExtension from "./index.js"
import { getActive, setActive } from "./state.js"

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

function registerFermentExtension() {
	const handlers = new Map<string, EventHandler>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI

	fermentExtension(pi)
	return { handlers, pi }
}

afterEach(() => {
	setActive(undefined)
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
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
