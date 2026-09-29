import type { Api, ImageContent, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import type { VisionSwitchOutcome } from "./vision-switch-dialog.js"

interface RecordedDialogOptions {
	currentModelId: string
	getCandidates: () => unknown[]
	registerClose?: (close: () => void) => void
	onSwitch: (model: Model<Api>, selection: { compactConfirmed: boolean }) => Promise<VisionSwitchOutcome>
}

// The dialog component has its own test file; here it is replaced with a
// recorder so the gate's options (onSwitch, registerClose, getCandidates) can
// be exercised directly and deterministically.
const { mockShowVisionSwitchDialog, dialogCalls } = vi.hoisted(() => {
	const dialogCalls: Array<{
		ctx: unknown
		options: RecordedDialogOptions
		resolve: (result: unknown) => void
	}> = []
	const mockShowVisionSwitchDialog = vi.fn(
		(ctx: unknown, options: RecordedDialogOptions) =>
			new Promise((resolve) => {
				dialogCalls.push({ ctx, options, resolve })
			}),
	)
	return { mockShowVisionSwitchDialog, dialogCalls }
})

vi.mock("./vision-switch-dialog.js", () => ({
	showVisionSwitchDialog: mockShowVisionSwitchDialog,
}))

import {
	__resetVisionGateForTest,
	clearRetained,
	consumePathSuppression,
	getPathSuppression,
	getRetainedSubmission,
	getVisionGateSessionGeneration,
	mergeRetainedSubmission,
	type PathAttachment,
	type RetainedSubmission,
	registerVisionGateSideEffects,
	resetVisionGateState,
	runVisionGate,
	visionGateOnAgentEnd,
} from "./vision-gate.js"

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "kimchi-dev",
		id: "model",
		name: "Model",
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 16_384,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	}
}

const TEXT_MODEL = makeModel({ id: "text-only", input: ["text"] })
const VISION_A = makeModel({ id: "vision-a", contextWindow: 200_000 })
const VISION_SMALL = makeModel({ id: "vision-small", contextWindow: 100_000 })

function img(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" }
}

function path(pathName: string, data: string): PathAttachment {
	return { resolvedPath: pathName, image: img(data) }
}

function makeRecord(overrides: Partial<RetainedSubmission> = {}): RetainedSubmission {
	return {
		text: "look at this",
		incoming: [],
		pasted: [],
		paths: new Map(),
		generation: getVisionGateSessionGeneration(),
		...overrides,
	}
}

interface GateCtxOptions {
	model?: Model<Api>
	usageTokens?: number | null
	inlineCompact?: (() => Promise<unknown>) | null
}

/** Context with a live model getter so switch verification can observe changes. */
function makeGateContext(options: GateCtxOptions = {}): { ctx: ExtensionContext; setModel: (m: Model<Api>) => void } {
	let currentModel = options.model ?? TEXT_MODEL
	const ctx = createContext({
		modelRegistry: { getAvailable: () => [VISION_A, VISION_SMALL] },
		getContextUsage: () => ({ tokens: options.usageTokens === undefined ? 0 : options.usageTokens }),
	})
	Object.defineProperty(ctx, "model", {
		get: () => currentModel,
		configurable: true,
	})
	vi.mocked(ctx.isIdle).mockReturnValue(true)
	if (options.inlineCompact !== null) {
		Object.assign(ctx, { inlineCompact: options.inlineCompact ?? vi.fn(async () => ({})) })
	}
	return { ctx, setModel: (m) => (currentModel = m) }
}

function dialogOptions(index: number): RecordedDialogOptions {
	const call = dialogCalls[index]
	if (!call) throw new Error(`Dialog ${index} was not opened`)
	return call.options
}

function makePi(setModelImpl?: (model: Model<Api>) => Promise<boolean>) {
	const harness = createExtensionApi()
	if (setModelImpl) harness.setModel.mockImplementation(setModelImpl)
	return harness.api
}

