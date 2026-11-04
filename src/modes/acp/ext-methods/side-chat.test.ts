import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SideChatAcpBridge, SideChatSnapshot } from "../../../extensions/side-chat/acp-bridge.js"
import { registerSideChatBridge, resetSideChatBridges } from "../../../extensions/side-chat/registry.js"

const resourceGate = vi.hoisted(() => ({ enabled: true }))

vi.mock("../../../resources/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../resources/store.js")>()
	return {
		...actual,
		isResourceEnabled: vi.fn(() => resourceGate.enabled),
	}
})

import {
	handleSideChatClose,
	handleSideChatHistory,
	handleSideChatOpen,
	handleSideChatPrompt,
	handleSideChatResume,
	handleSideChatSendToMain,
	handleSideChatWrap,
} from "./side-chat.js"

function snapshot(overrides?: Partial<SideChatSnapshot>): SideChatSnapshot {
	return {
		id: "side-1",
		title: "a chat",
		fresh: false,
		contextLength: 7,
		thread: [],
		mode: "chat",
		working: false,
		closed: false,
		...overrides,
	}
}

function fakeBridge(overrides?: Partial<Record<keyof SideChatAcpBridge, unknown>>): SideChatAcpBridge {
	return {
		lastSideChatId: "side-1",
		open: vi.fn(async () => snapshot()),
		resume: vi.fn(async (id: string) => (id === "side-1" ? snapshot() : undefined)),
		prompt: vi.fn(() => ({ status: "started" })),
		wrap: vi.fn(async () => ({ draft: "steer the main agent" })),
		sendToMain: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		history: vi.fn(() => [
			{
				id: "side-1",
				sessionId: "session-1",
				branchLeafId: null,
				startedAt: 1000,
				updatedAt: 2000,
				title: "a chat",
				questions: 2,
				outcome: "sent",
			},
		]),
		...overrides,
	} as unknown as SideChatAcpBridge
}

describe("side_chat ext-method handlers", () => {
	beforeEach(() => {
		resourceGate.enabled = true
	})

	afterEach(() => {
		resetSideChatBridges()
	})

	it("rejects a missing sessionId", async () => {
		await expect(handleSideChatOpen({})).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects an unknown sessionId", async () => {
		await expect(handleSideChatOpen({ sessionId: "nope" })).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects every method when the resource is disabled", async () => {
		resourceGate.enabled = false
		registerSideChatBridge("session-1", fakeBridge())

		await expect(handleSideChatOpen({ sessionId: "session-1" })).rejects.toMatchObject({
			code: -32600,
			message: expect.stringContaining("extensions.side-chat"),
		})
		expect(() => handleSideChatHistory({ sessionId: "session-1" })).toThrowError(/extensions\.side-chat/)
	})

	it("open validates fresh and returns the snapshot", async () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		await expect(handleSideChatOpen({ sessionId: "session-1", fresh: "yes" })).rejects.toMatchObject({
			code: -32602,
		})

		const result = await handleSideChatOpen({ sessionId: "session-1", question: "hi", fresh: true })
		expect(bridge.open).toHaveBeenCalledWith({ prompt: "hi", quote: undefined, fresh: true })
		expect(result).toMatchObject({ id: "side-1", title: "a chat", fresh: false, contextLength: 7, closed: false })
	})

	it("prompt validates text and rejects slash commands", () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		expect(() => handleSideChatPrompt({ sessionId: "session-1", text: "" })).toThrowError(/non-empty/)
		expect(() => handleSideChatPrompt({ sessionId: "session-1", text: "/wrap" })).toThrowError(/side_chat_wrap/)

		expect(handleSideChatPrompt({ sessionId: "session-1", text: "question?" })).toEqual({ status: "started" })
		expect(bridge.prompt).toHaveBeenCalledWith("question?")
	})

	it("prompt maps a missing chat to invalidRequest", () => {
		const bridge = fakeBridge({
			prompt: () => {
				throw new Error("No side chat is open.")
			},
		})
		registerSideChatBridge("session-1", bridge)

		expect(() => handleSideChatPrompt({ sessionId: "session-1", text: "hi" })).toThrowError(/No side chat is open/)
	})

	it("wrap forwards extra and returns the draft", async () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		await expect(handleSideChatWrap({ sessionId: "session-1", extra: 5 })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(handleSideChatWrap({ sessionId: "session-1", extra: "short please" })).resolves.toEqual({
			draft: "steer the main agent",
		})
		expect(bridge.wrap).toHaveBeenCalledWith("short please")
	})

	it("send_to_main requires text and closes the chat", async () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		await expect(handleSideChatSendToMain({ sessionId: "session-1" })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(handleSideChatSendToMain({ sessionId: "session-1", text: "go" })).resolves.toEqual({})
		expect(bridge.sendToMain).toHaveBeenCalledWith("go")
	})

	it("close and history forward to the bridge", async () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		await expect(handleSideChatClose({ sessionId: "session-1" })).resolves.toEqual({})
		expect(bridge.close).toHaveBeenCalled()

		const history = handleSideChatHistory({ sessionId: "session-1" })
		expect(history).toEqual({
			chats: [expect.objectContaining({ id: "side-1", title: "a chat", questions: 2, outcome: "sent" })],
		})
	})

	it("resume rejects unknown sideChatId and resumes a known one", async () => {
		const bridge = fakeBridge()
		registerSideChatBridge("session-1", bridge)

		await expect(handleSideChatResume({ sessionId: "session-1", sideChatId: "nope" })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(handleSideChatResume({ sessionId: "session-1", sideChatId: "side-1" })).resolves.toMatchObject({
			id: "side-1",
		})
		expect(bridge.resume).toHaveBeenCalledWith("side-1")
	})
})
