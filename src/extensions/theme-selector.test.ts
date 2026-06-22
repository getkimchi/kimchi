/**
 * Tests for the /theme extension (theme-selector.ts).
 *
 * Verifies the 1:1 port of the upstream /settings → Theme submenu:
 *   - Preview (arrow keys) calls previewTheme, never setTheme (persistence bug guard).
 *   - Confirm (Enter) calls setTheme; failures call showError with the upstream message.
 *   - Cancel (Esc) restores the original theme via previewTheme, never setTheme.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// All mock state must be vi.hoisted — vi.mock factories run before imports,
// so they cannot reference module-level consts below them.
const mockInstances: {
	Container: MockContainer[]
	SelectList: MockSelectList[]
	Spacer: MockSpacer[]
	Text: MockText[]
} = {
	Container: [],
	SelectList: [],
	Spacer: [],
	Text: [],
}

class MockContainer {
	children: unknown[] = []
	addChild(child: unknown) {
		this.children.push(child)
	}
	render(width: number): string[] {
		return []
	}
	invalidate(): void {}
	constructor() {
		mockInstances.Container.push(this)
	}
}

class MockSelectList {
	static instances: MockSelectList[] = mockInstances.SelectList as unknown as MockSelectList[]
	onSelectionChange?: (item: { value: string; label: string }) => void
	onSelect?: (item: { value: string; label: string }) => void
	onCancel?: () => void
	selectedIndex = 0
	items: { value: string; label: string }[]
	maxVisible: number
	theme: unknown
	layout: unknown
	constructor(items: { value: string; label: string }[], maxVisible: number, theme: unknown, layout: unknown) {
		this.items = items
		this.maxVisible = maxVisible
		this.theme = theme
		this.layout = layout
		MockSelectList.instances.push(this)
	}
	setSelectedIndex(i: number) {
		this.selectedIndex = i
	}
	handleInput?(data: string): void
}

class MockSpacer {
	constructor(_height?: number) {
		mockInstances.Spacer.push(this)
	}
}

class MockText {
	constructor(_text?: string, _x?: number, _y?: number) {
		mockInstances.Text.push(this)
	}
}

vi.mock("@earendil-works/pi-tui", () => ({
	Container: MockContainer,
	SelectList: MockSelectList,
	Spacer: MockSpacer,
	Text: MockText,
	getSelectListTheme: vi.fn(() => undefined),
}))

// Import AFTER mocks are wired.
const themeSelectorExtension = (await import("./theme-selector.js")).default

type RegisteredCommand = {
	name: string
	description?: string
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

function makePi() {
	const commands = new Map<string, RegisteredCommand>()
	const pi = {
		registerCommand: (name: string, cmd: RegisteredCommand) => {
			commands.set(name, cmd)
		},
	}
	return { pi: pi as unknown as ExtensionAPI, commands }
}

type UiMocks = {
	custom: ReturnType<typeof vi.fn>
	getAllThemes: ReturnType<typeof vi.fn>
	setTheme: ReturnType<typeof vi.fn>
	previewTheme: ReturnType<typeof vi.fn>
	showError: ReturnType<typeof vi.fn>
	theme: { name: string }
}

function makeCtx(
	themes: { name: string }[],
	currentThemeName: string,
	setThemeResult: { success: boolean; error?: string } = { success: true },
) {
	const ui: UiMocks = {
		custom: vi.fn(),
		getAllThemes: vi.fn(() => themes),
		setTheme: vi.fn(() => setThemeResult),
		previewTheme: vi.fn(() => ({ success: true })),
		showError: vi.fn(),
		theme: { name: currentThemeName },
	}
	const ctx = { ui, mode: "tui" } as unknown as ExtensionCommandContext
	return { ctx, ui }
}

async function runCommandAndCaptureFactory(
	pi: ExtensionAPI,
	commands: Map<string, RegisteredCommand>,
	ctx: ExtensionCommandContext,
	ui: UiMocks,
) {
	// The extension calls ctx.ui.custom(factory). The factory builds the
	// container + selectList synchronously. Capture both the SelectList
	// (via mockInstances.push) and the factory's `done` callback.
	let capturedDone: ((result: unknown) => void) | undefined
	const renderable = {
		render: vi.fn(() => [] as string[]),
		invalidate: vi.fn(),
		handleInput: vi.fn(),
	}
	ui.custom.mockImplementation(
		(factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => unknown) => {
			capturedDone = vi.fn() as unknown as (result: unknown) => void
			return (
				factory(
					{ requestRender: vi.fn() } as unknown,
					{
						bold: (s: string) => s,
						fg: (_color: string, s: string) => s,
						dim: (s: string) => s,
						muted: (s: string) => s,
						accent: (s: string) => s,
					} as unknown,
					{} as unknown,
					capturedDone,
				) ?? renderable
			)
		},
	)

	const themeCommand = commands.get("theme")
	expect(themeCommand).toBeDefined()
	const handler = (themeCommand as RegisteredCommand).handler
	await handler("", ctx)

	// The factory pushed one SelectList instance; that's the one we wired.
	const selectList = mockInstances.SelectList[mockInstances.SelectList.length - 1]
	expect(selectList).toBeDefined()
	expect(capturedDone).toBeDefined()
	return { selectList: selectList as MockSelectList, done: capturedDone as (result: unknown) => void }
}

describe("theme-selector extension", () => {
	beforeEach(() => {
		mockInstances.Container.length = 0
		mockInstances.SelectList.length = 0
		mockInstances.Spacer.length = 0
		mockInstances.Text.length = 0
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("registers a /theme command", () => {
		const { pi, commands } = makePi()
		themeSelectorExtension(pi)
		expect(commands.has("theme")).toBe(true)
		expect(commands.get("theme")?.description).toBe("Select color theme")
	})

	it("renders the full chrome (border + title + description + list + hint + border)", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }], "light")
		themeSelectorExtension(pi)
		await runCommandAndCaptureFactory(pi, commands, ctx, ui)

		// Container holds: [border, title, spacer, description, spacer,
		//                  selectList, spacer, hint, border]
		// = 9 children total.
		const container = mockInstances.Container[0]
		expect(container.children.length).toBe(9)
		// Title, description, and hint are 3 Text nodes.
		expect(mockInstances.Text.length).toBe(3)
		// Three spacers separate the sections.
		expect(mockInstances.Spacer.length).toBe(3)
	})

	it("passes themes in upstream order without re-sorting", async () => {
		const { pi, commands } = makePi()
		const themes = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }, { name: "delta" }]
		const { ctx, ui } = makeCtx(themes, "beta")
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		expect(selectList.items.map((i) => i.value)).toEqual(["alpha", "beta", "gamma", "delta"])
	})

	it("pre-selects the current theme", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }, { name: "solarized" }], "solarized")
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		expect(selectList.selectedIndex).toBe(2)
	})

	it("uses upstream's maxVisible (10) and layout shape", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }], "light")
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		expect(selectList.maxVisible).toBe(1) // min(items.length, 10)
		expect(selectList.layout).toEqual({ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 })
	})

	it("preview on arrow key calls previewTheme (never setTheme) — persistence bug guard", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }], "light")
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)

		expect(selectList.onSelectionChange).toBeDefined()
		const onSelectionChange = selectList.onSelectionChange as (item: { value: string; label: string }) => void
		onSelectionChange({ value: "dark", label: "dark" })
		expect(ui.previewTheme).toHaveBeenCalledWith("dark")
		// Critical: preview must NOT call setTheme (which would persist).
		expect(ui.setTheme).not.toHaveBeenCalled()
	})

	it("Enter calls setTheme for commit", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }], "light", { success: true })
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		const onSelect = selectList.onSelect as (item: { value: string; label: string }) => void
		onSelect({ value: "dark", label: "dark" })
		expect(ui.setTheme).toHaveBeenCalledWith("dark")
		expect(ui.showError).not.toHaveBeenCalled()
	})

	it("Enter on failed theme calls showError with the upstream message format", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "broken" }], "light", { success: false, error: "bad json" })
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		const onSelect = selectList.onSelect as (item: { value: string; label: string }) => void
		onSelect({ value: "broken", label: "broken" })
		expect(ui.setTheme).toHaveBeenCalledWith("broken")
		expect(ui.showError).toHaveBeenCalledWith('Failed to load theme "broken": bad json\nFell back to dark theme.')
	})

	it("Enter on success does NOT call showError", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }], "light", { success: true })
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)
		const onSelect = selectList.onSelect as (item: { value: string; label: string }) => void
		onSelect({ value: "dark", label: "dark" })
		expect(ui.showError).not.toHaveBeenCalled()
	})

	it("Esc restores original theme via previewTheme (never setTheme)", async () => {
		const { pi, commands } = makePi()
		const { ctx, ui } = makeCtx([{ name: "light" }, { name: "dark" }, { name: "solarized" }], "solarized")
		themeSelectorExtension(pi)
		const { selectList } = await runCommandAndCaptureFactory(pi, commands, ctx, ui)

		expect(selectList.onCancel).toBeDefined()
		const onCancel = selectList.onCancel as () => void
		onCancel()
		expect(ui.previewTheme).toHaveBeenCalledWith("solarized")
		// Critical: cancel must NOT persist via setTheme.
		expect(ui.setTheme).not.toHaveBeenCalled()
	})
})