/** Simulates the editor holding the restored draft (the real setEditorText does this). */
function mockDraft(ctx: ExtensionContext, text: string): void {
	vi.mocked(ctx.ui.getEditorText).mockReturnValue(text)
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
	__resetVisionGateForTest()
	dialogCalls.length = 0
	mockShowVisionSwitchDialog.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("mergeRetainedSubmission", () => {
	it("gathers a fresh record when nothing is retained", () => {
		const incoming = [img("a")]
		const pending = [img("b")]
		const record = mergeRetainedSubmission({
			text: "hi",
			incoming,
			pending,
			pathMatches: [path("/tmp/x.png", "c")],
			retained: null,
			generation: 3,
		})
		expect(record.incoming).toEqual(incoming)
		expect(record.pasted).toEqual(pending)
		expect([...record.paths.entries()]).toEqual([["/tmp/x.png", img("c")]])
		expect(record.generation).toBe(3)
	})

	it("reuses retained attachments on the same draft without duplicate paths", () => {
		const pastedImg = img("b")
		const retained = makeRecord({
			incoming: [img("a")],
			pasted: [pastedImg],
			paths: new Map([["/tmp/x.png", img("c")]]),
		})
		const record = mergeRetainedSubmission({
			text: retained.text,
			incoming: [],
			pending: [pastedImg], // still pending after the cancel (same reference)
			pathMatches: [path("/tmp/x.png", "c-re-read")],
			retained,
			generation: retained.generation,
		})
		expect(record.incoming).toEqual([img("a")])
		expect(record.pasted).toEqual([pastedImg]) // not duplicated
		expect(record.paths.size).toBe(1)
		expect(record.paths.get("/tmp/x.png")).toEqual(img("c")) // retained wins
	})

	it("refreshes path attachments on a changed draft while retaining explicit attachments", () => {
		const pastedImg = img("b")
		const retained = makeRecord({
			incoming: [img("a")],
			pasted: [pastedImg],
			paths: new Map([
				["/tmp/old.png", img("old")],
				["/tmp/kept.png", img("kept")],
			]),
		})
		const record = mergeRetainedSubmission({
			text: "different text",
			incoming: [img("d")],
			pending: [pastedImg, img("new-paste")],
			pathMatches: [path("/tmp/kept.png", "kept"), path("/tmp/new.png", "new")],
			retained,
			generation: retained.generation,
		})
		expect(record.incoming).toEqual([img("a"), img("d")])
		expect(record.pasted).toEqual([pastedImg, img("new-paste")])
		expect([...record.paths.keys()].sort()).toEqual(["/tmp/kept.png", "/tmp/new.png"])
	})

	it("treats new pastes as distinct additions", () => {
		const pastedImg = img("b")
		const retained = makeRecord({ pasted: [pastedImg] })
		const record = mergeRetainedSubmission({
			text: retained.text,
			incoming: [],
			pending: [pastedImg, img("later")],
			pathMatches: [],
			retained,
			generation: retained.generation,
		})
		expect(record.pasted).toEqual([pastedImg, img("later")])
	})
})

describe("path suppression", () => {
	it("returns nothing when unarmed", () => {
		expect(getPathSuppression("hi", getVisionGateSessionGeneration())).toBeNull()
	})

	it("stays readable until explicitly consumed for the exact draft and generation", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		// Arm via the deferred Remove flow below.
		const retained = makeRecord({ paths: new Map([["/tmp/x.png", img("c")]]) })
		const streaming = runVisionGate({
			pi,
			ctx,
			event: { text: retained.text, streamingBehavior: "steer" },
			record: retained,
		})
		await expect(streaming).resolves.toEqual({ kind: "handled" })
		mockDraft(ctx, retained.text)
		// agent_end → deferred dialog
		visionGateOnAgentEnd(pi, ctx)
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		dialogCalls[0]?.resolve({ kind: "remove" })
		await settle()

		const generation = getVisionGateSessionGeneration()
		expect(getPathSuppression("other draft", generation)).toBeNull() // changed draft invalidates
		expect(getPathSuppression(retained.text, generation + 1)).toBeNull() // generation mismatch invalidates

		// Re-arm and consume once.
		const retained2 = makeRecord({ paths: new Map([["/tmp/y.png", img("e")]]) })
		await runVisionGate({ pi, ctx, event: { text: retained2.text, streamingBehavior: "followUp" }, record: retained2 })
		visionGateOnAgentEnd(pi, ctx)
		await vi.waitFor(() => expect(dialogCalls.length).toBe(2))
		dialogCalls[1]?.resolve({ kind: "remove" })
		await settle()

		const paths = getPathSuppression(retained2.text, getVisionGateSessionGeneration())
		expect(paths).toEqual(new Set(["/tmp/y.png"]))
		expect(getPathSuppression(retained2.text, getVisionGateSessionGeneration())).toEqual(new Set(["/tmp/y.png"]))
		consumePathSuppression(retained2.text, getVisionGateSessionGeneration())
		expect(getPathSuppression(retained2.text, getVisionGateSessionGeneration())).toBeNull()
	})
})

