import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai"
import { type ExtensionContext, SessionManager, type TurnEndEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __clearModelThinkingLevelsForTest, registerModelThinkingLevels } from "../models.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createAutoModelRoutingExtension } from "./auto-model/index.js"
import { createResponseRecoveryExtension, responseRecoveryExtension } from "./response-recovery.js"

describe("generic request length recovery", () => {
	let pi: ReturnType<typeof createExtensionApi>
	let owner: SessionManager
	let ctx: ExtensionContext
	let message: AssistantMessage

	function assistant(stopReason: string, content: unknown[] = []): AssistantMessage {
		return { role: "assistant", content, stopReason, thinkingLevel: "high" } as unknown as AssistantMessage
	}

	function turn(message: AssistantMessage, messageEntryId: string): TurnEndEvent {
		return {
			type: "turn_end",
			turnIndex: 0,
			message,
			messageEntryId,
			toolResults: [],
			toolResultEntryIds: [],
			entries: [],
			continue: true,
			context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
			outcome: "completed",
		}
	}

	function setup(level: ModelThinkingLevel = "high", id = "length-test-model") {
		owner = SessionManager.inMemory()
		owner.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() })
		message = assistant("length", [{ type: "thinking", thinking: "plan" }])
		Object.assign(message, { thinkingLevel: level })
		ctx = createContext({
			model: { id, provider: "kimchi-dev", reasoning: true, thinkingLevelMap: { off: "none", max: "max" } },
			sessionManager: owner,
			thinkingLevel: level,
		})
		pi.getThinkingLevel.mockReturnValue(level)
		pi.setThinkingLevel.mockImplementation((next) => {
			ctx.thinkingLevel = next
			pi.getThinkingLevel.mockReturnValue(next)
		})
		return owner.appendMessage(message)
	}

	async function finish(messageInput: AssistantMessage, entryId: string) {
		return await pi.emit("turn_end", turn(messageInput, entryId), ctx)
	}

	beforeEach(() => {
		__clearModelThinkingLevelsForTest()
		pi = createExtensionApi()
		responseRecoveryExtension(pi.api)
	})

	afterEach(() => {
		__clearModelThinkingLevelsForTest()
		vi.restoreAllMocks()
	})

	it("persists omission of the exact failed entry, retains raw history, and keeps the lowered level after success", async () => {
		const entryId = setup("high")
		const sourceEntriesBefore = owner.getEntries().length
		await finish(message, entryId)
		const edit = owner.getEntries().findLast((entry) => entry.type === "context_edit")
		expect(edit).toMatchObject({ targetId: entryId, replacement: null })
		expect(owner.buildSessionProjection().messages.map((item) => item.role)).toEqual(["user"])
		expect(owner.getEntries().filter((entry) => entry.type === "message")).toHaveLength(sourceEntriesBefore)
		expect(owner.getEntry(entryId)).toMatchObject({ message })
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("medium")
		expect(pi.sendMessage).toHaveBeenCalledOnce()
		expect(pi.sendMessage.mock.calls[0][0]).toMatchObject({ customType: "request-length-continuation", display: false })
		const successful = assistant("stop", [{ type: "text", text: "Complete" }])
		await pi.emit("agent_end", { messages: [message, successful] }, ctx)
		expect(pi.getThinkingLevel()).toBe("medium")
	})

	it("continues partial visible text and requests a fresh answer when the failed answer is blank", async () => {
		const entryId = setup()
		message.content.push({ type: "text", text: "Already visible" })
		await finish(message, entryId)
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("Continue from its last visible character")
		const edit = owner.getEntries().findLast((entry) => entry.type === "context_edit")
		expect(edit).toMatchObject({
			targetId: entryId,
			replacement: { content: [{ type: "text", text: "Already visible" }] },
		})
		const projected = owner.buildSessionProjection().messages.find((item) => item.role === "assistant")
		expect(projected?.content).toEqual([{ type: "text", text: "Already visible" }])
		expect(owner.getEntry(entryId)).toMatchObject({ message })
		message.content = []
		await pi.emit("session_shutdown", {}, ctx)
		const secondOwner = setup("high", "another-model")
		message = assistant("length")
		await finish(message, secondOwner)
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
		expect(pi.sendMessage.mock.calls[1][0].content).toContain("before producing visible text")
	})

	it.each([
		{ effort: undefined, queued: false },
		{ effort: "high", queued: true },
		{ effort: "low", queued: false },
	])("Auto with routed effort $effort queues=$queued", async ({ effort, queued }) => {
		pi = createExtensionApi()
		createAutoModelRoutingExtension()(pi.api)
		responseRecoveryExtension(pi.api)
		const entryId = setup("high", "auto")
		Object.assign(message, { provider: "kimchi-dev", model: "auto" })
		await pi.emit("before_provider_headers", {}, ctx)
		await pi.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: effort ? { "x-auto-reasoning-effort": effort } : {},
			},
			ctx,
		)
		await pi.emit("message_end", { message }, ctx)
		await finish(message, entryId)
		expect(pi.sendMessage.mock.calls.length > 0).toBe(queued)
		expect(owner.getEntries().some((entry) => entry.type === "context_edit")).toBe(queued)
	})

	it("separates an ungated native RPC host from an unopted ACP host", async () => {
		const host = await import("../modes/acp/state.js")
		vi.spyOn(host, "isAcpSessionHost").mockReturnValueOnce(false)
		const entryId = setup()
		Object.assign(ctx, { mode: "rpc" })
		await finish(message, entryId)
		expect(pi.sendMessage).toHaveBeenCalledOnce()

		pi = createExtensionApi()
		responseRecoveryExtension(pi.api)
		const nextEntry = setup("high", "another-model")
		Object.assign(ctx, { mode: "rpc" })
		vi.spyOn(host, "isAcpSessionHost").mockReturnValueOnce(true)
		await finish(message, nextEntry)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("chooses the next supported lower level, including xhigh and max", async () => {
		registerModelThinkingLevels("kimchi-dev/length-test-model", ["low", "xhigh", "max"])
		const entryId = setup("max")
		if (!ctx.model?.thinkingLevelMap) throw new Error("Test model is missing")
		ctx.model.thinkingLevelMap.xhigh = "max"
		await finish(message, entryId)
		expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("xhigh")
	})

	it("does not force minimum, off, or a guessed level when no lower level is supported", async () => {
		registerModelThinkingLevels("kimchi-dev/length-test-model", ["high", "xhigh"])
		const entryId = setup()
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.setThinkingLevel).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no supported lower"), "warning")
	})

	it.each([
		undefined,
		"auto",
		"high-ish",
		"medium",
		"low",
		"minimal",
		"off",
	])("does not infer high tier from actual effort %s", async (level) => {
		const entryId = setup()
		Object.assign(message, { thinkingLevel: level })
		ctx.thinkingLevel = undefined
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(owner.getEntries().some((entry) => entry.type === "context_edit")).toBe(false)
	})

	it("does not retry non-length responses, non-reasoning models, or empty selectable levels", async () => {
		const entryId = setup("high", "not-reasoning")
		if (!ctx.model) throw new Error("Test model is missing")
		ctx.model.reasoning = false
		await finish(assistant("stop"), entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		message.stopReason = "length"
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		registerModelThinkingLevels("kimchi-dev/not-reasoning", [])
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("leaves tool-bearing truncation to native tool execution without omission or custom replay", async () => {
		const entryId = setup()
		message.content.push({ type: "toolCall", id: "tool-1", name: "bash", arguments: {} })
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(owner.getEntries().some((entry) => entry.type === "context_edit")).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("custom replay"), "warning")
	})

	it("does not retry on a second truncation", async () => {
		const entryId = setup()
		await finish(message, entryId)
		const second = assistant("length")
		const secondEntry = owner.appendMessage(second)
		await finish(second, secondEntry)
		expect(pi.sendMessage).toHaveBeenCalledOnce()
		await pi.emit("agent_end", { messages: [message, second] }, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("persists before enqueue and restores preference if persistence fails", async () => {
		const entryId = setup()
		const calls: string[] = []
		const appendContextEdit = owner.appendContextEdit.bind(owner)
		vi.spyOn(owner, "appendContextEdit").mockImplementation((target, replacement) => {
			calls.push("append")
			return appendContextEdit(target, replacement)
		})
		pi.sendMessage.mockImplementation(async () => {
			calls.push("send")
		})
		await finish(message, entryId)
		expect(calls).toEqual(["append", "send"])
		vi.spyOn(owner, "appendContextEdit").mockImplementation(() => {
			throw new Error("injected append failure")
		})
		await pi.emit("session_shutdown", {}, ctx)
		const next = assistant("length")
		await finish(next, owner.appendMessage(next))
		expect(pi.sendMessage).toHaveBeenCalledOnce()
		expect(pi.setThinkingLevel).not.toHaveBeenCalledWith("off")
	})

	it("does not retry if the new context edit is not findable in the branch", async () => {
		const entryId = setup()
		vi.spyOn(owner, "getEntry").mockReturnValue(undefined)
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.setThinkingLevel).not.toHaveBeenCalled()
	})

	it("restores the original preference when setup throws", async () => {
		const entryId = setup()
		pi.setThinkingLevel.mockImplementationOnce(() => {
			throw new Error("injected setter failure")
		})
		await finish(message, entryId)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.setThinkingLevel).toHaveBeenCalledOnce()
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("restores after enqueue failure and ignores stale retry bookkeeping after a new input", async () => {
		const entryId = setup()
		pi.sendMessage.mockImplementationOnce(() => {
			throw new Error("injected queue failure")
		})
		await finish(message, entryId)
		expect(pi.getThinkingLevel()).toBe("high")
		await pi.emit("input", {}, ctx)
		expect(ctx.abort).not.toHaveBeenCalled()
	})

	it("sets queued only after the enqueue returns and shutdown cancellation restores preference", async () => {
		const entryId = setup()
		pi.sendMessage.mockImplementationOnce(() => {
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Queued"), "info")
		})
		await finish(message, entryId)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Queued"), "info")
		await pi.emit("session_shutdown", {}, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("fresh input cancels a queued retry in its own owner only", async () => {
		const firstEntry = setup()
		await finish(message, firstEntry)
		const secondCtx = createContext({ ...ctx, sessionManager: SessionManager.inMemory() })
		await pi.emit("input", {}, secondCtx)
		expect(secondCtx.abort).not.toHaveBeenCalled()
		await pi.emit("input", {}, ctx)
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("manual preference overrides win during both success and rollback", async () => {
		const entryId = setup()
		await finish(message, entryId)
		pi.getThinkingLevel.mockReturnValue("low")
		await pi.emit("agent_end", { messages: [assistant("error")] }, ctx)
		expect(pi.setThinkingLevel).toHaveBeenCalledOnce()
		const newEntry = setup("high", "another-model")
		await finish(message, newEntry)
		ctx.model = undefined
		await pi.emit("agent_end", { messages: [assistant("stop")] }, ctx)
		expect(pi.getThinkingLevel()).toBe("medium")
	})

	it("isolated ACP-style managers with the same id cannot settle each other's state", async () => {
		const firstEntry = setup()
		await finish(message, firstEntry)
		const oldCtx = ctx
		Object.assign(owner, { sessionId: "same-public-id" })

		const secondOwner = SessionManager.inMemory()
		Object.assign(secondOwner, { sessionId: "same-public-id" })
		const secondCtx = createContext({ model: ctx.model, sessionManager: secondOwner, thinkingLevel: "high" })
		const secondMessage = assistant("length")
		const secondEntry = secondOwner.appendMessage(secondMessage)
		const secondPi = createExtensionApi()
		responseRecoveryExtension(secondPi.api)
		let secondLevel: ModelThinkingLevel = "high"
		secondPi.getThinkingLevel.mockImplementation(() => secondLevel)
		secondPi.setThinkingLevel.mockImplementation((level) => {
			secondLevel = level
		})
		await secondPi.emit("turn_end", turn(secondMessage, secondEntry), secondCtx)
		expect(secondPi.getThinkingLevel()).toBe("medium")
		await pi.emit("session_shutdown", {}, oldCtx)
		expect(pi.getThinkingLevel()).toBe("high")
		expect(secondPi.getThinkingLevel()).toBe("medium")
		await secondPi.emit("agent_end", { messages: [assistant("stop")] }, secondCtx)
		expect(secondPi.getThinkingLevel()).toBe("medium")
	})

	it("removes both the omitted response and hidden retry directive from rebuilt provider context", async () => {
		const entryId = setup()
		await finish(message, entryId)
		const visible = assistant("stop", [{ type: "text", text: "kept" }])
		const cloneOfFailure = { ...message }
		const continuation = {
			role: "custom",
			customType: "request-length-continuation",
			content: "keep running",
			display: false,
		}
		const projection = await pi.emit("context", { messages: [cloneOfFailure, visible, continuation] }, ctx)
		expect(projection).toEqual([{ messages: [visible, continuation] }])
		await pi.emit("before_provider_headers", {}, ctx)
		const retriedProjection = await pi.emit("context", { messages: [cloneOfFailure, visible, continuation] }, ctx)
		expect(retriedProjection).toEqual([{ messages: [visible] }])
		await pi.emit("agent_end", { messages: [assistant("stop")] }, ctx)
		const nextTurn = await pi.emit("context", { messages: [visible, continuation] }, ctx)
		expect(nextTurn).toEqual([{ messages: [visible] }])
	})

	it("restores after an aborted fallback rather than treating cancellation as success", async () => {
		const entryId = setup()
		await finish(message, entryId)
		await pi.emit("agent_end", { messages: [assistant("aborted")] }, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("native retry decisions prevent premature settlement", async () => {
		const entryId = setup()
		await finish(message, entryId)
		await pi.emit("agent_end", { messages: [assistant("error")], willRetry: true }, ctx)
		expect(pi.getThinkingLevel()).toBe("medium")
		await pi.emit("agent_end", { messages: [assistant("error")], willRetry: false }, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("does not persist omission before a restorable preference is known", async () => {
		const entryId = setup()
		pi.getThinkingLevel.mockImplementation(() => "auto" as unknown as ModelThinkingLevel)
		await finish(message, entryId)
		expect(owner.getEntries().some((entry) => entry.type === "context_edit")).toBe(false)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		pi.getThinkingLevel.mockImplementation(() => {
			throw new Error("preference read failed")
		})
		await finish(message, entryId)
		expect(owner.getEntries().some((entry) => entry.type === "context_edit")).toBe(false)
	})

	it("restores when abort was requested before a final stop response settled", async () => {
		const entryId = setup()
		const controller = new AbortController()
		Object.assign(ctx, { signal: controller.signal })
		await finish(message, entryId)
		controller.abort()
		await pi.emit("agent_end", { messages: [assistant("stop")] }, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
		await pi.emit("agent_settled", { aborted: true }, ctx)
		expect(pi.getThinkingLevel()).toBe("high")
	})

	it("honors deliberate overrides even when they return to the fallback level", async () => {
		const entryId = setup()
		await finish(message, entryId)
		await pi.emit("thinking_level_select", { level: "medium", previousLevel: "high" }, ctx)
		pi.getThinkingLevel.mockReturnValue("low")
		await pi.emit("thinking_level_select", { level: "low", previousLevel: "medium" }, ctx)
		pi.getThinkingLevel.mockReturnValue("medium")
		await pi.emit("thinking_level_select", { level: "medium", previousLevel: "low" }, ctx)
		await pi.emit("session_shutdown", {}, ctx)
		expect(pi.setThinkingLevel).toHaveBeenCalledOnce()
		expect(pi.getThinkingLevel()).toBe("medium")
	})

	it("suppresses normal notices for UI-less child sessions", async () => {
		pi = createExtensionApi()
		createResponseRecoveryExtension({ headlessNotices: "suppress" })(pi.api)
		const entryId = setup()
		Object.assign(ctx, { hasUI: false })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		await finish(message, entryId)
		const second = assistant("length")
		await finish(second, owner.appendMessage(second))
		expect(log).not.toHaveBeenCalled()
		expect(warning).not.toHaveBeenCalled()
		expect(error).not.toHaveBeenCalled()
	})

	it("keeps the default headless console fallback", async () => {
		const entryId = setup()
		Object.assign(ctx, { hasUI: false })
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		await finish(message, entryId)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Queued one medium continuation"))
	})

	it("delivers a fresh continuation for an independent later attempt", async () => {
		const continuation = {
			role: "custom",
			customType: "request-length-continuation",
			content: "continue",
			display: false,
		}
		const firstEntry = setup()
		await finish(message, firstEntry)
		await pi.emit("before_provider_headers", {}, ctx)
		await pi.emit("agent_end", { messages: [assistant("stop")] }, ctx)
		pi.getThinkingLevel.mockReturnValue("high")
		message = assistant("length")
		const secondEntry = owner.appendMessage(message)
		await finish(message, secondEntry)
		const projection = await pi.emit("context", { messages: [message, continuation] }, ctx)
		expect(projection).toEqual([{ messages: [continuation] }])
	})
})
