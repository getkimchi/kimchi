import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusLine } from "../components/status-line.js"
import {
	_invalidateStatusLineConfigCache,
	DEFAULT_STATUS_LINE_PINNED,
	readStatusLineConfig,
	setStatusLineElementHidden,
	setStatusLineElementPinned,
} from "../config/status-line-config.js"
import * as AGENTS from "./agents/index.js"
import customizeStatusLineExtension, { CustomizeStatusLineComponent } from "./customize-status-line-command.js"
import * as FERMENT from "./ferment/index.js"
import * as MULTI_MODEL from "./multi-model.js"
import * as TAGS from "./tags.js"

// ── Real status-line-config backed by in-memory JSON storage ──────────────────
// We don't mock status-line-config.js itself — tests go through the real read/write
// logic so that toggling via setStatusLineElementPinned or handleInput(" ") is reflected in the
// next render() call, exactly as it would be at runtime.

const memfs = new Map<string, string>()
const SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

vi.mock("../config/json.js", () => {
	const memfsRead = (path: string) => {
		const raw = memfs.get(path)
		try {
			return raw ? JSON.parse(raw) : {}
		} catch {
			return {}
		}
	}
	return {
		readJson: memfsRead,
		// The memfs layer has no stat — bypass the signature gate and read
		// directly; caching semantics are covered by json.test.ts.
		readJsonCached: memfsRead,
		writeJson: (path: string, data: unknown) => {
			memfs.set(path, JSON.stringify(data))
		},
		invalidateJsonCache: (_path: string) => {},
	}
})

vi.mock("./shared-status-line.js", () => ({ requestSharedStatusLineRender: vi.fn() }))

// ── Helpers ───────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI = /\x1b\[[\d;]*m/g
const strip = (s: string): string => s.replace(ANSI, "")

function createMockTheme(): Theme {
	const COLOR_CODE: Record<string, string> = {
		dim: "\x1b[2m",
		accent: "\x1b[36m",
		warning: "\x1b[33m",
		error: "\x1b[31m",
		success: "\x1b[32m",
		border: "\x1b[90m",
		text: "\x1b[39m",
		muted: "\x1b[90m",
	}
	const RESET = "\x1b[0m"
	const fg = vi.fn((color: string, s: string) => `${COLOR_CODE[color] ?? "\x1b[39m"}${s}${RESET}`)
	return {
		fg,
		bg: vi.fn(),
		getFgAnsi: vi.fn(() => "\x1b[36m"),
		getBgAnsi: vi.fn(),
		fgColors: {},
		bgColors: {},
		mode: "light",
		preproc: vi.fn(),
		extensions: {},
	} as unknown as Theme
}

interface MockContextOpts {
	percent?: number
	modelId?: string
	assistantMessages?: Array<{ input: number; output: number }>
}

function createMockContext(opts?: MockContextOpts): ExtensionContext {
	const percent = opts?.percent ?? 0
	const modelId = opts?.modelId ?? "claude-opus-4-6"
	const entries = (opts?.assistantMessages ?? []).map((u) => ({
		type: "message" as const,
		message: { role: "assistant", usage: { input: u.input, output: u.output, cost: { total: 0 } } },
	}))
	return {
		model: { id: modelId, name: modelId },
		cwd: "/test",
		getContextUsage: vi.fn(() => ({ tokens: 0, percent, contextWindow: 100000 })),
		sessionManager: {
			getEntries: vi.fn(() => entries),
			getBranch: vi.fn(() => []),
			getSessionId: vi.fn(() => "test-session"),
			getSessionName: vi.fn(() => "test"),
			getSessionFile: vi.fn(() => "/test/session.md"),
		},
	} as unknown as ExtensionContext
}

function createMockStatusLineData(): ReadonlyFooterDataProvider {
	return {
		getExtensionStatuses: vi.fn(() => new Map()),
	} as unknown as ReadonlyFooterDataProvider
}

function stubPlatform(value: NodeJS.Platform): () => void {
	const original = process.platform
	Object.defineProperty(process, "platform", { value })
	return () => Object.defineProperty(process, "platform", { value: original })
}

let theme: Theme
let restorePlatform: () => void

beforeEach(() => {
	memfs.clear()
	memfs.set(SETTINGS_PATH, "{}") // no statusLine key → defaults apply
	_invalidateStatusLineConfigCache()
	theme = createMockTheme()
	restorePlatform = stubPlatform("darwin")
	vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
	vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
	vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
	vi.spyOn(TAGS, "peekActiveTags").mockReturnValue([])
	vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
	vi.spyOn(MULTI_MODEL, "getMultiModelEnabled").mockReturnValue(false)
})