describe("runVisionGate — non-streaming outcomes", () => {
	it("cancel keeps every source retained and restores the exact draft", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord({
			incoming: [img("a")],
			pasted: [img("b")],
			paths: new Map([["/tmp/x.png", img("c")]]),
		})
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith(record.text)
		const retained = getRetainedSubmission()
		expect(retained?.incoming).toEqual([img("a")])
		expect(retained?.pasted).toEqual([img("b")])
		expect(retained?.paths.get("/tmp/x.png")).toEqual(img("c"))
	})

	it("remove clears retention and pending attachments", async () => {
		const { ctx } = makeGateContext()
		const clearPending = vi.fn()
		registerVisionGateSideEffects({ clearPendingAttachments: clearPending })
		const pi = makePi()
		const record = makeRecord({ pasted: [img("b")] })
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		dialogCalls[0]?.resolve({ kind: "remove" })
		await expect(outcome).resolves.toEqual({ kind: "remove" })
		expect(getRetainedSubmission()).toBeNull()
		expect(clearPending).toHaveBeenCalledTimes(1)
	})

	it("switch clears retention and proceeds", async () => {
		const { ctx, setModel } = makeGateContext()
		const pi = makePi(async (m) => {
			setModel(m)
			return true
		})
		const record = makeRecord()
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_A })
		await expect(outcome).resolves.toEqual({ kind: "proceed" })
		expect(getRetainedSubmission()).toBeNull()
	})

	it("ignores a stale dialog result after a session reset", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const closes: Array<() => void> = []
		const record = makeRecord()
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		dialogCalls[0]?.options.registerClose?.(() => {})
		void closes
		// Session replaced while the dialog was open.
		resetVisionGateState()
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_A })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
		// No draft restoration, no retained state, no marker-side effects.
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled()
		expect(getRetainedSubmission()).toBeNull()
	})

	it("closes an open dialog on session reset via the registered close handle", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord()
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		let closed = false
		dialogCalls[0]?.options.registerClose?.(() => {
			closed = true
		})
		resetVisionGateState()
		expect(closed).toBe(true)
		// A late resolution is ignored: the dialog was already invalidated.
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_A })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
		expect(getRetainedSubmission()).toBeNull()
	})

	it("consumes the input with handled and restores the draft when the dialog throws", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord()
		const outcome = runVisionGate({
			pi,
			ctx,
			event: { text: record.text },
			record,
			openDialog: async () => {
				throw new Error("ui exploded")
			},
		})
		await expect(outcome).resolves.toEqual({ kind: "handled" })
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith(record.text)
		expect(getRetainedSubmission()).toEqual(record)
	})

	it("prevents overlapping dialogs: a second gate returns handled and restores", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const first = runVisionGate({ pi, ctx, event: { text: "one" }, record: makeRecord({ text: "one" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))

		const second = await runVisionGate({ pi, ctx, event: { text: "two" }, record: makeRecord({ text: "two" }) })
		expect(second).toEqual({ kind: "handled" })
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith("two")
		expect(dialogCalls.length).toBe(1) // no second dialog

		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(first).resolves.toEqual({ kind: "handled" })
	})
})

