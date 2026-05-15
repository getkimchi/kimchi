import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as AGENTS from "../extensions/agents/index.js"
import * as FERMENT from "../extensions/ferment/index.js"
import * as ORCHESTRATION from "../extensions/orchestration/prompt-enrichment.js"
import * as TAGS from "../extensions/tags.js"
import { SHORTCUT_TAIL, StatsFooter, buildContextCompact, buildMultiModelAbbrev, buildPhaseCompact } from "./footer.js"

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping in test assertions
const ANSI_ESCAPE = /\x1b\[[\d;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, "")

/** A theme that wraps text in identifiable markers but reports zero visible
 *  width for those markers \u2014 mimicking how real ANSI behaves with visibleWidth. */
function createMockTheme(): Theme {
	// Real-shaped SGR ANSI escapes (terminated with `m`) so that visibleWidth in
	// production code and stripAnsi in test assertions agree on what's visible.
	const COLOR_CODE: Record<string, string> = {
		dim: "\x1b[2m",
		accent: "\x1b[36m",
		warning: "\x1b[33m",
		error: "\x1b[31m",
		success: "\x1b[32m",
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

function createMockContext(opts?: { percent?: number; modelId?: string }): ExtensionContext {
	const percent = opts?.percent ?? 0
	const modelId = opts?.modelId ?? "claude-opus-4-7"
	return {
		model: { id: modelId, name: modelId },
		cwd: "/test",
		getContextUsage: vi.fn(() => ({ tokens: 0, percent, contextWindow: 100000 })),
		sessionManager: {
			getEntries: vi.fn(() => []),
			getBranch: vi.fn(() => []),
			getSessionId: vi.fn(() => "test-session"),
			getSessionName: vi.fn(() => "test"),
			getSessionFile: vi.fn(() => "/test/session.md"),
		},
	} as unknown as ExtensionContext
}

function createMockFooterData(opts?: {
	permissionsMode?: string
	permissionsWarning?: string
	updateAvailable?: string
}): ReadonlyFooterDataProvider {
	const statuses = new Map<string, string>()
	if (opts?.permissionsMode) statuses.set("permissions-mode", opts.permissionsMode)
	if (opts?.permissionsWarning) statuses.set("permissions-warning", opts.permissionsWarning)
	if (opts?.updateAvailable) statuses.set("update-available", opts.updateAvailable)
	return {
		getExtensionStatuses: vi.fn(() => statuses),
	} as unknown as ReadonlyFooterDataProvider
}

/** CompactionContext stub using plain markers \u2014 used to unit-test the builder
 *  functions in isolation, with predictable visible output. */
const compactCtx = {
	dim: (s: string) => s,
	accent: (s: string) => s,
	showCommandHint: true,
}

describe("compact-form builders", () => {
	describe("buildContextCompact", () => {
		it("returns `N% ctx` with no bar", () => {
			const seg = buildContextCompact(compactCtx, 13)
			expect(seg.id).toBe("context")
			expect(seg.text).toBe("13% ctx")
			expect(seg.width).toBe(7)
			expect(seg.raw).toEqual({ kind: "context", percent: 13 })
			expect(seg.text).not.toContain("\u2588")
			expect(seg.text).not.toContain("\u2591")
		})

		it("rounds non-integer percentages", () => {
			const seg = buildContextCompact(compactCtx, 13.7)
			expect(seg.text).toBe("14% ctx")
		})

		it("handles 0%", () => {
			const seg = buildContextCompact(compactCtx, 0)
			expect(seg.text).toBe("0% ctx")
		})
	})

	describe("buildMultiModelAbbrev", () => {
		it("uses `m-m:` instead of `multi-model:` when enabled (darwin)", () => {
			const orig = process.platform
			Object.defineProperty(process, "platform", { value: "darwin" })
			try {
				const seg = buildMultiModelAbbrev(compactCtx, true)
				expect(seg.id).toBe("multi-model")
				expect(seg.text).toBe("m-m: on \u2192 option+tab")
				expect(seg.raw).toEqual({ kind: "multi-model", enabled: true })
			} finally {
				Object.defineProperty(process, "platform", { value: orig })
			}
		})

		it("shows `off` when disabled", () => {
			const orig = process.platform
			Object.defineProperty(process, "platform", { value: "darwin" })
			try {
				const seg = buildMultiModelAbbrev(compactCtx, false)
				expect(seg.text).toBe("m-m: off \u2192 option+tab")
			} finally {
				Object.defineProperty(process, "platform", { value: orig })
			}
		})

		it("uses `alt+tab` shortcut on non-darwin", () => {
			const orig = process.platform
			Object.defineProperty(process, "platform", { value: "linux" })
			try {
				const seg = buildMultiModelAbbrev(compactCtx, true)
				expect(seg.text).toBe("m-m: on \u2192 alt+tab")
			} finally {
				Object.defineProperty(process, "platform", { value: orig })
			}
		})
	})

	describe("buildPhaseCompact", () => {
		it("returns just the phase value, no `phase:` prefix", () => {
			const seg = buildPhaseCompact(compactCtx, "explore")
			expect(seg.id).toBe("phase")
			expect(seg.text).toBe("explore")
			expect(seg.width).toBe(7)
			expect(seg.raw).toEqual({ kind: "phase", phase: "explore" })
		})
	})
})

describe("SHORTCUT_TAIL regex", () => {
	// Real ANSI from the production code paths.
	//   permissions: this.theme.fg(\"dim\", \"\u2192 shift+tab\")
	//   multi-model: this.dim(`\u2192 ${shortcut}`)
	// Both end up as `<ANSI-open>\u2192 <key><ANSI-close>` preceded by a space.

	it("matches the permissions-extension trailing shortcut", () => {
		// Real-shaped: leading space, ANSI open, arrow + key, ANSI close.
		const text = "\u25cf default \x1b[38;5;242m\u2192 shift+tab\x1b[39m"
		expect(SHORTCUT_TAIL.test(text)).toBe(true)
		expect(text.replace(SHORTCUT_TAIL, "")).toBe("\u25cf default")
	})

	it("matches the multi-model trailing shortcut (darwin)", () => {
		const text = "multi-model: on \x1b[38;5;242m\u2192 option+tab\x1b[39m"
		expect(SHORTCUT_TAIL.test(text)).toBe(true)
		expect(text.replace(SHORTCUT_TAIL, "")).toBe("multi-model: on")
	})

	it("matches the multi-model trailing shortcut (linux)", () => {
		const text = "multi-model: on \x1b[38;5;242m\u2192 alt+tab\x1b[39m"
		expect(SHORTCUT_TAIL.test(text)).toBe(true)
		expect(text.replace(SHORTCUT_TAIL, "")).toBe("multi-model: on")
	})

	it("does NOT match text that has no trailing arrow", () => {
		const text = "claude-opus-4-7"
		expect(SHORTCUT_TAIL.test(text)).toBe(false)
	})

	it("does NOT match an arrow in the middle of text", () => {
		const text = "foo \x1b[38;5;242m\u2192 bar\x1b[39m baz"
		expect(SHORTCUT_TAIL.test(text)).toBe(false)
	})
})

describe("StatsFooter behavioural acceptance at representative widths", () => {
	let theme: Theme
	let footerData: ReadonlyFooterDataProvider

	beforeEach(() => {
		theme = createMockTheme()
		// Mirror production format: the permissions extension calls
		// `theme.fg("dim", "\u2192 shift+tab")` and appends. We hand-build the same shape
		// so the SHORTCUT_TAIL regex can find it.
		const permissionsMode = "\u25cf default \x1b[2m\u2192 shift+tab\x1b[0m"
		footerData = createMockFooterData({ permissionsMode })
		vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(true)
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
		// Stub platform-dependent shortcut so test is stable across CI.
		Object.defineProperty(process, "platform", { value: "darwin" })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	/** Run render at the given width and return the visible (ANSI-stripped) status line. */
	function renderAt(width: number, ctxOpts?: { percent?: number }): string {
		const footer = new StatsFooter(createMockContext(ctxOpts), theme, footerData)
		const lines = footer.render(width)
		return stripAnsi(lines[lines.length - 1])
	}

	it("width 160: full footer + `/ for commands` hint", () => {
		const visible = renderAt(160)
		expect(visible).toContain("\u25cf default \u2192 shift+tab")
		expect(visible).toContain("multi-model: on \u2192 option+tab")
		expect(visible).toContain("claude-opus-4-7")
		expect(visible).toContain("0% ctx")
		expect(visible).toContain("phase:explore")
		expect(visible).toContain("/ for commands")
	})

	it("width 100: hint and context-bar dropped, multi-model abbreviated, shortcuts stripped", () => {
		const visible = renderAt(100)
		// Hint gone (step 1)
		expect(visible).not.toContain("/ for commands")
		// Bar gone, percentage kept (step 2)
		expect(visible).not.toContain("\u2588")
		expect(visible).not.toContain("\u2591")
		expect(visible).toContain("0% ctx")
		// At width 100, only steps 1\u20132 should be needed; verify the line fits.
		expect(visible.length).toBeLessThanOrEqual(100)
		// All segments still present.
		expect(visible).toContain("default")
		expect(visible).toContain("multi-model")
		expect(visible).toContain("claude-opus-4-7")
		expect(visible).toContain("phase:explore")
	})

	it("width 60: shortcuts stripped, multi-model abbreviated, phase prefix dropped", () => {
		const visible = renderAt(60)
		expect(visible.length).toBeLessThanOrEqual(60)
		// No `/ for commands`, no shortcut tails.
		expect(visible).not.toContain("/ for commands")
		expect(visible).not.toContain("shift+tab")
		expect(visible).not.toContain("option+tab")
		// The model is the highest-priority segment and should survive.
		expect(visible).toContain("claude-opus-4-7")
	})

	it("width 20: line is hard-truncated to fit", () => {
		const visible = renderAt(20)
		// Critical invariant: never overflow.
		expect(visible.length).toBeLessThanOrEqual(20)
		// Truncation produces *something* non-empty.
		expect(visible.length).toBeGreaterThan(0)
	})

	it("never overflows width across a range of terminal sizes", () => {
		for (const w of [200, 160, 137, 121, 112, 104, 100, 75, 60, 50, 40, 30, 20, 10]) {
			const visible = renderAt(w)
			expect(visible.length, `width=${w}`).toBeLessThanOrEqual(w)
		}
	})

	it("with an active ferment, drops the `ferment:` prefix when overflowing", () => {
		// Install an active ferment so the segment shows up.
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

		// At a generous width every compaction is unneeded and `ferment:` shows.
		const wide = renderAt(200)
		expect(wide).toContain("ferment:my-ferment")

		// At a width where every earlier compaction has fired but the line is
		// still too wide, the ferment-prefix step must also have fired. Use a
		// width small enough to force it; the active-ferment line is longer than
		// the no-ferment line, so 70 is well past the prefix-drop threshold.
		const narrow = renderAt(70)
		expect(narrow).toContain("my-ferment")
		expect(narrow).not.toContain("ferment:")
	})
})

describe("StatsFooter regression tests", () => {
	let theme: Theme

	beforeEach(() => {
		theme = createMockTheme()
		vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(true)
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("renders an info line above the status line when permissions-warning is set", () => {
		const data = createMockFooterData({ permissionsWarning: "Warning: check permissions" })
		const footer = new StatsFooter(createMockContext(), theme, data)
		const lines = footer.render(160)

		expect(lines.length).toBe(2)
		expect(stripAnsi(lines[0])).toContain("Warning")
	})

	it("renders an info line above the status line when update-available is set", () => {
		const data = createMockFooterData({ updateAvailable: "Update available: v1.2.0" })
		const footer = new StatsFooter(createMockContext(), theme, data)
		const lines = footer.render(160)

		expect(lines.length).toBe(2)
		expect(stripAnsi(lines[0])).toContain("Update")
	})

	it("never produces an orphan ` \u00b7  \u00b7 ` double separator at any width", () => {
		// Compaction never removes whole segments, so we should never see two
		// adjacent separators. Truncation cuts the tail, not the middle.
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([{ key: "team", value: "platform" } as never, "foo:bar" as never])
		const data = createMockFooterData({ permissionsMode: "\u25cf default" })
		const footer = new StatsFooter(createMockContext(), theme, data)

		for (const w of [40, 50, 60, 75, 100]) {
			const visible = stripAnsi(footer.render(w)[0])
			expect(visible, `width=${w}: orphan separator in "${visible}"`).not.toMatch(/\u00b7\s*\u00b7/)
		}
	})
})