afterEach(() => {
	vi.restoreAllMocks()
	restorePlatform()
	memfs.clear()
})

/** Render the status line bar at width 200 and strip ANSI codes. */
function renderStatusLine(ctxOpts?: MockContextOpts): string {
	const lines = new StatusLine(createMockContext(ctxOpts), theme, createMockStatusLineData()).render(200)
	return strip(lines[lines.length - 1] ?? "")
}

/** Render the customize popover at width 80. */
function makeComponent(selectedIndex = 2): CustomizeStatusLineComponent {
	return new CustomizeStatusLineComponent(selectedIndex, { requestRender: vi.fn() }, vi.fn(), theme)
}

// ── 1. Status line bar: default content ──────────────────────────────────────

describe("status line bar: default content", () => {
	it("shows context bar (pinned by default)", () => {
		expect(renderStatusLine()).toContain("ctx")
	})

	it("shows agents count when agents are active (pinned by default)", () => {
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(2)
		expect(renderStatusLine()).toContain("2 agents")
	})

	it("shows token usage arrows when there is activity (pinned by default)", () => {
		const visible = renderStatusLine({ assistantMessages: [{ input: 1200, output: 340 }] })
		expect(visible).toContain("↑")
		expect(visible).toContain("↓")
	})

	it("does not show ferment section without an active ferment", () => {
		expect(renderStatusLine()).not.toContain("Ferment:")
	})

	it("does not show tags section without active tags", () => {
		expect(renderStatusLine()).not.toContain("env:")
	})
})

// ── 2. Status line bar: toggling ──────────────────────────────────────────────

describe("status line bar: toggling", () => {
	it("context always renders regardless of pinned writes — it is a hardcoded core element", () => {
		setStatusLineElementPinned("context", false)
		expect(renderStatusLine()).toContain("ctx")
		setStatusLineElementPinned("context", true)
		expect(renderStatusLine()).toContain("ctx")
	})

	it("pinning ferment with an active ferment shows it in the status line", () => {
		const ferment = {
			id: "f-1",
			name: "my-ferment",
			status: "running",
			mode: "yolo",
			phases: [],
			activePhaseId: undefined,
		} as unknown as ReturnType<typeof FERMENT.getActiveFerment>
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(ferment)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getFermentContinuationPolicy").mockReturnValue("manual")
		setStatusLineElementPinned("ferment", true)
		expect(renderStatusLine()).toContain("Ferment:")
	})

	it("unpinning the togglable defaults hides them; hardcoded context still renders", () => {
		for (const id of DEFAULT_STATUS_LINE_PINNED) setStatusLineElementPinned(id, false)
		const visible = renderStatusLine()
		expect(visible).not.toContain("agent")
		expect(visible).not.toContain("↑")
		expect(visible).not.toContain("thinking")
		// Context is no longer togglable: it survives unpinning.
		expect(visible).toContain("ctx")
	})
})

// ── 3. Customize-status-line popover ──────────────────────────────────────────

describe("customize-status-line popover", () => {
	it("default state: default-pinned elements show '● ElementLabel'", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("● Agents")
		expect(text).toContain("● Thinking level")
		expect(text).toContain("○ Phase")
		expect(text).toContain("● Token I/O")
	})

	it("default state: non-default elements show '○ ElementLabel'", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("○ Ferment")
		expect(text).toContain("○ Tags")
		expect(text).toContain("○ Team")
	})

	it("default state: non-toggleable elements show '× ElementLabel'", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("× Permissions mode")
		expect(text).toContain("× Model")
		expect(text).toContain("× Context")
	})

	it("pressing space on ferment pins it: popover shows '● Ferment' AND status line bar shows ferment", () => {
		const ferment = {
			id: "f-1",
			name: "my-ferment",
			status: "running",
			mode: "yolo",
			phases: [],
			activePhaseId: undefined,
		} as unknown as ReturnType<typeof FERMENT.getActiveFerment>
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(ferment)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getFermentContinuationPolicy").mockReturnValue("manual")

		const component = makeComponent(3) // ferment at STATUS_LINE_ELEMENTS index 3
		component.handleInput(" ") // pin ferment

		expect(strip(component.render(80).join("\n"))).toContain("● Ferment")
		expect(renderStatusLine()).toContain("Ferment:")
	})

	it("pressing space on context is a no-op: context is a hardcoded core element and always renders", () => {
		const component = makeComponent(5) // context at STATUS_LINE_ELEMENTS index 5
		component.handleInput(" ")

		expect(strip(component.render(80).join("\n"))).toContain("× Context")
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
		expect(renderStatusLine()).toContain("ctx")
	})
})

