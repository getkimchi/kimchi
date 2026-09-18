import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import feedbackExtension from "./index.js"

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown
type ShortcutHandler = (ctx: ExtensionContext) => Promise<unknown> | unknown

function makeApi() {
	const handlers = new Map<string, EventHandler[]>()
	const shortcuts = new Map<string, { description?: string; handler: ShortcutHandler }>()
	const on = vi.fn((event: string, handler: EventHandler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const registerShortcut = vi.fn((shortcut: string, options: { description?: string; handler: ShortcutHandler }) => {
		shortcuts.set(shortcut, options)
	})
	const renderers = new Map<string, unknown>()
	const registerMessageRenderer = vi.fn((type: string, renderer: unknown) => {
		renderers.set(type, renderer)
	})
	const sendMessage = vi.fn()
	const api = {
		on,
		registerShortcut,
		registerMessageRenderer,
		sendMessage,
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "test-session" },
	} as unknown as ExtensionContext
	return {
		api,
		ctx,
		handlers,
		shortcuts,
		renderers,
		sendMessage,
		getShortcutHandler: (key: string = Key.ctrl("r")) => shortcuts.get(key)?.handler,
	}
}

function getEventHandler(handlers: Map<string, EventHandler[]>, event: string): EventHandler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[0]
}

const feedbackMock = vi.hoisted(() => ({ trackFeedback: vi.fn() }))
const trackModelSwitchFeedbackMock = vi.hoisted(() => vi.fn())
const dialogMock = vi.hoisted(() => ({ show: vi.fn() }))
const modelSwitchDialogMock = vi.hoisted(() => ({ show: vi.fn() }))

vi.mock("../telemetry/index.js", () => ({
	trackFeedback: feedbackMock.trackFeedback,
	trackModelSwitchFeedback: trackModelSwitchFeedbackMock,
}))

vi.mock("./dialog.js", () => ({
	showFeedbackDetailsDialog: dialogMock.show,
}))

vi.mock("./model-switch-dialog.js", () => ({
	showModelSwitchDialog: modelSwitchDialogMock.show,
}))