describe("runVisionGate — streaming interception", () => {
	it("consumes, restores the draft, notifies, and arms the deferred latch", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord({ pasted: [img("b")] })
		const outcome = await runVisionGate({
			pi,
			ctx,
			event: { text: record.text, streamingBehavior: "steer" },
			record,
		})
		expect(outcome).toEqual({ kind: "handled" })
		expect(dialogCalls.length).toBe(0) // no dialog mid-stream
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith(record.text)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("text-only — switch available when generation finishes"),
			"warning",
		)
		expect(getRetainedSubmission()).toEqual(record)
	})
})

describe("deferred dialog lifecycle (agent_end)", () => {
	it("opens after an armed agent_end and consumes the latch so cancel cannot reopen", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord({ text: "draft" })
		await runVisionGate({ pi, ctx, event: { text: "draft", streamingBehavior: "followUp" }, record })
		mockDraft(ctx, "draft")

		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(1)
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await settle()

		// Cancel retained the draft/attachments and disarmed the latch.
		expect(getRetainedSubmission()).toEqual(record)
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(1) // not reopened
	})

	it("deferred switch keeps the retained draft for an explicit Enter", async () => {
		vi.useFakeTimers()
		const { ctx, setModel } = makeGateContext()
		const pi = makePi(async (m) => {
			setModel(m)
			return true
		})
		const record = makeRecord({ text: "draft", pasted: [img("b")] })
		await runVisionGate({ pi, ctx, event: { text: "draft", streamingBehavior: "steer" }, record })
		mockDraft(ctx, "draft")
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_A })
		await settle()

		// Retained stays so the next Enter merges and consumes the sources.
		expect(getRetainedSubmission()?.text).toBe("draft")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("press Enter to send"), "info")
		clearRetained()
	})

	it("deferred remove arms the one-submission typed-path suppression", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const clearPending = vi.fn()
		registerVisionGateSideEffects({ clearPendingAttachments: clearPending })
		const pi = makePi()
		const record = makeRecord({ text: "see /tmp/x.png", paths: new Map([["/tmp/x.png", img("c")]]) })
		await runVisionGate({ pi, ctx, event: { text: record.text, streamingBehavior: "steer" }, record })
		mockDraft(ctx, record.text)
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		dialogCalls[0]?.resolve({ kind: "remove" })
		await settle()

		expect(getRetainedSubmission()).toBeNull()
		expect(clearPending).toHaveBeenCalledTimes(1)
		expect(getPathSuppression(record.text, getVisionGateSessionGeneration())).toEqual(new Set(["/tmp/x.png"]))
	})

	it("disarms when the restored draft changed before opening", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const pi = makePi()
		await runVisionGate({
			pi,
			ctx,
			event: { text: "draft", streamingBehavior: "steer" },
			record: makeRecord({ text: "draft" }),
		})
		vi.mocked(ctx.ui.getEditorText).mockReturnValue("edited draft")
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(0)
		// Disarmed for good: a later agent_end does not open either.
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(0)
	})

	it("keeps the latch armed while the run is not idle (resumed/retried)", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const pi = makePi()
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		await runVisionGate({
			pi,
			ctx,
			event: { text: "draft", streamingBehavior: "steer" },
			record: makeRecord({ text: "draft" }),
		})
		mockDraft(ctx, "draft")
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(0)

		// The run settles: the next agent_end opens the dialog.
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(1)
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await settle()
	})

	it("disarms when the model already supports vision", async () => {
		vi.useFakeTimers()
		const { ctx, setModel } = makeGateContext()
		const pi = makePi()
		await runVisionGate({
			pi,
			ctx,
			event: { text: "draft", streamingBehavior: "steer" },
			record: makeRecord({ text: "draft" }),
		})
		mockDraft(ctx, "draft")
		setModel(VISION_A)
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(0)
	})

	it("keeps the latch when another dialog owns the screen, then retries", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const pi = makePi()
		const record = makeRecord({ text: "draft" })
		await runVisionGate({ pi, ctx, event: { text: "draft", streamingBehavior: "steer" }, record })
		mockDraft(ctx, "draft")
		// The user resubmitted the same draft before the deferred timer fired,
		// so an input-gate dialog already owns the screen.
		const occupying = runVisionGate({ pi, ctx, event: { text: "draft" }, record: makeRecord({ text: "draft" }) })

		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		// Only the occupying dialog exists; the deferred one was skipped but stays armed.
		expect(dialogCalls.length).toBe(1)

		// The occupying dialog closes; the next agent_end opens the deferred one.
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(occupying).resolves.toEqual({ kind: "handled" })
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(2)
		dialogCalls[1]?.resolve({ kind: "cancel" })
		await settle()
	})

	it("ignores a stale deferred result after a session reset", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const clearPending = vi.fn()
		registerVisionGateSideEffects({ clearPendingAttachments: clearPending })
		const pi = makePi()
		await runVisionGate({
			pi,
			ctx,
			event: { text: "draft", streamingBehavior: "steer" },
			record: makeRecord({ text: "draft", paths: new Map([["/tmp/x.png", img("c")]]) }),
		})
		mockDraft(ctx, "draft")
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		resetVisionGateState()
		dialogCalls[0]?.resolve({ kind: "remove" })
		await settle()
		// No suppression, no pending clear — the stale result was ignored.
		expect(clearPending).not.toHaveBeenCalled()
		expect(getPathSuppression("draft", getVisionGateSessionGeneration())).toBeNull()
	})

	it("never arms for a paste without an intercepted submission", async () => {
		vi.useFakeTimers()
		const { ctx } = makeGateContext()
		const pi = makePi()
		// No streaming interception happened — agent_end must not open anything.
		visionGateOnAgentEnd(pi, ctx)
		await vi.advanceTimersByTimeAsync(1)
		expect(dialogCalls.length).toBe(0)
	})
})

