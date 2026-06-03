import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import surveysExtension from "./index.js"
import { _resetSurveyStateForTests } from "./survey.js"

vi.mock("../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

const trackSurveyShown = vi.fn()
const trackSurveyAnswered = vi.fn()
const trackSurveyDismissed = vi.fn()

vi.mock("../telemetry/index.js", () => ({
	trackSurveyShown: (...args: unknown[]) => trackSurveyShown(...args),
	trackSurveyAnswered: (...args: unknown[]) => trackSurveyAnswered(...args),
	trackSurveyDismissed: (...args: unknown[]) => trackSurveyDismissed(...args),
}))

type Handler = (...args: unknown[]) => Promise<void> | void

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	return { on, handlers, api: { on } as unknown as ExtensionAPI }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[0]
}

function theme(): Theme {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
		getFgAnsi: vi.fn(),
		getBgAnsi: vi.fn(),
		fgColors: {},
		bgColors: {},
		mode: "dark",
		preproc: vi.fn(),
		extensions: {},
	} as unknown as Theme
}

function createSurveyCtx(input = "\r", hasUI = true) {
	const custom = vi.fn(async (factory: (...args: unknown[]) => Component & { handleInput?(data: string): void }) => {
		let result: unknown
		const component = factory({ requestRender: vi.fn() } as unknown as TUI, theme(), {}, (value: unknown) => {
			result = value
		})
		component.render(80)
		component.handleInput?.(input)
		return result
	})
	return {
		hasUI,
		ui: {
			custom,
			notify: vi.fn(),
		},
	}
}

describe("surveysExtension", () => {
	afterEach(() => {
		_resetSurveyStateForTests()
		vi.clearAllMocks()
	})

	it("shows and answers the survey after the third standard coding prompt finishes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-surveys-"))
		const configPath = join(tempDir, "config.json")
		try {
			const { handlers, api } = createMockApi()
			surveysExtension({ configPath, now: () => new Date("2026-05-27T10:00:00Z") })(api)
			const extCtx = createSurveyCtx()
			await getHandler(handlers, "session_start")({}, extCtx)

			await getHandler(handlers, "input")({ type: "input", text: "one", source: "interactive" }, extCtx)
			await getHandler(handlers, "agent_end")({ messages: [] }, extCtx)
			await getHandler(handlers, "input")({ type: "input", text: "nested", source: "extension" }, extCtx)
			await getHandler(handlers, "input")({ type: "input", text: "two", source: "interactive" }, extCtx)
			await getHandler(handlers, "agent_end")({ messages: [] }, extCtx)
			await getHandler(handlers, "input")({ type: "input", text: "three", source: "rpc" }, extCtx)
			await getHandler(handlers, "agent_end")({ messages: [] }, extCtx)
			await Promise.resolve()

			expect(extCtx.ui.custom).toHaveBeenCalledTimes(1)
			expect(trackSurveyShown).toHaveBeenCalledWith(expect.objectContaining({ trigger: "third_coding_prompt" }))
			expect(trackSurveyAnswered).toHaveBeenCalledWith(
				expect.objectContaining({
					answerId: "worked_great",
					submissionId: expect.any(String),
					trigger: "third_coding_prompt",
				}),
			)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("registers no hooks when the survey has already been seen", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-surveys-"))
		const configPath = join(tempDir, "config.json")
		try {
			writeFileSync(
				configPath,
				JSON.stringify({
					surveys: {
						"019e87cc-5033-0000-d9bd-5e6501640b6e": {
							seenAt: "2026-05-27T10:00:00.000Z",
						},
					},
				}),
			)
			const { handlers, api } = createMockApi()

			surveysExtension({ configPath })(api)

			expect(handlers.size).toBe(0)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("shows and sends dismissal telemetry after completed ferment finishes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-surveys-"))
		const configPath = join(tempDir, "config.json")
		try {
			const { handlers, api } = createMockApi()
			surveysExtension({ configPath })(api)
			const extCtx = createSurveyCtx("\x03")
			await getHandler(handlers, "session_start")({}, extCtx)
			await getHandler(
				handlers,
				"tool_execution_end",
			)({
				toolCallId: "t-ferment",
				toolName: "complete_ferment",
				isError: false,
			})
			await getHandler(handlers, "agent_end")({ messages: [] }, extCtx)
			await Promise.resolve()

			expect(extCtx.ui.custom).toHaveBeenCalledTimes(1)
			expect(trackSurveyShown).toHaveBeenCalledWith(expect.objectContaining({ trigger: "ferment_completed" }))
			expect(trackSurveyDismissed).toHaveBeenCalledWith(
				expect.objectContaining({
					trigger: "ferment_completed",
					reason: "ctrl_c",
				}),
			)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("keeps a pending survey trigger until UI is available", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-surveys-"))
		const configPath = join(tempDir, "config.json")
		try {
			const { handlers, api } = createMockApi()
			surveysExtension({ configPath })(api)
			const noUiCtx = createSurveyCtx("\r", false)
			await getHandler(handlers, "session_start")({}, noUiCtx)
			await getHandler(
				handlers,
				"tool_execution_end",
			)({
				toolCallId: "t-ferment",
				toolName: "complete_ferment",
				isError: false,
			})
			await getHandler(handlers, "agent_end")({ messages: [] }, noUiCtx)
			await Promise.resolve()

			const uiCtx = createSurveyCtx()
			await getHandler(handlers, "agent_end")({ messages: [] }, uiCtx)
			await Promise.resolve()

			expect(noUiCtx.ui.custom).not.toHaveBeenCalled()
			expect(uiCtx.ui.custom).toHaveBeenCalledTimes(1)
			expect(trackSurveyShown).toHaveBeenCalledWith(expect.objectContaining({ trigger: "ferment_completed" }))
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})
})