describe("feedbackExtension state machine", () => {
	beforeEach(async () => {
		feedbackMock.trackFeedback.mockReset()
		trackModelSwitchFeedbackMock.mockReset()
		dialogMock.show.mockReset()
		modelSwitchDialogMock.show.mockReset()
		const invitationState = await import("./invitation-state.js")
		invitationState.clearModelSwitchInvitation()
	})

	afterEach(async () => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		const invitationState = await import("./invitation-state.js")
		invitationState.clearModelSwitchInvitation()
	})

	it("registers Ctrl+1, Ctrl+2, and Ctrl+R shortcuts on init", () => {
		const { api } = makeApi()
		feedbackExtension(api)
		expect(api.registerShortcut).toHaveBeenCalledTimes(3)

		const calls = (api.registerShortcut as ReturnType<typeof vi.fn>).mock.calls
		const keys = calls.map((call) => call[0])
		expect(keys).toContain(Key.ctrl("r"))
		expect(keys).toContain(Key.ctrl("1"))
		expect(keys).toContain(Key.ctrl("2"))
		expect(keys).not.toContain(Key.ctrl("t"))
		expect(keys).not.toContain(Key.ctrlShift("up"))
		expect(keys).not.toContain(Key.ctrlShift("down"))

		const ctrlRCall = calls.find((call) => call[0] === Key.ctrl("r"))
		expect(ctrlRCall?.[1].description).toBe("Tell us why you switched")

		const ctrl1Call = calls.find((call) => call[0] === Key.ctrl("1"))
		expect(ctrl1Call?.[1].description).toBe("Rate response as Good")

		const ctrl2Call = calls.find((call) => call[0] === Key.ctrl("2"))
		expect(ctrl2Call?.[1].description).toBe("Rate response as Bad")
	})

	it("does nothing when a rating shortcut is pressed before agent_end has fired", async () => {
		const { api, ctx, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("Ctrl+1 opens the details dialog with positive sentiment after agent_end", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce(undefined)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()
	})

	it("Ctrl+2 opens the details dialog with negative sentiment after agent_end", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })

		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "negative", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "negative",
			reason: "Too slow",
			autoModelUsed: false,
		})
	})

	it("Ctrl+1 with a positive reason submits feedback and tracks it", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "positive",
			reason: "Solved my task",
			autoModelUsed: false,
		})
	})

	it("Escape in the details dialog cancels and does not call sendMessage or trackFeedback", async () => {
		const { api, ctx, handlers, sendMessage, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce(undefined)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(sendMessage).not.toHaveBeenCalled()
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()

		// A subsequent Ctrl+2 after the dialog was cancelled should still work —
		// the extension must be back in the "inviting" state.
		getEventHandler(handlers, "agent_end")({}, ctx)
		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(2)
	})

	it("detects auto-model and passes autoModelUsed=true to the details dialog", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		;(ctx as unknown as { model: unknown }).model = { provider: "kimchi-dev", id: "auto", name: "Auto" }
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Auto-model picked the right model" })

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: true })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ autoModelUsed: true }))
	})

	it("returns to idle after the rating flow resolves, accepting new ratings", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })
		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		// Re-trigger invitation.
		getEventHandler(handlers, "agent_end")({}, ctx)
		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(2)
		expect(dialogMock.show).toHaveBeenNthCalledWith(2, ctx, { sentiment: "negative", autoModelUsed: false })
	})

	it("resets the invitation on turn_start", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)
		getEventHandler(handlers, "turn_start")({ turnIndex: 1 }, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("resets the invitation on message_start", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)
		getEventHandler(handlers, "message_start")(
			{
				message: { role: "user", content: "hi", timestamp: Date.now() },
			},
			ctx,
		)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("registers a renderer for feedback-summary", () => {
		const { api, renderers } = makeApi()
		feedbackExtension(api)
		expect(api.registerMessageRenderer).toHaveBeenCalled()
		const types = [...renderers.keys()]
		expect(types).toContain("feedback-summary")
	})

	it("model_select from auto sets the invitation instead of opening dialog immediately", async () => {
		const { api, ctx, handlers, sendMessage, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		const handler = getEventHandler(handlers, "model_select")
		await handler(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)

		// The summary message is sent, but the dialog is NOT opened.
		expect(sendMessage).toHaveBeenCalledTimes(1)
		const invitationCall = sendMessage.mock.calls[0]?.[0] as {
			customType?: string
			content?: Array<{ type: string; text?: string }>
			details?: { model?: string; reason?: string }
		}
		expect(invitationCall).toMatchObject({
			customType: "model-switch-feedback",
			display: true,
			details: { model: "Concrete", reason: "" },
		})
		expect(invitationCall?.content?.[0]?.text).toBe("Tell us why you switched to Concrete (Ctrl+R)")
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()

		// The invitation is now active.
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toMatchObject({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		// Ctrl+R takes precedence over the rating shortcuts.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		await getShortcutHandler(Key.ctrl("r"))?.(ctx)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledWith(ctx, { modelName: "Concrete" })
		// Invitation is cleared after the dialog resolves.
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("Ctrl+R does nothing when no model-switch invitation is active", async () => {
		const { api, ctx, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		await getShortcutHandler(Key.ctrl("r"))?.(ctx)
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("Ctrl+R submit with a reason sends a follow-up message with reason details and tracks feedback", async () => {
		const { api, ctx, handlers, sendMessage, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		// Trigger the model switch.
		await getEventHandler(handlers, "model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)
		expect(sendMessage).toHaveBeenCalledTimes(1)

		// User opens dialog via Ctrl+R and submits a reason.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "Better at code" })
		await getShortcutHandler(Key.ctrl("r"))?.(ctx)

		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)
		// A SECOND message is sent carrying the reason — we don't mutate the first.
		expect(sendMessage).toHaveBeenCalledTimes(2)
		const followUpCall = sendMessage.mock.calls[1]?.[0] as {
			content?: Array<{ type: string; text?: string }>
			details?: { model?: string; reason?: string }
		}
		expect(followUpCall).toMatchObject({
			customType: "model-switch-feedback",
			display: true,
			details: { model: "Concrete", reason: "Better at code" },
		})
		expect(followUpCall?.content?.[0]?.text).toBe("Reason: Better at code")
		expect(trackModelSwitchFeedbackMock).toHaveBeenCalledWith({
			reason: "Better at code",
			modelName: "Concrete",
			modelId: "concrete-model",
		})
	})

	it("Ctrl+R Esc/empty submit does not send a follow-up message", async () => {
		const { api, ctx, handlers, sendMessage, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		await getEventHandler(handlers, "model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)
		expect(sendMessage).toHaveBeenCalledTimes(1)

		// Empty submit.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "" })
		await getShortcutHandler(Key.ctrl("r"))?.(ctx)

		expect(sendMessage).toHaveBeenCalledTimes(1)
		expect(trackModelSwitchFeedbackMock).not.toHaveBeenCalled()
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toBeNull()

		// Re-trigger model switch, then Esc.
		await getEventHandler(handlers, "model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model-2", name: "Concrete2" },
			},
			ctx,
		)
		modelSwitchDialogMock.show.mockResolvedValueOnce(undefined)
		await getShortcutHandler(Key.ctrl("r"))?.(ctx)

		expect(sendMessage).toHaveBeenCalledTimes(2)
		expect(trackModelSwitchFeedbackMock).not.toHaveBeenCalled()
	})

	it("model_select from non-auto model does not set the invitation", async () => {
		const { api, ctx, handlers } = makeApi()
		feedbackExtension(api)
		const handler = getEventHandler(handlers, "model_select")
		await handler(
			{
				previousModel: { provider: "kimchi-dev", id: "concrete-a", name: "A" },
				model: { provider: "kimchi-dev", id: "concrete-b", name: "B" },
			},
			ctx,
		)
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()
	})

	it("model_select from auto to multi-model does not set the invitation", async () => {
		const { api, ctx, handlers } = makeApi()
		feedbackExtension(api)
		const handler = getEventHandler(handlers, "model_select")
		await handler(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "multi-model", name: "Multi" },
			},
			ctx,
		)
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()
	})

	it("turn_start clears the model-switch invitation", async () => {
		const { api, ctx, handlers } = makeApi()
		feedbackExtension(api)
		const invitationState = await import("./invitation-state.js")
		invitationState.setModelSwitchInvitation({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		await getEventHandler(handlers, "turn_start")({ turnIndex: 1 }, ctx)
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("session_shutdown clears the model-switch invitation", async () => {
		const { api, ctx, handlers } = makeApi()
		feedbackExtension(api)
		const invitationState = await import("./invitation-state.js")
		invitationState.setModelSwitchInvitation({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		await getEventHandler(handlers, "session_shutdown")({ reason: "user_exit" }, ctx)
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("subagent mode: extension is a no-op", () => {
		process.env.KIMCHI_SUBAGENT = "1"
		const { api, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		expect(handlers.has("session_start")).toBe(false)
		expect(api.registerMessageRenderer).not.toHaveBeenCalled()
		expect(api.registerShortcut).not.toHaveBeenCalled()
		expect(getShortcutHandler()).toBeUndefined()
	})

	it("non-TUI mode: shortcut handlers are no-ops", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		ctx.mode = "rpc"
		ctx.hasUI = true
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("headless mode (no UI): shortcut handlers are no-ops", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		ctx.hasUI = false
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("session_shutdown resets state so subsequent shortcut presses are no-ops", async () => {
		const { api, ctx, handlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getEventHandler(handlers, "agent_end")({}, ctx)
		await getEventHandler(handlers, "session_shutdown")({ reason: "user_exit" }, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})
})
