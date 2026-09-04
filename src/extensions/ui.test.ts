import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { isBareExitAlias } from "./exit-utils.js"
import uiExtension, {
	__setWorkingAnimatorForTest,
	ctrlCCascadeDecision,
	findNextCompatibleModel,
	holdWorkedForMessage,
	setActivePlanTitle,
	withWorkingHidden,
} from "./ui.js"

// Helper to create a minimal Model mock
function makeModel(id: string, contextWindow: number, input: string[] = ["text", "image"]) {
	return { id, provider: "test", name: id, contextWindow, input } as import("@earendil-works/pi-ai").Model<
		import("@earendil-works/pi-ai").Api
	>
}

function makeUiSessionCtx() {
	return {
		hasUI: true,
		sessionManager: { getSessionId: () => "session-under-test" },
		ui: {
			theme: {
				fg: (_name: string, value: string) => value,
				getFgAnsi: (_name: string) => "",
			},
			setHeader: vi.fn(),
			setFooter: vi.fn(),
			setEditorComponent: vi.fn(),
			setToolsExpanded: vi.fn(),
			onTerminalInput: vi.fn(() => () => {}),
			setWorkingVisible: vi.fn(),
			setWorkingIndicator: vi.fn(),
			setWorkingMessage: vi.fn(),
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
		modelRegistry: { getAvailable: () => [], find: () => undefined },
		model: undefined,
		getContextUsage: () => null,
		isIdle: () => true,
		abort: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as ExtensionContext
}

function createRegisteredPromptEditor(ctx: ExtensionContext) {
	const factory = (ctx.ui.setEditorComponent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Parameters<
		ExtensionContext["ui"]["setEditorComponent"]
	>[0]
	if (!factory) throw new Error("editor factory was not registered")
	return factory(
		{
			requestRender: vi.fn(),
			setShowHardwareCursor: vi.fn(),
			terminal: { rows: 40, cols: 80 },
		} as never,
		{
			borderColor: (s: string) => s,
			selectList: {},
		} as never,
		{
			matches: () => false,
		} as never,
	)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

describe("isBareExitAlias", () => {
	it("returns true for exact 'exit' input", () => {
		expect(isBareExitAlias("exit")).toBe(true)
	})

	it("returns true for 'exit' with leading/trailing whitespace", () => {
		expect(isBareExitAlias("  exit  ")).toBe(true)
		expect(isBareExitAlias("\texit\n")).toBe(true)
		expect(isBareExitAlias("  exit")).toBe(true)
		expect(isBareExitAlias("exit  ")).toBe(true)
	})

	it("returns false for '/exit' command", () => {
		expect(isBareExitAlias("/exit")).toBe(false)
	})

	it("returns false for 'EXIT' (case sensitive)", () => {
		expect(isBareExitAlias("EXIT")).toBe(false)
		expect(isBareExitAlias("Exit")).toBe(false)
	})

	it("returns false for empty input", () => {
		expect(isBareExitAlias("")).toBe(false)
		expect(isBareExitAlias("   ")).toBe(false)
	})

	it("returns false for other text", () => {
		expect(isBareExitAlias("hello")).toBe(false)
		expect(isBareExitAlias("exit now")).toBe(false)
		expect(isBareExitAlias("please exit")).toBe(false)
		expect(isBareExitAlias("quit")).toBe(false)
	})
})

describe("ctrlCCascadeDecision", () => {
	it("returns 'clear' when editor has text (regardless of streaming)", () => {
		expect(ctrlCCascadeDecision(true, true)).toBe("clear")
		expect(ctrlCCascadeDecision(true, false)).toBe("clear")
	})

	it("returns 'abort' when no text and agent is streaming", () => {
		expect(ctrlCCascadeDecision(false, true)).toBe("abort")
	})

	it("returns 'exit' when no text and agent is idle", () => {
		expect(ctrlCCascadeDecision(false, false)).toBe("exit")
	})

	it("cascade ordering: clear takes priority over abort", () => {
		// Text + streaming → clear first, not abort
		expect(ctrlCCascadeDecision(true, true)).toBe("clear")
	})

	it("cascade ordering: abort takes priority over exit", () => {
		// No text + streaming → abort, not exit
		expect(ctrlCCascadeDecision(false, true)).toBe("abort")
	})
})

describe("Ctrl+C abort key matching", () => {
	it("matchesKey recognizes Ctrl+C raw byte (\\x03)", () => {
		expect(matchesKey("\x03", Key.ctrl("c"))).toBe(true)
	})

	it("does not match other keys as Ctrl+C", () => {
		expect(matchesKey("\x1b", Key.ctrl("c"))).toBe(false) // Escape
		expect(matchesKey("\r", Key.ctrl("c"))).toBe(false) // Enter
		expect(matchesKey("c", Key.ctrl("c"))).toBe(false) // plain c
	})

	it("matchesKey recognizes Escape separately from Ctrl+C", () => {
		expect(matchesKey("\x1b", Key.escape)).toBe(true)
		expect(matchesKey("\x03", Key.escape)).toBe(false)
	})
})

describe("worked-for message hold", () => {
	afterEach(() => {
		__setWorkingAnimatorForTest(undefined)
		vi.useRealTimers()
	})

	it("suppresses the transient per-turn duration until released", async () => {
		vi.useFakeTimers()
		const harness = createExtensionApi()
		uiExtension(harness.api)
		const setWorkingMessage = vi.fn()
		const ctx = {
			hasUI: true,
			ui: {
				theme: { fg: (_name: string, value: string) => value, getFgAnsi: () => "" },
				setStatus: vi.fn(),
				setWorkingIndicator: vi.fn(),
				setWorkingMessage,
				setWorkingVisible: vi.fn(),
			},
		} as unknown as ExtensionContext

		await harness.getHandler("turn_start")({ type: "turn_start" } as never, ctx)
		setWorkingMessage.mockClear()
		const release = holdWorkedForMessage()
		await harness.getHandler("turn_end")({ type: "turn_end" } as never, ctx)
		expect(setWorkingMessage).not.toHaveBeenCalled()

		release()
		await harness.getHandler("turn_end")({ type: "turn_end" } as never, ctx)
		expect(setWorkingMessage.mock.lastCall?.[0]).toContain("Worked for")
	})
})

describe("active plan title lifecycle", () => {
	afterEach(() => {
		setActivePlanTitle(null)
	})

	it("seeds a prompt editor created after the title is set, then propagates clear", async () => {
		const harness = createExtensionApi()
		uiExtension(harness.api)
		const ctx = makeUiSessionCtx()

		setActivePlanTitle("Cache Layer")
		await harness.getHandler("session_start")({ type: "session_start" } as never, ctx)
		const editor = createRegisteredPromptEditor(ctx)

		expect(stripAnsi(editor.render(80)[1])).toContain("Plan: Cache Layer")

		setActivePlanTitle(null)

		expect(editor.render(80).map(stripAnsi).join("\n")).not.toContain("Plan: Cache Layer")
	})

	it("clears the cached title and current editor on session shutdown", async () => {
		const first = createExtensionApi()
		uiExtension(first.api)
		const firstCtx = makeUiSessionCtx()

		setActivePlanTitle("Old Plan")
		await first.getHandler("session_start")({ type: "session_start" } as never, firstCtx)
		expect(stripAnsi(createRegisteredPromptEditor(firstCtx).render(80)[1])).toContain("Plan: Old Plan")
		for (const handler of first.getHandlers("session_shutdown")) {
			await handler({ type: "session_shutdown" } as never, firstCtx)
		}

		const second = createExtensionApi()
		uiExtension(second.api)
		const secondCtx = makeUiSessionCtx()
		await second.getHandler("session_start")({ type: "session_start" } as never, secondCtx)

		expect(createRegisteredPromptEditor(secondCtx).render(80).map(stripAnsi).join("\n")).not.toContain("Old Plan")
	})
})

describe("findNextCompatibleModel", () => {
	it("returns the next model when current is compatible", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000), makeModel("c", 100_000)]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("wraps around to the start of the list", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, 50_000, false)
		expect(result.model).toBe(models[0])
	})

	it("skips models with insufficient context window and records reason", () => {
		const models = [makeModel("current", 100_000), makeModel("small", 10_000), makeModel("big", 100_000)]
		// currentIndex = 0, currentTokens = 50_000 — "small" at offset 1 doesn't fit, "big" at offset 2 does
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("10K context")
		expect(result.skipped[0].reason).toContain("50K tokens")
	})

	it("skips non-vision models when hasImages is true and records reason", () => {
		const models = [
			makeModel("current-vision", 100_000, ["text", "image"]),
			makeModel("text-only", 100_000, ["text"]),
			makeModel("other-vision", 100_000, ["text", "image"]),
		]
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("no vision support")
	})

	it("returns the first non-vision model when hasImages is false", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("skips both context-window-incompatible AND non-vision models", () => {
		const models = [
			makeModel("current", 100_000, ["text", "image"]),
			makeModel("small-text", 10_000, ["text"]),
			makeModel("no-vision", 100_000, ["text"]),
			makeModel("big-vision", 100_000, ["text", "image"]),
		]
		// currentTokens=50_000 → "small-text" fails context check, "no-vision" fails vision check
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBe(models[3])
		expect(result.skipped).toHaveLength(2)
	})

	it("returns undefined model when no compatible candidate exists (all skipped)", () => {
		const models = [
			makeModel("current", 100_000, ["text", "image"]),
			makeModel("small", 10_000),
			makeModel("text-only", 100_000, ["text"]),
		]
		// 50k tokens exceeds "small"; hasImages=true blocks "text-only"
		const result = findNextCompatibleModel(models, 0, 50_000, true, models[0])
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(2)
		expect(result.skipped[0].reason).toContain("context")
		expect(result.skipped[1].reason).toContain("vision")
	})

	it("allows switching to non-vision models when current model also lacks vision", () => {
		const noVision = makeModel("current-no-vision", 100_000, ["text"])
		const models = [noVision, makeModel("text-only-a", 100_000, ["text"]), makeModel("text-only-b", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, true, noVision)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("blocks non-vision models when current model has vision and images are present", () => {
		const visionModel = makeModel("current-vision", 100_000, ["text", "image"])
		const models = [
			visionModel,
			makeModel("text-only", 100_000, ["text"]),
			makeModel("other-vision", 100_000, ["text", "image"]),
		]
		const result = findNextCompatibleModel(models, 0, 50_000, true, visionModel)
		expect(result.model).toBe(models[2])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("no vision support")
	})

	it("returns empty skipped array for an empty list", () => {
		const result = findNextCompatibleModel([], 0, null, false)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(0)
	})

	it("works when currentIndex is at the last model (wraps to first)", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, null, false)
		expect(result.model).toBe(models[0])
	})

	it("never returns the model at currentIndex (always skips self)", () => {
		const models = [makeModel("only", 100_000)]
		const result = findNextCompatibleModel(models, 0, null, false)
		expect(result.model).toBeUndefined()
	})

	it("skips currentIndex even when it is the only compatible model", () => {
		// Two models: one at currentIndex (compatible) and one incompatible.
		// findNextCompatibleModel should return undefined because the only
		// compatible candidate is at currentIndex itself.
		const models = [makeModel("current", 100_000), makeModel("small", 10_000)]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(1)
	})
})

describe("withWorkingHidden — cooking animator pause/resume", () => {
	afterEach(() => {
		// Reset module-level controller so tests don't leak state into each other.
		__setWorkingAnimatorForTest(undefined)
	})

	function fakeCtx() {
		return {
			ui: {
				setWorkingVisible: vi.fn(),
			},
		}
	}

	it("pauses the working animator before the prompt and resumes after", async () => {
		const order: string[] = []
		const ctx = fakeCtx()
		ctx.ui.setWorkingVisible = vi.fn((v: boolean) => order.push(`setWorkingVisible:${v}`))
		const controller = {
			pause: vi.fn(() => order.push("pause")),
			resume: vi.fn(() => order.push("resume")),
			stop: vi.fn(() => order.push("stop")),
		}
		__setWorkingAnimatorForTest(controller)

		const result = await withWorkingHidden(ctx, async () => {
			order.push("prompt")
			return "ok"
		})

		expect(result).toBe("ok")
		expect(controller.pause).toHaveBeenCalledTimes(1)
		expect(controller.resume).toHaveBeenCalledTimes(1)
		expect(controller.stop).not.toHaveBeenCalled()
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		// Order: pause → setWorkingVisible(false) → prompt → setWorkingVisible(true) → resume
		expect(order).toEqual(["pause", "setWorkingVisible:false", "prompt", "setWorkingVisible:true", "resume"])
	})

	it("resumes the animator even when the prompt throws", async () => {
		const order: string[] = []
		const ctx = fakeCtx()
		ctx.ui.setWorkingVisible = vi.fn((v: boolean) => order.push(`setWorkingVisible:${v}`))
		const controller = {
			pause: vi.fn(() => order.push("pause")),
			resume: vi.fn(() => order.push("resume")),
			stop: vi.fn(),
		}
		__setWorkingAnimatorForTest(controller)

		await expect(
			withWorkingHidden(ctx, async () => {
				order.push("prompt")
				throw new Error("prompt failed")
			}),
		).rejects.toThrow("prompt failed")

		expect(controller.pause).toHaveBeenCalledTimes(1)
		expect(controller.resume).toHaveBeenCalledTimes(1)
		// setWorkingVisible(false) is still called before the prompt,
		// setWorkingVisible(true) is restored in finally.
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		expect(order).toEqual(["pause", "setWorkingVisible:false", "prompt", "setWorkingVisible:true", "resume"])
	})

	it("resumes the animator even when the prompt resolves to undefined", async () => {
		const ctx = fakeCtx()
		const controller = {
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
		}
		__setWorkingAnimatorForTest(controller)

		const result = await withWorkingHidden(ctx, async () => undefined)
		expect(result).toBeUndefined()
		expect(controller.pause).toHaveBeenCalledTimes(1)
		expect(controller.resume).toHaveBeenCalledTimes(1)
	})

	it("does not throw when no controller is registered", async () => {
		__setWorkingAnimatorForTest(undefined)
		const ctx = fakeCtx()
		// No animator registered — pause/resume are no-ops, should not throw.
		await expect(withWorkingHidden(ctx, async () => "ok")).resolves.toBe("ok")
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
	})

	it("works when ctx.ui.setWorkingVisible is absent", async () => {
		const controller = {
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
		}
		__setWorkingAnimatorForTest(controller)
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		const ctx = { ui: undefined as any }
		await expect(withWorkingHidden(ctx, async () => 42)).resolves.toBe(42)
		expect(controller.pause).toHaveBeenCalledTimes(1)
		expect(controller.resume).toHaveBeenCalledTimes(1)
	})

	it("only resumes the animator after the outermost nested prompt finishes", async () => {
		const order: string[] = []
		const ctx = fakeCtx()
		ctx.ui.setWorkingVisible = vi.fn((v: boolean) => order.push(`setWorkingVisible:${v}`))
		const controller = {
			pause: vi.fn(() => order.push("pause")),
			resume: vi.fn(() => order.push("resume")),
			stop: vi.fn(),
		}
		__setWorkingAnimatorForTest(controller)

		const result = await withWorkingHidden(ctx, async () => {
			order.push("outer-prompt")
			return await withWorkingHidden(ctx, async () => {
				order.push("inner-prompt")
				return "nested"
			})
		})

		expect(result).toBe("nested")
		// Only the outermost pause/resume should touch the animator; the inner
		// pair is a depth-based no-op so the animator stays paused until the
		// outer prompt finishes.
		expect(controller.pause).toHaveBeenCalledTimes(1)
		expect(controller.resume).toHaveBeenCalledTimes(1)
		expect(order).toEqual([
			"pause",
			"setWorkingVisible:false",
			"outer-prompt",
			"setWorkingVisible:false",
			"inner-prompt",
			"setWorkingVisible:true",
			"setWorkingVisible:true",
			"resume",
		])
	})
})
