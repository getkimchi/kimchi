import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INITIAL_SURVEY, InitialSurveyComponent, _resetSurveyStateForTests, showInitialSurvey } from "./survey.js"

const tipWidgetLocationMock = vi.hoisted(() => ({
	restore: vi.fn(),
	set: vi.fn(),
}))

vi.mock("../tips/index.js", () => ({
	setTipWidgetLocation: tipWidgetLocationMock.set,
}))

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

describe("initial survey UI", () => {
	afterEach(() => {
		_resetSurveyStateForTests()
		vi.clearAllMocks()
	})

	beforeEach(() => {
		tipWidgetLocationMock.restore.mockReset()
		tipWidgetLocationMock.set.mockReset()
		tipWidgetLocationMock.set.mockReturnValue(tipWidgetLocationMock.restore)
	})

	it("renders the survey design with Text, Spacer, and SelectList composition", () => {
		let result: unknown
		const surveyTheme = theme()
		const component = new InitialSurveyComponent(surveyTheme, vi.fn(), (value) => {
			result = value
		})

		const lines = component.render(72)
		expect(lines.join("\n")).toContain("How did Kimchi do?")
		expect(lines.join("\n")).toContain("Your feedback helps us improve.")
		expect(lines.join("\n")).toContain("Went great")
		expect(lines.join("\n")).toContain("Mostly worked")
		expect(lines.join("\n").match(/How did Kimchi do\?/g)).toHaveLength(1)
		expect(surveyTheme.fg).toHaveBeenCalledWith("text", "Your feedback helps us improve.")

		component.handleInput("\x1b[B")
		component.handleInput("\r")

		expect(result).toEqual({ kind: "answered", answerId: "mostly_worked" })
	})

	it("dismisses the survey with escape and ctrl+c", () => {
		let escapeResult: unknown
		const escapeComponent = new InitialSurveyComponent(theme(), vi.fn(), (value) => {
			escapeResult = value
		})
		escapeComponent.handleInput("\x1b")
		expect(escapeResult).toEqual({ kind: "dismissed", reason: "escape" })

		let ctrlCResult: unknown
		const ctrlCComponent = new InitialSurveyComponent(theme(), vi.fn(), (value) => {
			ctrlCResult = value
		})
		ctrlCComponent.handleInput("\x03")
		expect(ctrlCResult).toEqual({ kind: "dismissed", reason: "ctrl_c" })
	})

	it("marks the survey seen when rendered and does not show it twice", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-survey-"))
		const configPath = join(tempDir, "config.json")
		const custom = vi.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
			let result: unknown
			const component = factory(
				{ requestRender: vi.fn() } as unknown as TUI,
				theme(),
				{} as Parameters<Parameters<ExtensionContext["ui"]["custom"]>[0]>[2],
				(value: unknown) => {
					result = value
				},
			) as Component & { handleInput?(data: string): void }
			component.render(80)
			component.handleInput?.("\x1b")
			return result
		})
		const ctx = {
			hasUI: true,
			ui: {
				custom,
				notify: vi.fn(),
			},
		} as unknown as ExtensionContext

		try {
			const dismissed = vi.fn()
			const shown = await showInitialSurvey(ctx, {
				configPath,
				now: () => new Date("2026-05-27T10:00:00.000Z"),
				trigger: "third_coding_prompt",
				onDismissed: dismissed,
			})
			const shownAgain = await showInitialSurvey(ctx, {
				configPath,
				trigger: "ferment_completed",
			})

			const raw = JSON.parse(readFileSync(configPath, "utf-8"))
			expect(shown).toBe(true)
			expect(shownAgain).toBe(false)
			expect(custom).toHaveBeenCalledTimes(1)
			expect(raw.surveys[INITIAL_SURVEY.id].seenAt).toBe("2026-05-27T10:00:00.000Z")
			expect(dismissed).toHaveBeenCalledWith("escape", "third_coding_prompt")
			expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
			expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("restores tips when the survey UI fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-survey-"))
		const configPath = join(tempDir, "config.json")
		try {
			const ctx = {
				hasUI: true,
				ui: {
					custom: vi.fn(async () => {
						throw new Error("boom")
					}),
					notify: vi.fn(),
				},
			} as unknown as ExtensionContext

			await expect(showInitialSurvey(ctx, { configPath, trigger: "third_coding_prompt" })).rejects.toThrow("boom")

			expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
			expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
	})
})
