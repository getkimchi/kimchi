import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusLine } from "../components/status-line.js"
import {
	DEFAULT_STATUS_LINE_PINNED,
	_invalidateStatusLineConfigCache,
	setStatusLineElementPinned,
} from "../config/status-line-config.js"
import * as AGENTS from "./agents/index.js"
import { CustomizeStatusLineComponent } from "./customize-status-line-command.js"
import * as FERMENT from "./ferment/index.js"
import * as ORCHESTRATION from "./prompt-construction/prompt-enrichment.js"
import * as TAGS from "./tags.js"

// ── Real status-line-config backed by in-memory JSON storage ──────────────────
// We don't mock status-line-config.js itself — tests go through the real read/write
// logic so that toggling via setStatusLineElementPinned or handleInput(" ") is reflected in the
// next render() call, exactly as it would be at runtime.

const memfs = new Map<string, string>()
const SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

vi.mock("../config/json.js", () => ({
	readJson: (path: string) => {
		const raw = memfs.get(path)
		try {
			return raw ? JSON.parse(raw) : {}
		} catch {
			return {}
		}
	},
	writeJson: (path: string, data: unknown) => {
		memfs.set(path, JSON.stringify(data))
	},
}))

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
		message: { role: "assistant", usage: { input: u.input, output: u.output } },
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
	vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
	vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
	vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(false)
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
	it("unpinning context removes the ctx segment", () => {
		setStatusLineElementPinned("context", false)
		expect(renderStatusLine()).not.toContain("ctx")
	})

	it("re-pinning context after unpinning restores the ctx segment", () => {
		setStatusLineElementPinned("context", false)
		expect(renderStatusLine()).not.toContain("ctx")
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

	it("unpinning all three defaults shows none of their segments", () => {
		for (const id of DEFAULT_STATUS_LINE_PINNED) setStatusLineElementPinned(id, false)
		const visible = renderStatusLine()
		expect(visible).not.toContain("ctx")
	})
})

// ── 3. Customize-status-line popover ──────────────────────────────────────────

describe("customize-status-line popover", () => {
	it("default state: default-pinned elements show '● ElementLabel'", () => {
		const text = strip(makeComponent().render(80).join("\n"))
		expect(text).toContain("● Context")
		expect(text).toContain("● Agents")
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

		const component = makeComponent(2) // ferment at STATUS_LINE_ELEMENTS index 2
		component.handleInput(" ") // pin ferment

		expect(strip(component.render(80).join("\n"))).toContain("● Ferment")
		expect(renderStatusLine()).toContain("Ferment:")
	})

	it("pressing space on context unpins it: popover shows '○ Context' AND status line bar loses ctx", () => {
		const component = makeComponent(4) // context at STATUS_LINE_ELEMENTS index 4
		component.handleInput(" ") // unpin context (was default-pinned)

		expect(strip(component.render(80).join("\n"))).toContain("○ Context")
		expect(renderStatusLine()).not.toContain("ctx")
	})
})
