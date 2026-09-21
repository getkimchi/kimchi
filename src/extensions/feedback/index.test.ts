import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, sendTerminalInput } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import feedbackExtension from "./index.js"

/**
 * Ctrl+R is delivered through `ctx.ui.onTerminalInput` (not a registered
 * shortcut) so the key stays unclaimed outside the invitation window. The
 * handler kicks off async work without awaiting, so flush the microtask queue.
 */
async function pressCtrlR(ctx: ExtensionContext): Promise<void> {
	sendTerminalInput(ctx, CTRL_R)
	await new Promise((resolve) => setTimeout(resolve, 0))
}

const CTRL_R = "\x12"

// Shared mocks (see AGENTS.md: do not hand-roll ctx/pi mocks in test files).
function makeApi() {
	const harness = createExtensionApi()
	const ctx = createContext({ hasUI: true, mode: "tui" })
	return { ...harness, ctx }
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
	isPredefinedReason: (reason: string) => reason === "Too slow" || reason === "Solved my task",
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

	it("registers only the rating shortcuts, leaving ctrl+r unclaimed", () => {
		const { api, getRegisteredShortcutKeys, getShortcutDescription } = makeApi()
		feedbackExtension(api)
		expect(api.registerShortcut).toHaveBeenCalledTimes(2)

		const keys = getRegisteredShortcutKeys()
		// ctrl+r is a built-in (app.session.rename); claiming it statically would
		// emit a startup conflict diagnostic for the whole session.
		expect(keys).not.toContain(Key.ctrl("r"))
		expect(keys).toContain(Key.ctrl("1"))
		expect(keys).toContain(Key.ctrl("2"))
		expect(keys).not.toContain(Key.ctrl("t"))
		expect(keys).not.toContain(Key.ctrlShift("up"))
		expect(keys).not.toContain(Key.ctrlShift("down"))

		expect(getShortcutDescription(Key.ctrl("1"))).toBe("Rate response as Good")
		expect(getShortcutDescription(Key.ctrl("2"))).toBe("Rate response as Bad")
	})

	it("does nothing when a rating shortcut is pressed before agent_settled has fired", async () => {
		const { api, ctx, getShortcutHandler } = makeApi()
		feedbackExtension(api)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("Ctrl+1 opens the details dialog with positive sentiment after agent_settled", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce(undefined)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()
	})

	it("Ctrl+2 opens the details dialog with negative sentiment after agent_settled", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })

		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "negative", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "negative",
			reason: "Too slow",
			reasonType: "predefined",
			autoModelUsed: false,
		})
	})

	it("Ctrl+1 with a positive reason submits feedback and tracks it", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: false })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "positive",
			reason: "Solved my task",
			reasonType: "predefined",
			autoModelUsed: false,
		})
	})

	it("Escape in the details dialog cancels and appends no entry or telemetry", async () => {
		const { api, ctx, getHandler, getAppendedEntries, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce(undefined)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(1)
		expect(getAppendedEntries("feedback-summary")).toHaveLength(0)
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()

		// A subsequent Ctrl+2 after the dialog was cancelled should still work —
		// the extension must be back in the "inviting" state.
		getHandler("agent_settled")({}, ctx)
		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(2)
	})

	it("detects auto-model and passes autoModelUsed=true to the details dialog", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		;(ctx as unknown as { model: unknown }).model = { provider: "kimchi-dev", id: "auto", name: "Auto" }
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Auto-model picked the right model" })

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledWith(ctx, { sentiment: "positive", autoModelUsed: true })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith(expect.objectContaining({ autoModelUsed: true }))
	})

	it("returns to idle after the rating flow resolves, accepting new ratings", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Solved my task" })
		await getShortcutHandler(Key.ctrl("1"))?.(ctx)

		// Re-trigger invitation.
		getHandler("agent_settled")({}, ctx)
		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		expect(dialogMock.show).toHaveBeenCalledTimes(2)
		expect(dialogMock.show).toHaveBeenNthCalledWith(2, ctx, { sentiment: "negative", autoModelUsed: false })
	})

	it("resets the invitation on turn_start", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)
		getHandler("turn_start")({ turnIndex: 1 }, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("resets the invitation on session_start so it cannot leak across sessions", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)
		await getHandler("session_start")({ reason: "resume" }, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("does not listen for ctrl+r until a model switch invitation is active", async () => {
		const { api, ctx } = makeApi()
		feedbackExtension(api)

		// No invitation yet: nothing has subscribed, so the key is free for the
		// built-in app.session.rename binding.
		expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled()
		await pressCtrlR(ctx)
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()
	})

	it("stops listening for ctrl+r once the invitation is consumed", async () => {
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)

		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)
		expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1)

		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "faster" })
		await pressCtrlR(ctx)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)

		// A second press after the invitation is gone must not reopen the dialog.
		await pressCtrlR(ctx)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)
	})

	it("registers entry renderers so feedback never enters LLM context", () => {
		const { api, getEntryRenderer } = makeApi()
		feedbackExtension(api)
		// Entry renderers, not message renderers: custom entries are excluded
		// from LLM context, which is what keeps free-form reason text out.
		expect(getEntryRenderer("feedback-summary")).toBeDefined()
		expect(getEntryRenderer("model-switch-feedback")).toBeDefined()
		expect(api.registerMessageRenderer).not.toHaveBeenCalled()
	})

	it("model_select from auto sets the invitation instead of opening dialog immediately", async () => {
		const { api, ctx, getHandler, getAppendedEntries } = makeApi()
		feedbackExtension(api)

		const handler = getHandler("model_select")
		await handler(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)

		// The summary entry is appended, but the dialog is NOT opened.
		const entries = getAppendedEntries<{ model: string; reason: string }>("model-switch-feedback")
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ model: "Concrete", reason: "" })
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()

		// The invitation is now active.
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toMatchObject({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		// Ctrl+R takes precedence over the rating shortcuts.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		await pressCtrlR(ctx)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)
		expect(modelSwitchDialogMock.show).toHaveBeenCalledWith(ctx, { modelName: "Concrete" })
		// Invitation is cleared after the dialog resolves.
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("Ctrl+R does nothing when no model-switch invitation is active", async () => {
		const { api, ctx } = makeApi()
		feedbackExtension(api)

		await pressCtrlR(ctx)
		expect(modelSwitchDialogMock.show).not.toHaveBeenCalled()
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("Ctrl+R submit with a reason sends a follow-up message with reason details and tracks feedback", async () => {
		const { api, ctx, getHandler, getAppendedEntries } = makeApi()
		feedbackExtension(api)

		// Trigger the model switch.
		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)
		expect(getAppendedEntries("model-switch-feedback")).toHaveLength(1)

		// User opens dialog via Ctrl+R and submits a reason.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "Better at code" })
		await pressCtrlR(ctx)

		expect(modelSwitchDialogMock.show).toHaveBeenCalledTimes(1)
		// A SECOND entry is appended carrying the reason — we don't mutate the first.
		const entries = getAppendedEntries<{ model: string; reason: string }>("model-switch-feedback")
		expect(entries).toHaveLength(2)
		expect(entries[1]).toMatchObject({ model: "Concrete", reason: "Better at code" })
		expect(trackModelSwitchFeedbackMock).toHaveBeenCalledWith({
			reason: "Better at code",
			modelName: "Concrete",
			modelId: "concrete-model",
		})
	})

	it("Ctrl+R empty submit consumes the invitation without a follow-up message", async () => {
		const { api, ctx, getHandler, getAppendedEntries } = makeApi()
		feedbackExtension(api)

		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)
		expect(getAppendedEntries("model-switch-feedback")).toHaveLength(1)

		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "" })
		await pressCtrlR(ctx)

		expect(getAppendedEntries("model-switch-feedback")).toHaveLength(1)
		expect(trackModelSwitchFeedbackMock).not.toHaveBeenCalled()
		// An empty submit is a deliberate "no reason" — the invitation is spent.
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("Ctrl+R Esc keeps the invitation usable so the rendered hint stays live", async () => {
		const { api, ctx, getHandler, getAppendedEntries } = makeApi()
		feedbackExtension(api)

		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)

		modelSwitchDialogMock.show.mockResolvedValueOnce(undefined)
		await pressCtrlR(ctx)

		expect(getAppendedEntries("model-switch-feedback")).toHaveLength(1)
		expect(trackModelSwitchFeedbackMock).not.toHaveBeenCalled()
		// The transcript still renders `... (Ctrl+R)`, so the key must still work.
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toMatchObject({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		// Pressing Ctrl+R again reopens the dialog and can still submit.
		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "second try" })
		await pressCtrlR(ctx)

		expect(trackModelSwitchFeedbackMock).toHaveBeenCalledWith({
			reason: "second try",
			modelName: "Concrete",
			modelId: "concrete-model",
		})
	})

	it("model_select from non-auto model does not set the invitation", async () => {
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)
		const handler = getHandler("model_select")
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
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)
		const handler = getHandler("model_select")
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
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)
		const invitationState = await import("./invitation-state.js")
		invitationState.setModelSwitchInvitation({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		await getHandler("turn_start")({ turnIndex: 1 }, ctx)
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("session_shutdown clears the model-switch invitation", async () => {
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)
		const invitationState = await import("./invitation-state.js")
		invitationState.setModelSwitchInvitation({
			modelName: "Concrete",
			modelId: "concrete-model",
		})

		await getHandler("session_shutdown")({ reason: "user_exit" }, ctx)
		expect(invitationState.getModelSwitchInvitation()).toBeNull()
	})

	it("subagent mode: extension is a no-op", () => {
		process.env.KIMCHI_SUBAGENT = "1"
		const { api, getHandlers, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		expect(getHandlers("session_start")).toHaveLength(0)
		expect(api.registerMessageRenderer).not.toHaveBeenCalled()
		expect(api.registerShortcut).not.toHaveBeenCalled()
		expect(getShortcutHandler(Key.ctrl("1"))).toBeUndefined()
	})

	it("non-TUI mode: shortcut handlers are no-ops", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		ctx.mode = "rpc"
		ctx.hasUI = true
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("headless mode (no UI): shortcut handlers are no-ops", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		ctx.hasUI = false
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})

	it("session_shutdown resets state so subsequent shortcut presses are no-ops", async () => {
		const { api, ctx, getHandler, getShortcutHandler } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)
		await getHandler("session_shutdown")({ reason: "user_exit" }, ctx)

		await getShortcutHandler(Key.ctrl("1"))?.(ctx)
		expect(dialogMock.show).not.toHaveBeenCalled()
	})
})

