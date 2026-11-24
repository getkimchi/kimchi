import { beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import type { ToolPermissionPrompter } from "./prompter.js"
import {
	canPromptThroughSession,
	registerSessionPermissionPrompter,
	resetSessionPermissionPromptersForTests,
	resolveSessionPermissionPrompter,
} from "./session-prompter-registry.js"

const prompter = (tag: string): ToolPermissionPrompter => ({
	request: async () => {
		void tag
		return { kind: "allow-once" }
	},
})

const context = (sessionId: string) => createContext({ sessionManager: { getSessionId: () => sessionId } })

describe("session permission prompter registry", () => {
	beforeEach(() => resetSessionPermissionPromptersForTests())

	it("keeps sessions isolated and leaves unregistered sessions headless", () => {
		registerSessionPermissionPrompter("session-a", {
			canPromptDirectly: () => true,
			resolve: () => prompter("a"),
		})
		expect(canPromptThroughSession(context("session-a"))).toBe(true)
		expect(resolveSessionPermissionPrompter(context("session-a"))).toBeDefined()
		expect(canPromptThroughSession(context("session-b"))).toBe(false)
		expect(resolveSessionPermissionPrompter(context("session-b"))).toBeUndefined()
	})

	it("resolves through the latest registration and restores its predecessor on cleanup", () => {
		const tool = prompter("tool")
		const remove = registerSessionPermissionPrompter("session", {
			canPromptDirectly: () => false,
			resolve: () => tool,
		})
		registerSessionPermissionPrompter("session", {
			canPromptDirectly: () => true,
			resolve: () => tool,
		})
		expect(canPromptThroughSession(context("session"))).toBe(true)
		expect(resolveSessionPermissionPrompter(context("session"))).toBe(tool)

		remove()
		expect(canPromptThroughSession(context("session"))).toBe(true)
		expect(resolveSessionPermissionPrompter(context("session"))).toBe(tool)
		remove()
		expect(canPromptThroughSession(context("session"))).toBe(true)
		expect(resolveSessionPermissionPrompter(context("session"))).toBe(tool)
	})

	it("supports lazy direct-interaction transitions and registration-scoped cleanup", () => {
		const tool = prompter("tool")
		let direct = false
		const remove = registerSessionPermissionPrompter("session", {
			canPromptDirectly: () => direct,
			resolve: () => tool,
		})
		expect(canPromptThroughSession(context("session"))).toBe(false)
		direct = true
		expect(canPromptThroughSession(context("session"))).toBe(true)
		direct = false
		expect(canPromptThroughSession(context("session"))).toBe(false)
		expect(resolveSessionPermissionPrompter(context("session"))).toBe(tool)

		remove()
		expect(canPromptThroughSession(context("session"))).toBe(false)
		expect(resolveSessionPermissionPrompter(context("session"))).toBeUndefined()
	})

	it("lets a registration select only the contexts it owns", () => {
		const tool = prompter("rpc")
		registerSessionPermissionPrompter("session", {
			canPromptDirectly: (ctx) => ctx.mode === "rpc",
			resolve: (ctx) => (ctx.mode === "rpc" ? tool : undefined),
		})
		const terminalCtx = context("session")
		terminalCtx.mode = "tui"
		expect(canPromptThroughSession(terminalCtx)).toBe(false)
		expect(resolveSessionPermissionPrompter(terminalCtx)).toBeUndefined()

		const rpcCtx = context("session")
		rpcCtx.mode = "rpc"
		expect(canPromptThroughSession(rpcCtx)).toBe(true)
		expect(resolveSessionPermissionPrompter(rpcCtx)).toBe(tool)
	})
})
