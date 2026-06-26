import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatsFooter } from "../components/footer.js"
import { DEFAULT_FOOTER_PINNED, _invalidateFooterConfigCache, setPinned } from "../config/footer-config.js"
import * as AGENTS from "./agents/index.js"
import { CustomizeFooterComponent } from "./customize-footer-command.js"
import * as FERMENT from "./ferment/index.js"
import * as ORCHESTRATION from "./prompt-construction/prompt-enrichment.js"
import * as TAGS from "./tags.js"

// ── Real footer-config backed by in-memory JSON storage ───────────────────────
// We don't mock footer-config.js itself — tests go through the real read/write
// logic so that toggling via setPinned or handleInput(" ") is reflected in the
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

vi.mock("./shared-footer.js", () => ({ requestSharedFooterRender: vi.fn() }))

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

function createMockFooterData(): ReadonlyFooterDataProvider {
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
	memfs.set(SETTINGS_PATH, "{}") // no footer key → defaults apply
	_invalidateFooterConfigCache()
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

/** Render the footer bar at width 200 and strip ANSI codes. */
function renderFooter(ctxOpts?: MockContextOpts): string {
	const lines = new StatsFooter(createMockContext(ctxOpts), theme, createMockFooterData()).render(200)
	return strip(lines[lines.length - 1] ?? "")
}

/** Render the customize popover at width 80. */
function makeComponent(selectedIndex = 2): CustomizeFooterComponent {
	return new CustomizeFooterComponent(selectedIndex, { requestRender: vi.fn() }, vi.fn(), theme)
}

// ── 1. Footer bar: default content ───────────────────────────────────────────

describe("footer bar: default content", () => {
	it("shows context bar (pinned by default)", () => {
		expect(renderFooter()).toContain("ctx")
	})

	it("shows agents count when agents are active (pinned by default)", () => {
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(2)
		expect(renderFooter()).toContain("2 agents")
	})

	it("shows token usage arrows when there is activity (pinned by default)", () => {
		const visible = renderFooter({ assistantMessages: [{ input: 1200, output: 340 }] })
		expect(visible).toContain("↑")
		expect(visible).toContain("↓")
	})

	it("does not show ferment section without an active ferment", () => {
		expect(renderFooter()).not.toContain("Ferment:")
	})

	it("does not show tags section without active tags", () => {
		expect(renderFooter()).not.toContain("env:")
	})
})

// ── 2. Footer bar: toggling ───────────────────────────────────────────────────

describe("footer bar: toggling", () => {
	it("unpinning context removes the ctx segment", () => {
		setPinned("context", false)
		expect(renderFooter()).not.toContain("ctx")
	})

	it("re-pinning context after unpinning restores the ctx segment", () => {
		setPinned("context", false)
		expect(renderFooter()).not.toContain("ctx")
		setPinned("context", true)
		expect(renderFooter()).toContain("ctx")
	})

	it("pinning ferment with an active ferment shows it in the footer", () => {
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
		setPinned("ferment", true)
		expect(renderFooter()).toContain("Ferment:")
	})

	it("unpinning all three defaults shows none of their segments", () => {
		for (const id of DEFAULT_FOOTER_PINNED) setPinned(id, false)
		const visible = renderFooter()
		expect(visible).not.toContain("ctx")
	})
})

// ── 3. Customize-footer popover ───────────────────────────────────────────────

describe("customize-footer popover", () => {
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

	it("pressing space on ferment pins it: popover shows '● Ferment' AND footer bar shows ferment", () => {
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

		const component = makeComponent(2) // ferment at FOOTER_ELEMENTS index 2
		component.handleInput(" ") // pin ferment

		expect(strip(component.render(80).join("\n"))).toContain("● Ferment")
		expect(renderFooter()).toContain("Ferment:")
	})

	it("pressing space on context unpins it: popover shows '○ Context' AND footer bar loses ctx", () => {
		const component = makeComponent(4) // context at FOOTER_ELEMENTS index 4
		component.handleInput(" ") // unpin context (was default-pinned)

		expect(strip(component.render(80).join("\n"))).toContain("○ Context")
		expect(renderFooter()).not.toContain("ctx")
	})
})
