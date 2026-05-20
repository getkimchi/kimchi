import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPromptFormComponent, promptInput, promptSelect } from "./prompt-ui.js"

const tipWidgetLocationMock = vi.hoisted(() => ({
	restore: vi.fn(),
	set: vi.fn(),
}))

vi.mock("../tips/index.js", () => ({
	setTipWidgetLocation: tipWidgetLocationMock.set,
}))

beforeEach(() => {
	tipWidgetLocationMock.restore.mockReset()
	tipWidgetLocationMock.set.mockReset()
	tipWidgetLocationMock.set.mockReturnValue(tipWidgetLocationMock.restore)
})

describe("ferment prompt UI", () => {
	it("hides tips while an input prompt replaces the editor", async () => {
		let resolveInput: (value: string | undefined) => void = () => {}
		const ui = {
			input: vi.fn(
				() =>
					new Promise<string | undefined>((resolve) => {
						resolveInput = resolve
					}),
			),
			setWorkingVisible: vi.fn(),
		}

		const pending = promptInput({ ui }, "What do you want to do?", "Describe it")

		expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
		expect(tipWidgetLocationMock.restore).not.toHaveBeenCalled()
		expect(ui.setWorkingVisible).toHaveBeenCalledWith(false)

		resolveInput("build it")

		await expect(pending).resolves.toBe("build it")
		expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)
		expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
	})

	it("hides tips while a selection prompt replaces the editor", async () => {
		const ui = {
			select: vi.fn(async () => "Start execution  ✓"),
			setWorkingVisible: vi.fn(),
		}

		await expect(promptSelect({ ui }, "Proceed with this plan?", ["Start execution  ✓"])).resolves.toBe(
			"Start execution  ✓",
		)

		expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
		expect(ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
	})
})

// Minimal Theme mock — only methods actually used by createPromptFormComponent are stubbed.
function noopTheme(): Theme {
	return {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
		getColorMode: () => "truecolor" as const,
		getThinkingBorderColor: () => (s: string) => s,
		getBashModeBorderColor: () => (s: string) => s,
	} as unknown as Theme
}

function makeMockTui(): TUI {
	return {
		cursorTo: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
		moveCursor: vi.fn(),
		clearLine: vi.fn(),
		clearScreen: vi.fn(),
		write: vi.fn(),
		eraseDisplay: vi.fn(),
		keybinding: vi.fn(),
		width: 80,
	} as unknown as TUI
}

/** A question with a single-option answer for simple render tests. */
function singleQuestion(
	overrides: Partial<{
		prompt: string
		label: string
		options: { value: string; label: string; description?: string }[]
	}> = {},
) {
	return {
		id: "q1",
		label: "Q1",
		prompt: "Pick one:",
		type: "single" as const,
		options: [{ value: "a", label: "Option A" }],
		allowOther: false,
		required: true,
		...overrides,
	}
}

function renderLines(
	prompt: string,
	width: number,
	questionOverrides: Parameters<typeof singleQuestion>[0] = {},
): string[] {
	const tui = makeMockTui()
	const theme = noopTheme()
	const comp = createPromptFormComponent(
		tui,
		theme,
		[singleQuestion(questionOverrides)],
		undefined,
		undefined,
		() => {},
	)
	return comp.render(width)
}

describe("createPromptFormComponent render wrapping", () => {
	describe("question prompts wrap at terminal width", () => {
		it("short prompt fits on one line", () => {
			const lines = renderLines("Pick one:", 80, { prompt: "Pick one:" })
			// The question prompt may be on any line, but every line must be <= width
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(80)
			}
		})

		it("long prompt wraps to multiple lines, none exceeding width", () => {
			const longPrompt = "A ".repeat(60) // ~120 chars
			const lines = renderLines(longPrompt, 40, { prompt: longPrompt })
			expect(lines.length).toBeGreaterThan(1)
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(40)
			}
		})

		it("very long prompt produces multiple wrapped lines", () => {
			const veryLong = "Word ".repeat(100) // ~500 chars
			const lines = renderLines(veryLong, 60, { prompt: veryLong })
			expect(lines.length).toBeGreaterThan(5)
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(60)
			}
		})

		it("wraps correctly at narrow terminal width", () => {
			const longPrompt = "Some very long question text that exceeds the narrow width".repeat(3)
			const lines = renderLines(longPrompt, 20, { prompt: longPrompt })
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(20)
			}
		})
	})

	describe("option labels wrap at terminal width", () => {
		it("short label fits on one line", () => {
			const lines = renderLines("Pick one:", 80, {
				options: [{ value: "x", label: "Yes" }],
			})
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(80)
			}
		})

		it("long label wraps without exceeding width", () => {
			const longLabel =
				"This is an extremely long option label that should wrap across multiple lines when rendered in the terminal".repeat(
					2,
				)
			const lines = renderLines("Pick one:", 80, {
				options: [{ value: "x", label: longLabel }],
			})
			expect(lines.length).toBeGreaterThan(1)
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(80)
			}
		})

		it("long label at narrow width produces many short lines", () => {
			const longLabel = "Option".repeat(30)
			const lines = renderLines("Pick one:", 30, {
				options: [{ value: "x", label: longLabel }],
			})
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(30)
			}
		})
	})

	describe("option descriptions wrap at terminal width", () => {
		it("short description fits on one line", () => {
			const lines = renderLines("Pick one:", 80, {
				options: [{ value: "x", label: "Opt", description: "Brief." }],
			})
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(80)
			}
		})

		it("long description wraps without exceeding width", () => {
			const longDesc =
				"This is a detailed description that explains what this option does in extensive prose to ensure wrapping works correctly at various terminal widths".repeat(
					3,
				)
			const lines = renderLines("Pick one:", 60, {
				options: [{ value: "x", label: "Opt", description: longDesc }],
			})
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(60)
			}
		})
	})

	describe("width changes produce correct re-wrapping", () => {
		it("narrow width produces more lines than wide width", () => {
			const longPrompt =
				"Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".repeat(2)
			const wide = renderLines(longPrompt, 100, { prompt: longPrompt })
			const narrow = renderLines(longPrompt, 40, { prompt: longPrompt })
			expect(narrow.length).toBeGreaterThan(wide.length)
		})
	})

	describe("edge cases", () => {
		it("empty prompt renders without error", () => {
			expect(() => renderLines("", 80, { prompt: "" })).not.toThrow()
		})

		it("width of 1 still produces valid output", () => {
			const lines = renderLines("Hello world", 1, { prompt: "Hello world" })
			// Each character gets its own line (or word-wrap splits)
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(1)
			}
			expect(lines.length).toBeGreaterThan(1)
		})

		it("very wide terminal produces fewer or equal lines", () => {
			const longPrompt = "A ".repeat(100)
			const wide = renderLines(longPrompt, 200, { prompt: longPrompt })
			const wider = renderLines(longPrompt, 500, { prompt: longPrompt })
			expect(wider.length).toBeLessThanOrEqual(wide.length)
		})
	})
})