describe("performCheckedSwitch (via the dialog's onSwitch)", () => {
	it("succeeds after setModel persists and the live model matches", async () => {
		const { ctx, setModel } = makeGateContext()
		const pi = makePi(async (m) => {
			setModel(m)
			return true
		})
		const record = makeRecord()
		const outcome = runVisionGate({ pi, ctx, event: { text: record.text }, record })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result).toEqual({ ok: true })
		expect(pi.setModel).toHaveBeenCalledWith(VISION_A, { persist: true })
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_A })
		await expect(outcome).resolves.toEqual({ kind: "proceed" })
	})

	it("fails when setModel returns false (no API key)", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi(async () => false)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("No API key")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails when setModel throws", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi(async () => {
			throw new Error("boom")
		})
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("boom")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails closed when the current context size cannot be determined", async () => {
		const { ctx } = makeGateContext({ usageTokens: null })
		const pi = makePi()
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result).toEqual({ ok: false, error: "Unable to determine the current context size — switch aborted." })
		expect(pi.setModel).not.toHaveBeenCalled()
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails when the live model was reverted by the model_select guard", async () => {
		// setModel resolves true but the live model stays the text-only model.
		const { ctx } = makeGateContext()
		const pi = makePi(async () => true)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("reverted")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("compacts after confirmation when the context does not fit, then verifies fit", async () => {
		let usageTokens: number | null = 300_000
		const inlineCompact = vi.fn(async () => {
			usageTokens = 80_000
		})
		const { ctx, setModel } = makeGateContext({ usageTokens: undefined, inlineCompact })
		// Override the usage getter with the mutable token count.
		Object.assign(ctx, { getContextUsage: () => ({ tokens: usageTokens }) })
		const pi = makePi(async (m) => {
			setModel(m)
			return true
		})
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		// Badge reflects the fresh token count.
		const candidates = dialogOptions(0).getCandidates() as Array<{
			model: Model<Api>
			compactNeeded: boolean
		}>
		const small = candidates.find((c) => c.model.id === "vision-small")
		expect(small?.compactNeeded).toBe(true)

		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: true })
		expect(result).toEqual({ ok: true })
		expect(inlineCompact).toHaveBeenCalledTimes(1)
		dialogCalls[0]?.resolve({ kind: "switch", model: VISION_SMALL })
		await expect(outcome).resolves.toEqual({ kind: "proceed" })
	})

	it("fails after compaction when the context still does not fit", async () => {
		const inlineCompact = vi.fn(async () => ({}))
		const { ctx } = makeGateContext({ usageTokens: 300_000, inlineCompact })
		const pi = makePi(async () => true)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: true })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("still exceeds")
		expect(inlineCompact).toHaveBeenCalledTimes(1)
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails closed when the context size cannot be verified after compaction", async () => {
		let usageTokens: number | null = 300_000
		const inlineCompact = vi.fn(async () => {
			usageTokens = null
		})
		const { ctx } = makeGateContext({ inlineCompact })
		Object.assign(ctx, { getContextUsage: () => ({ tokens: usageTokens }) })
		const pi = makePi()
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: true })
		expect(result).toEqual({
			ok: false,
			error: "Unable to verify the context size after compaction — switch aborted.",
		})
		expect(pi.setModel).not.toHaveBeenCalled()
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails when compaction is needed but the inline adapter is unavailable", async () => {
		const { ctx } = makeGateContext({ usageTokens: 300_000, inlineCompact: null })
		const pi = makePi(async () => true)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: true })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("unavailable")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("fails when compaction throws", async () => {
		const inlineCompact = vi.fn(async () => {
			throw new Error("compaction blew up")
		})
		const { ctx } = makeGateContext({ usageTokens: 300_000, inlineCompact })
		const pi = makePi(async () => true)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: true })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("Compaction failed")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})

	it("refuses unconfirmed compaction when the fresh check needs it", async () => {
		const { ctx } = makeGateContext({ usageTokens: 300_000 })
		const pi = makePi(async () => true)
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_SMALL, { compactConfirmed: false })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("select it again")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})
})

describe("session hygiene", () => {
	it("resetVisionGateState clears retention, suppression, and the latch", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi()
		await runVisionGate({
			pi,
			ctx,
			event: { text: "draft", streamingBehavior: "steer" },
			record: makeRecord({ text: "draft", paths: new Map([["/tmp/x.png", img("c")]]) }),
		})
		expect(getRetainedSubmission()).not.toBeNull()
		resetVisionGateState()
		expect(getRetainedSubmission()).toBeNull()
		expect(getVisionGateSessionGeneration()).toBe(1)
	})

	it("rejects stale generations captured before async work", async () => {
		const { ctx } = makeGateContext()
		const pi = makePi(async (_m) => {
			// The session is replaced while the switch is in flight.
			resetVisionGateState()
			return true
		})
		const outcome = runVisionGate({ pi, ctx, event: { text: "t" }, record: makeRecord({ text: "t" }) })
		await vi.waitFor(() => expect(dialogCalls.length).toBe(1))
		const result = await dialogOptions(0).onSwitch(VISION_A, { compactConfirmed: false })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("Session changed")
		dialogCalls[0]?.resolve({ kind: "cancel" })
		await expect(outcome).resolves.toEqual({ kind: "handled" })
	})
})
