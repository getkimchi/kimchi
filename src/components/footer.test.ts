import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as AGENTS from "../extensions/agents/index.js"
import * as FERMENT from "../extensions/ferment/index.js"
import * as ORCHESTRATION from "../extensions/prompt-construction/prompt-enrichment.js"
import * as TAGS from "../extensions/tags.js"
import { SHORTCUT_TAIL, StatsFooter, buildContextCompact, buildMultiModelAbbrev, buildPhaseCompact } from "./footer.js"

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping in test assertions
const ANSI_ESCAPE = /\x1b\[[\d;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, "")

/** A theme that wraps text in identifiable markers but reports zero visible
 *  width for those markers — mimicking how real ANSI behaves with visibleWidth. */
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

interface MockContextOpts {
	percent?: number
	modelId?: string
	/** Assistant messages to include in the session, for usage-segment tests. */
	assistantMessages?: Array<{ input: number; output: number }>
}

function createMockContext(opts?: MockContextOpts): ExtensionContext {
	const percent = opts?.percent ?? 0
	const modelId = opts?.modelId ?? "claude-opus-4-7"
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

/** Save the current platform and stub it to `value`. Returns a cleanup fn. */
function stubPlatform(value: NodeJS.Platform): () => void {
	const original = process.platform
	Object.defineProperty(process, "platform", { value })
	return () => Object.defineProperty(process, "platform", { value: original })
}

/** CompactionContext stub using plain markers — used to unit-test the builder
 *  functions in isolation, with predictable visible output. The builders only
 *  rely on dim/accent for ANSI wrapping, so identity functions are safe here
 *  as long as we assert on raw text rather than computed widths against ANSI. */
const compactCtx = {
	dim: (s: string) => s,
	accent: (s: string) => s,
	semantic: (name: string, s: string) => `[${name}:${s}]`,
	showCommandHint: true,
}

describe("compact-form builders", () => {
	describe("buildContextCompact", () => {
		it("returns `N% ctx` with no bar", () => {
			const seg = buildContextCompact(compactCtx, 13)
			expect(seg.id).toBe("context")
			expect(seg.text).toBe("13% ctx")
			expect(seg.width).toBe(7)
			expect(seg.raw).toEqual({ kind: "context", percent: 13, pctColor: undefined })
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

		it("preserves warning color at 75%", () => {
			const seen: Array<[string, string]> = []
			const ctx = {
				...compactCtx,
				semantic: (name: string, s: string) => {
					seen.push([name, s])
					return `[${name}:${s}]`
				},
			}
			const seg = buildContextCompact(ctx, 75, "warning")
			expect(seg.text).toBe("[warning:75%] ctx")
			expect(seen).toEqual([["warning", "75%"]])
			expect(seg.raw).toEqual({ kind: "context", percent: 75, pctColor: "warning" })
		})

		it("preserves error color at 95%", () => {
			const seen: Array<[string, string]> = []
			const ctx = {
				...compactCtx,
				semantic: (name: string, s: string) => {
					seen.push([name, s])
					return `[${name}:${s}]`
				},
			}
			const seg = buildContextCompact(ctx, 95, "error")
			expect(seg.text).toBe("[error:95%] ctx")
			expect(seen).toEqual([["error", "95%"]])
			expect(seg.raw).toEqual({ kind: "context", percent: 95, pctColor: "error" })
		})

		it("falls back to accent when no semantic color", () => {
			const seenAccent: string[] = []
			const seenSemantic: Array<[string, string]> = []
			const ctx = {
				...compactCtx,
				accent: (s: string) => {
					seenAccent.push(s)
					return `[accent:${s}]`
				},
				semantic: (name: string, s: string) => {
					seenSemantic.push([name, s])
					return `[${name}:${s}]`
				},
			}
			const seg = buildContextCompact(ctx, 50)
			expect(seg.text).toBe("[accent:50%] ctx")
			expect(seenAccent).toEqual(["50%"])
			expect(seenSemantic).toEqual([])
			expect(seg.raw).toEqual({ kind: "context", percent: 50, pctColor: undefined })
		})
	})

	describe("buildMultiModelAbbrev", () => {
		it("uses `m-m:` instead of `multi-model:` when enabled", () => {
			const seg = buildMultiModelAbbrev(compactCtx, true)
			expect(seg.id).toBe("multi-model")
			expect(seg.text).toBe("m-m: on \u2192 alt+m")
			expect(seg.raw).toEqual({ kind: "multi-model", enabled: true })
		})

		it("shows `off` when disabled", () => {
			const seg = buildMultiModelAbbrev(compactCtx, false)
			expect(seg.text).toBe("m-m: off \u2192 alt+m")
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
	//   permissions: this.theme.fg("dim", "→ shift+tab")
	//   multi-model: this.dim(`→ ${shortcut}`)
	// Both end up as `<ANSI-open>→ <key><ANSI-close>` preceded by a space.

	it("matches the permissions-extension trailing shortcut", () => {
		const text = "\u25cf default \x1b[38;5;242m\u2192 shift+tab\x1b[39m"
		expect(SHORTCUT_TAIL.test(text)).toBe(true)
		expect(text.replace(SHORTCUT_TAIL, "")).toBe("\u25cf default")
	})

	it("matches the multi-model trailing shortcut", () => {
		const text = "multi-model: on \x1b[38;5;242m\u2192 alt+m\x1b[39m"
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
	let restorePlatform: () => void

	beforeEach(() => {
		theme = createMockTheme()
		// Mirror production format: the permissions extension calls
		// `theme.fg("dim", "→ shift+tab")` and appends. We hand-build the same
		// shape so the SHORTCUT_TAIL regex can find it.
		const permissionsMode = "\u25cf default \x1b[2m\u2192 shift+tab\x1b[0m"
		footerData = createMockFooterData({ permissionsMode })
		vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(true)
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
		// Stub platform-dependent shortcut so tests are stable across CI.
		restorePlatform = stubPlatform("darwin")
	})

	afterEach(() => {
		vi.restoreAllMocks()
		restorePlatform()
	})

	/** Render at the given width and return the status line both raw (with ANSI)
	 *  and visible (ANSI-stripped). Use `visible` for content assertions and
	 *  `visibleWidth(raw)` for width assertions. */
	function renderAt(width: number, ctxOpts?: MockContextOpts): { raw: string; visible: string } {
		const footer = new StatsFooter(createMockContext(ctxOpts), theme, footerData)
		const lines = footer.render(width)
		const raw = lines[lines.length - 1]
		return { raw, visible: stripAnsi(raw) }
	}

	it("width 160: full footer + `/ for commands` hint, padded to width", () => {
		const { raw, visible } = renderAt(160)
		expect(visible).toContain("\u25cf default \u2192 shift+tab")
		expect(visible).toContain("multi-model: on \u2192 alt+m")
		expect(visible).toContain("claude-opus-4-7")
		expect(visible).toContain("0% ctx")
		expect(visible).toContain("phase:explore")
		expect(visible).toContain("/ for commands")
		// When the hint fits, the line is padded to exactly `width` columns
		// (with whitespace between the segments and the right-aligned hint).
		expect(visibleWidth(raw)).toBe(160)
		// The hint sits at the right edge.
		expect(visible.endsWith("/ for commands")).toBe(true)
	})

	it("width 100: hint and context-bar dropped, segments still present", () => {
		const { raw, visible } = renderAt(100)
		// Hint gone (step 1)
		expect(visible).not.toContain("/ for commands")
		// Bar gone, percentage kept (step 2)
		expect(visible).not.toContain("\u2588")
		expect(visible).not.toContain("\u2591")
		expect(visible).toContain("0% ctx")
		// Line fits.
		expect(visibleWidth(raw)).toBeLessThanOrEqual(100)
		// All segments still present (compaction shrinks, never drops).
		expect(visible).toContain("default")
		expect(visible).toContain("multi-model")
		expect(visible).toContain("claude-opus-4-7")
		expect(visible).toContain("phase:explore")
	})

	it("width 60: shortcuts stripped, multi-model abbreviated, phase prefix dropped", () => {
		const { raw, visible } = renderAt(60)
		expect(visibleWidth(raw)).toBeLessThanOrEqual(60)
		expect(visible).not.toContain("/ for commands")
		expect(visible).not.toContain("shift+tab")
		expect(visible).not.toContain("option+tab")
		// multi-model label is abbreviated to `m-m:`.
		expect(visible).toContain("m-m:")
		expect(visible).not.toContain("multi-model:")
		// phase prefix is dropped; value survives.
		expect(visible).toContain("explore")
		expect(visible).not.toContain("phase:")
		// The model is the highest-priority segment and should survive.
		expect(visible).toContain("claude-opus-4-7")
	})

	it("width 20: line is hard-truncated to fit, leftmost content survives", () => {
		const { raw, visible } = renderAt(20)
		// Critical invariant: never overflow.
		expect(visibleWidth(raw)).toBeLessThanOrEqual(20)
		expect(visible.length).toBeGreaterThan(0)
		// Truncation cuts the tail, so the start of the line — beginning with
		// the permissions bullet — must survive. We check it appears somewhere
		// near the front, rather than asserting `startsWith` in case
		// `truncateToWidth` adds an ellipsis or other leading marker.
		expect(visible).toContain("\u25cf")
	})

	it("never overflows width across a range of terminal sizes", () => {
		for (const w of [200, 160, 137, 121, 112, 104, 100, 75, 60, 50, 40, 30, 20, 10]) {
			const { raw } = renderAt(w)
			expect(visibleWidth(raw), `width=${w}`).toBeLessThanOrEqual(w)
		}
	})

	it("never overflows when phase contains wide (CJK) characters", () => {
		// CJK characters are single code units but take TWO visible columns.
		// This is the case `visibleWidth` catches and `.length` would miss.
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("\u63a2\u7d22\u4e2d" as ReturnType<typeof TAGS.getCurrentPhase>)
		for (const w of [200, 100, 60, 40, 20]) {
			const { raw } = renderAt(w)
			expect(visibleWidth(raw), `width=${w}`).toBeLessThanOrEqual(w)
		}
	})

	it("with an active ferment, drops the `ferment:` prefix when overflowing", () => {
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
		expect(wide.visible).toContain("ferment:my-ferment")

		// At a narrow width all earlier compactions have fired and the ferment
		// prefix has also been dropped.
		const narrow = renderAt(70)
		expect(narrow.visible).toContain("my-ferment")
		expect(narrow.visible).not.toContain("ferment:")
	})
})

describe("StatsFooter segment coverage", () => {
	let theme: Theme
	let restorePlatform: () => void

	beforeEach(() => {
		theme = createMockTheme()
		vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(true)
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
		restorePlatform = stubPlatform("darwin")
	})

	afterEach(() => {
		vi.restoreAllMocks()
		restorePlatform()
	})

	function renderVisible(footer: StatsFooter, width: number): string {
		const lines = footer.render(width)
		return stripAnsi(lines[lines.length - 1])
	}

	it("usage segment appears when there are assistant messages with token usage", () => {
		const ctx = createMockContext({
			assistantMessages: [
				{ input: 1200, output: 340 },
				{ input: 800, output: 200 },
			],
		})
		const footer = new StatsFooter(ctx, theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		// Both up- and down-arrow indicators present with formatted counts.
		expect(visible).toContain("\u2191")
		expect(visible).toContain("\u2193")
	})

	it("usage segment is hidden when there is no token activity", () => {
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).not.toContain("\u2191")
		expect(visible).not.toContain("\u2193")
	})

	it("agents segment shows count when active agents present", () => {
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(3)
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).toContain("3 agents")
	})

	it("agents segment uses singular form for count=1", () => {
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(1)
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).toContain("1 agent")
		expect(visible).not.toContain("1 agents")
	})

	it("agents segment is hidden when count is zero", () => {
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).not.toContain("agent")
	})

	it("tags segment shows non-team, non-phase tags", () => {
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue(["env:prod", "region:eu", "team:platform", "phase:explore"])
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).toContain("tags:")
		expect(visible).toContain("env:prod")
		expect(visible).toContain("region:eu")
		// `team` has its own segment, not part of `tags:`.
		// `phase` has its own segment (already in the line as `phase:explore`).
		// `tags:` itself should not list either.
		// We verify by looking at the substring after `tags:` up to the next `·`.
		const tagsIdx = visible.indexOf("tags:")
		const afterTags = visible.slice(tagsIdx)
		const sectionEnd = afterTags.indexOf(" \u00b7 ", "tags:".length)
		const tagsSection = sectionEnd === -1 ? afterTags : afterTags.slice(0, sectionEnd)
		expect(tagsSection).not.toContain("team:")
		// `phase:` may legitimately appear elsewhere as the phase segment, but
		// must not appear inside the tags section.
		expect(tagsSection).not.toContain("phase:")
	})

	it("tags segment is hidden when only team and phase tags are present", () => {
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue(["team:platform", "phase:explore"])
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).not.toContain("tags:")
	})

	it("team segment shows team value", () => {
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue(["team:platform"])
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).toContain("team:")
		expect(visible).toContain("platform")
	})

	it("team segment is hidden when no team tag present", () => {
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue(["env:prod"])
		const footer = new StatsFooter(createMockContext(), theme, createMockFooterData())
		const visible = renderVisible(footer, 200)
		expect(visible).not.toContain("team:")
	})
})

describe("StatsFooter info line", () => {
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

	it("right-aligns update segment when both warning and update are present", () => {
		const data = createMockFooterData({
			permissionsWarning: "Warning: check permissions",
			updateAvailable: "Update available: v1.2.0",
		})
		const footer = new StatsFooter(createMockContext(), theme, data)
		const lines = footer.render(160)

		expect(lines.length).toBe(2)
		const infoLine = stripAnsi(lines[0])
		expect(infoLine).toContain("Warning")
		expect(infoLine).toContain("Update available")
		// Warning is left-aligned, update is right-aligned with spaces between.
		const warningIdx = infoLine.indexOf("Warning")
		const updateIdx = infoLine.indexOf("Update available")
		expect(warningIdx).toBeLessThan(updateIdx)
		// The update segment ends at (or near) the right edge of the width.
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(160)
		expect(infoLine.trimEnd().endsWith("Update available: v1.2.0")).toBe(true)
	})

	it("drops the update segment when there is no room for it after the warning", () => {
		// Warning consumes nearly all of width=30, leaving < update.width + 2 columns.
		const data = createMockFooterData({
			permissionsWarning: "Warning: long permissions message text here",
			updateAvailable: "Update available: v1.2.0",
		})
		const footer = new StatsFooter(createMockContext(), theme, data)
		const lines = footer.render(30)

		expect(lines.length).toBe(2)
		const infoLine = stripAnsi(lines[0])
		// The update segment must not appear; the warning may be truncated.
		expect(infoLine).not.toContain("Update available")
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(30)
	})
})

describe("StatsFooter regression tests", () => {
	let theme: Theme
	let restorePlatform: () => void

	beforeEach(() => {
		theme = createMockTheme()
		vi.spyOn(ORCHESTRATION, "getMultiModelEnabled").mockReturnValue(true)
		vi.spyOn(AGENTS, "getActiveAgentCount").mockReturnValue(0)
		vi.spyOn(FERMENT, "getActiveFerment").mockReturnValue(undefined)
		vi.spyOn(FERMENT, "getCurrentPhaseIndex").mockReturnValue(undefined)
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue([])
		vi.spyOn(TAGS, "getCurrentPhase").mockReturnValue("explore")
		restorePlatform = stubPlatform("darwin")
	})

	afterEach(() => {
		vi.restoreAllMocks()
		restorePlatform()
	})

	it("never produces an orphan ` \u00b7  \u00b7 ` double separator at any width", () => {
		// Compaction never removes whole segments, so we should never see two
		// adjacent separators. Truncation cuts the tail, not the middle.
		vi.spyOn(TAGS, "getActiveTags").mockReturnValue(["team:platform", "env:prod"])
		const data = createMockFooterData({ permissionsMode: "\u25cf default" })
		const footer = new StatsFooter(createMockContext(), theme, data)

		for (const w of [40, 50, 60, 75, 100]) {
			const lines = footer.render(w)
			const visible = stripAnsi(lines[lines.length - 1])
			expect(visible, `width=${w}: orphan separator in "${visible}"`).not.toMatch(/\u00b7\s*\u00b7/)
		}
	})
})