// ── 4. defaultVisible rows (LSP/DAP): hide via `hidden`, not `pinned` ──────

describe("customize-status-line popover: defaultVisible LSP/DAP rows", () => {
	it("shows LSP and DAP rows checked (●) by default", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("● LSP")
		expect(text).toContain("● DAP")
	})

	it("pressing space on LSP hides it: row goes ○, settings gain hidden:[lsp], pinned untouched", () => {
		const component = makeComponent(12) // lsp at STATUS_LINE_ELEMENTS index 12
		component.handleInput(" ")

		expect(strip(component.render(80).join("\n"))).toContain("○ LSP")
		expect(readStatusLineConfig().hidden).toEqual(["lsp"])
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
	})

	it("pressing space on LSP again restores it without touching pinned", () => {
		const component = makeComponent(12)
		component.handleInput(" ")
		component.handleInput(" ")

		expect(strip(component.render(80).join("\n"))).toContain("● LSP")
		expect(readStatusLineConfig().hidden).toEqual([])
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)
	})

	it("pressing space on DAP hides only dap: ○ DAP while LSP stays ●", () => {
		const component = makeComponent(13) // dap at STATUS_LINE_ELEMENTS index 13
		component.handleInput(" ")

		const text = strip(component.render(80).join("\n"))
		expect(text).toContain("○ DAP")
		expect(text).toContain("● LSP")
		expect(readStatusLineConfig().hidden).toEqual(["dap"])
	})

	it("hiding lsp via Space removes its status line segment but keeps dap's", () => {
		const component = makeComponent(12)
		component.handleInput(" ")

		const statuses = new Map([
			["lsp", "LSP:typescript-language-server"],
			["dap", "DAP:js-debug"],
		])
		const data = { getExtensionStatuses: () => statuses } as unknown as ReadonlyFooterDataProvider
		const visible = strip(new StatusLine(createMockContext(), theme, data).render(200).at(-1) ?? "")

		expect(visible).not.toContain("typescript-language-server")
		expect(visible).toContain("js-debug")
	})

	it("shows the Branch / PR row checked (●) by default", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("● Branch / PR")
	})

	it("pressing space on Branch / PR hides it: row goes ○ and settings gain hidden:[work-pr]", () => {
		const component = makeComponent(14) // work-pr at STATUS_LINE_ELEMENTS index 14 (last)
		component.handleInput(" ")

		expect(strip(component.render(80).join("\n"))).toContain("○ Branch / PR")
		expect(readStatusLineConfig().hidden).toEqual(["work-pr"])
		expect(readStatusLineConfig().pinned).toEqual(DEFAULT_STATUS_LINE_PINNED)

		component.handleInput(" ") // toggle back
		expect(readStatusLineConfig().hidden).toEqual([])
	})
})

/** Run the command's no-UI branch (hasUI=false) and return the notified text. */
async function runNoUiCommand(): Promise<string> {
	let handler: ((args: string, ctx: unknown) => unknown) | undefined
	const pi = {
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			if (name === "customize-status-line") handler = command.handler
		},
	}
	customizeStatusLineExtension(pi as unknown as ExtensionAPI)
	const notify = vi.fn()
	await handler?.("", { hasUI: false, ui: { notify } })
	return String(vi.mocked(notify).mock.calls[0]?.[0] ?? "")
}

describe("customize-status-line command: no-UI branch", () => {
	it("lists LSP, DAP and Branch / PR rows checked ([●]) by default, core three as [×]", async () => {
		const text = await runNoUiCommand()
		expect(text).toContain("Customize Status Line")
		expect(text).toContain("[●] LSP")
		expect(text).toContain("[●] DAP")
		expect(text).toContain("[●] Branch / PR")
		expect(text).toContain("[×] Context")
	})

	it("mirrors hidden state: [○] LSP after hiding via config, DAP stays [●]", async () => {
		setStatusLineElementHidden("lsp", true)
		const text = await runNoUiCommand()
		expect(text).toContain("[○] LSP")
		expect(text).toContain("[●] DAP")
	})
})

describe("narrow terminals", () => {
	// Regression: border title math produced a negative "─".repeat count below
	// the title width, crashing with RangeError.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 24]) {
		it(`renders without crashing or overflowing at width ${width}`, () => {
			const component = makeComponent(0)
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
