import type { Api, Model } from "@earendil-works/pi-ai"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import {
	type ShowVisionSwitchDialogOptions,
	showVisionSwitchDialog,
	VisionSwitchComponent,
} from "./vision-switch-dialog.js"

beforeAll(() => {
	initTheme("default")
})

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "kimchi-dev",
		id: "vision-model",
		name: "Vision Model",
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

function makeTui(): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { rows: 40, cols: 80 },
	} as unknown as TUI
}

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

interface Harness {
	component: VisionSwitchComponent
	done: ReturnType<typeof vi.fn>
	onSwitch: ReturnType<typeof vi.fn<ShowVisionSwitchDialogOptions["onSwitch"]>>
	candidates: { model: Model<Api>; compactNeeded: boolean }[]
}

function makeHarness(options: {
	candidates?: { model: Model<Api>; compactNeeded?: boolean }[]
	onSwitch?: ShowVisionSwitchDialogOptions["onSwitch"]
}): Harness {
	const candidates = (
		options.candidates ?? [
			{ model: makeModel({ id: "alpha" }), compactNeeded: false },
			{ model: makeModel({ id: "beta", provider: "other" }), compactNeeded: true },
		]
	).map((c) => ({ model: c.model, compactNeeded: c.compactNeeded ?? false }))
	const onSwitch = options.onSwitch ? vi.fn(options.onSwitch) : vi.fn(async () => ({ ok: true as const }))
	const done = vi.fn()
	const component = new VisionSwitchComponent(
		makeTui(),
		makeTheme(),
		{ currentModelId: "text-only", getCandidates: () => candidates, onSwitch },
		done,
	)
	return { component, done, onSwitch, candidates }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

function renderText(component: VisionSwitchComponent, width = 80): string {
	return component.render(width).map(stripAnsi).join("\n")
}

const ENTER = "\r"
const ESCAPE = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const CTRL_R = "\x12"

describe("VisionSwitchComponent render", () => {
	it("renders the header, candidate rows, and footer actions", () => {
		const { component } = makeHarness({})
		const text = renderText(component)
		expect(text).toContain("text-only")
		expect(text).toContain("alpha")
		expect(text).toContain("[kimchi-dev]")
		expect(text).toContain("200k")
		expect(text).toContain("beta")
		expect(text).toContain("· ⚠ compact")
		expect(text).toContain("[Ctrl+R] remove image(s)")
		expect(text).toContain("[Esc] cancel")
	})

	it("does not show the compact badge on fitting rows", () => {
		const { component } = makeHarness({})
		const lines = renderText(component).split("\n")
		const alphaRow = lines.find((l) => l.includes("alpha"))
		expect(alphaRow).toBeDefined()
		expect(alphaRow).not.toContain("compact")
	})

	it("filters candidates by search query over id and provider", () => {
		const { component } = makeHarness({})
		component.handleInput("b")
		component.handleInput("e")
		const text = renderText(component)
		expect(text).toContain("beta")
		expect(text).not.toContain("alpha")
	})

	it("shows an empty-list message but keeps both footer actions available", () => {
		const { component, done } = makeHarness({ candidates: [] })
		const text = renderText(component)
		expect(text).toContain("No vision models available")
		expect(text).toContain("[Ctrl+R] remove image(s)")
		expect(text).toContain("[Esc] cancel")
		// Both actions remain functional.
		component.handleInput(CTRL_R)
		expect(done).toHaveBeenCalledWith({ kind: "remove" })
	})

	it("shows a no-match message when the search filters everything out", () => {
		const { component } = makeHarness({})
		for (const ch of "zzz") component.handleInput(ch)
		expect(renderText(component)).toContain("No matching models")
	})

	it("recomputes candidates per render", () => {
		let candidates: { model: Model<Api>; compactNeeded: boolean }[] = [
			{ model: makeModel({ id: "alpha" }), compactNeeded: false },
		]
		const done = vi.fn()
		const component = new VisionSwitchComponent(
			makeTui(),
			makeTheme(),
			{ currentModelId: "text-only", getCandidates: () => candidates, onSwitch: vi.fn() },
			done,
		)
		expect(renderText(component)).toContain("alpha")
		candidates = [{ model: makeModel({ id: "gamma" }), compactNeeded: true }]
		expect(renderText(component)).toContain("gamma")
		expect(renderText(component)).not.toContain("alpha")
	})
})

describe("VisionSwitchComponent input", () => {
	it("Escape resolves cancel", () => {
		const { component, done } = makeHarness({})
		component.handleInput(ESCAPE)
		expect(done).toHaveBeenCalledWith({ kind: "cancel" })
	})

	it("Ctrl+R resolves remove", () => {
		const { component, done } = makeHarness({})
		component.handleInput(CTRL_R)
		expect(done).toHaveBeenCalledWith({ kind: "remove" })
	})

	it("plain r always belongs to the search input", () => {
		const { component, done } = makeHarness({})
		component.handleInput("r")
		expect(done).not.toHaveBeenCalled()
		expect(renderText(component)).not.toContain("No matching models")
		// The r narrowed the list (no candidate contains "r" here... alpha does not).
	})

	it("Enter on a fitting row performs the injected switch", async () => {
		const onSwitch = vi.fn(async () => ({ ok: true as const }))
		const { component, done } = makeHarness({ onSwitch })
		component.handleInput(ENTER)
		await vi.waitFor(() => expect(done).toHaveBeenCalled())
		expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha" }), { compactConfirmed: false })
		expect(done).toHaveBeenCalledWith({ kind: "switch", model: expect.objectContaining({ id: "alpha" }) })
	})

	it("Enter on a compact-marked row asks for confirmation first", () => {
		const { component, done, onSwitch } = makeHarness({})
		// beta (compact-marked) is the second row.
		component.handleInput(DOWN)
		component.handleInput(ENTER)
		expect(renderText(component)).toContain("⚠ this will compact your context — continue? [y/N]")
		expect(onSwitch).not.toHaveBeenCalled()
		expect(done).not.toHaveBeenCalled()
	})

	it("declining the confirm returns to the list without switching", () => {
		const { component, done, onSwitch } = makeHarness({})
		component.handleInput(DOWN)
		component.handleInput(ENTER)
		component.handleInput(ENTER) // default No
		expect(renderText(component)).not.toContain("continue? [y/N]")
		expect(onSwitch).not.toHaveBeenCalled()
		expect(done).not.toHaveBeenCalled()
	})

	it("accepting the confirm reports compactConfirmed and switches", async () => {
		const onSwitch = vi.fn(async () => ({ ok: true as const }))
		const { component, done } = makeHarness({ onSwitch })
		component.handleInput(DOWN)
		component.handleInput(ENTER)
		component.handleInput("y")
		await vi.waitFor(() => expect(done).toHaveBeenCalled())
		expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: "beta" }), {
			compactConfirmed: true,
		})
		expect(done).toHaveBeenCalledWith({ kind: "switch", model: expect.objectContaining({ id: "beta" }) })
	})

	it("a failed switch shows an inline error and keeps the dialog open", async () => {
		const onSwitch = vi.fn(async () => ({ ok: false, error: "No API key available for other/beta." }))
		const { component, done } = makeHarness({ onSwitch })
		component.handleInput(ENTER) // alpha, fitting
		await vi.waitFor(() => expect(onSwitch).toHaveBeenCalled())
		expect(renderText(component)).toContain("No API key available for other/beta.")
		expect(done).not.toHaveBeenCalled()
	})

	it("blocks duplicate selection, removal, and cancellation while busy", async () => {
		let resolveSwitch: (outcome: { ok: boolean; error?: string }) => void = () => {}
		const onSwitch = vi.fn(
			() =>
				new Promise<{ ok: boolean }>((resolve) => {
					resolveSwitch = resolve
				}),
		)
		const { component, done } = makeHarness({ onSwitch })
		component.handleInput(ENTER)
		expect(renderText(component)).toContain("Switching…")
		// Busy: everything is blocked.
		component.handleInput(ENTER)
		component.handleInput(CTRL_R)
		component.handleInput(ESCAPE)
		expect(onSwitch).toHaveBeenCalledTimes(1)
		expect(done).not.toHaveBeenCalled()
		resolveSwitch({ ok: true })
		await vi.waitFor(() => expect(done).toHaveBeenCalled())
	})

	it("navigates with wrap-around", () => {
		const { component } = makeHarness({})
		component.handleInput(UP) // wraps to the last row
		const text = renderText(component)
		expect(text).toContain("→ beta")
	})

	it("backspace edits the search query", () => {
		const { component } = makeHarness({})
		component.handleInput("z")
		expect(renderText(component)).toContain("No matching models")
		component.handleInput("\x7f")
		expect(renderText(component)).toContain("alpha")
	})
})

describe("showVisionSwitchDialog", () => {
	it("opens as a centered overlay and registers a close handle", async () => {
		const custom = vi.fn().mockResolvedValue({ kind: "cancel" })
		const ctx = createContext({ ui: { custom } })
		let registered: (() => void) | undefined

		const result = await showVisionSwitchDialog(ctx, {
			currentModelId: "text-only",
			getCandidates: () => [],
			registerClose: (close) => {
				registered = close
			},
			onSwitch: vi.fn(),
		})

		expect(result).toEqual({ kind: "cancel" })
		expect(custom).toHaveBeenCalledTimes(1)
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", maxHeight: "40%" },
		})
		// The factory registers the close handle with the component's done.
		const factory = custom.mock.calls[0]?.[0] as (
			tui: TUI,
			theme: Theme,
			kb: unknown,
			done: (r: unknown) => void,
		) => unknown
		const done = vi.fn()
		factory(makeTui(), makeTheme(), undefined, done)
		expect(registered).toBeTypeOf("function")
		registered?.()
		expect(done).toHaveBeenCalledWith({ kind: "cancel" })
	})
})
