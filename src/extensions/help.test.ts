import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import helpExtension from "./help.js"

const keyboardCapabilityMock = vi.hoisted(() => ({ kittySupport: undefined as boolean | undefined }))
vi.mock("./terminal-compat/keyboard-capability.js", () => ({
	getKittyKeyboardSupport: () => keyboardCapabilityMock.kittySupport,
}))

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>
type OverlayFactory = (
	tui: { requestRender: () => void; terminal: { rows: number; cols: number } },
	theme: Theme,
	kb: unknown,
	done: () => void,
) => Component

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme
}

async function mountHelpOverlay(): Promise<Component> {
	let handler: CommandHandler | undefined
	const pi = {
		registerCommand: (_name: string, def: { handler: CommandHandler }) => {
			handler = def.handler
		},
	} as unknown as ExtensionAPI
	helpExtension(pi)
	expect(handler).toBeDefined()

	let component: Component | undefined
	const ctx = {
		mode: "tui",
		ui: {
			custom: vi.fn(async (factory: OverlayFactory) => {
				component = factory({ requestRender: vi.fn(), terminal: { rows: 40, cols: 80 } }, plainTheme(), {}, () => {})
				return undefined
			}),
		},
	} as unknown as ExtensionContext
	await handler?.("", ctx)
	expect(component).toBeDefined()
	return component as Component
}

describe("help overlay — narrow terminals", () => {
	// Regression: border title math produced a negative "─".repeat count below
	// the title width, crashing with RangeError.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 24]) {
		it(`renders without crashing or overflowing at width ${width}`, async () => {
			const component = await mountHelpOverlay()
			let lines: string[] = []
			expect(() => {
				lines = component.render(width)
			}).not.toThrow()
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}
})

describe("help — rating shortcuts", () => {
	async function renderHelp(): Promise<string> {
		const component = await mountHelpOverlay()
		return component.render(80).join("\n")
	}

	it("lists Ctrl+1/Ctrl+2 when the terminal supports the Kitty keyboard protocol", async () => {
		keyboardCapabilityMock.kittySupport = true
		onTestFinished(() => {
			keyboardCapabilityMock.kittySupport = undefined
		})
		const text = await renderHelp()
		expect(text).toMatch(/Ctrl\+1\s+Rate response as Good/)
		expect(text).toMatch(/Ctrl\+2\s+Rate response as Bad/)
	})

	it("lists the Ctrl+R rating picker when the terminal lacks the Kitty keyboard protocol", async () => {
		keyboardCapabilityMock.kittySupport = false
		onTestFinished(() => {
			keyboardCapabilityMock.kittySupport = undefined
		})
		const text = await renderHelp()
		expect(text).toMatch(/Ctrl\+R\s+Rate response \(Good\/Bad picker\)/)
		expect(text).not.toContain("Ctrl+1")
		expect(text).not.toContain("Ctrl+2")
	})
})