describe("feedbackExtension failure handling", () => {
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

	it("reports a failed rating write instead of rejecting", async () => {
		const { api, ctx, getHandler, getShortcutHandler, appendEntry } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		appendEntry.mockImplementationOnce(() => {
			throw new Error("disk full")
		})

		await expect(getShortcutHandler(Key.ctrl("2"))?.(ctx)).resolves.toBeUndefined()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error")
	})

	it("keeps the rating invitation alive when the write fails so the user can retry", async () => {
		const { api, ctx, getHandler, getShortcutHandler, appendEntry } = makeApi()
		feedbackExtension(api)
		getHandler("agent_settled")({}, ctx)

		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		appendEntry.mockImplementationOnce(() => {
			throw new Error("disk full")
		})
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)

		// A second press must still reach the dialog.
		dialogMock.show.mockResolvedValueOnce({ reason: "Too slow" })
		await getShortcutHandler(Key.ctrl("2"))?.(ctx)
		expect(dialogMock.show).toHaveBeenCalledTimes(2)
		expect(feedbackMock.trackFeedback).toHaveBeenCalledTimes(1)
	})

	it("re-arms the model-switch invitation when recording the reason fails", async () => {
		const { api, ctx, getHandler, appendEntry } = makeApi()
		feedbackExtension(api)

		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)

		modelSwitchDialogMock.show.mockResolvedValueOnce({ reason: "faster" })
		appendEntry.mockImplementationOnce(() => {
			throw new Error("append failed")
		})
		await pressCtrlR(ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("append failed"), "error")
		const invitationState = await import("./invitation-state.js")
		expect(invitationState.getModelSwitchInvitation()).toMatchObject({ modelId: "concrete-model" })
	})

	it("surfaces a rejected Ctrl+R handler rather than leaving it unhandled", async () => {
		const { api, ctx, getHandler } = makeApi()
		feedbackExtension(api)

		await getHandler("model_select")(
			{
				previousModel: { provider: "kimchi-dev", id: "auto", name: "Auto" },
				model: { provider: "kimchi-dev", id: "concrete-model", name: "Concrete" },
			},
			ctx,
		)

		// The dialog itself throws: handleShortcut catches and notifies, so the
		// raw-input handler's `.catch` is the last line of defence.
		modelSwitchDialogMock.show.mockRejectedValueOnce(new Error("overlay crashed"))
		await pressCtrlR(ctx)

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("overlay crashed"), "error")
	})
})
