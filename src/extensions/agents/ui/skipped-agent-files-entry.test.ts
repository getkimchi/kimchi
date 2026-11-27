import type { CustomEntry } from "@earendil-works/pi-coding-agent"
import { Container, Spacer, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import {
	createSkippedAgentFilesRenderer,
	SKIPPED_AGENT_FILES_ENTRY,
	type SkippedAgentFilesEntryData,
} from "./skipped-agent-files-entry.js"

const theme = { fg: (_color: string, text: string) => text } as never
// keyText() needs harness keybindings, which vitest does not initialise; the
// real "ctrl+o" hint text is pinned by the TUI e2e test.
const EXPAND = "to expand)"
const COLLAPSE = "to collapse)"

function entry(data: unknown, id = "entry-1"): CustomEntry<SkippedAgentFilesEntryData> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-18T00:00:00.000Z",
		customType: SKIPPED_AGENT_FILES_ENTRY,
		data: data as SkippedAgentFilesEntryData,
	}
}

function render(
	data: unknown,
	{ expanded = false, token = "start-1" }: { expanded?: boolean; token?: string | undefined } = {},
	width = 80,
): string[] | undefined {
	const renderer = createSkippedAgentFilesRenderer(() => token)
	return renderer(entry(data), { expanded }, theme)?.render(width)
}

const one = [{ path: ".kimchi/agents/a.md", reason: "unexpected end of the stream" }]

describe("skipped agent files entry", () => {
	it("collapses to one summary line with the count and the expand hint", () => {
		const lines = render({ token: "start-1", files: one }, {}, 120)

		expect(lines).toHaveLength(1)
		expect(lines?.[0]).toContain("Warning: Skipped 1 agent file with invalid frontmatter (not loaded)")
		expect(lines?.[0]).toContain(EXPAND)
		// Column 1, like pi's own "Warning:" notices — a custom entry is
		// otherwise drawn at column 0 and reads one cell left of them.
		expect(lines?.[0]?.startsWith(" Warning: Skipped 1 agent file")).toBe(true)
		// The marker trails the sentence and points right while it is closed.
		expect(lines?.[0]).toContain("(not loaded) ▸ ")
		// The hint is right-aligned: it ends at the terminal edge.
		expect(visibleWidth(lines?.[0] ?? "")).toBe(120)
		expect(lines?.[0]?.endsWith(EXPAND)).toBe(true)
		expect(lines?.[0]).not.toContain("a.md")
	})

	it("truncates the summary but keeps the hint when the line does not fit", () => {
		// 80 columns minus the hint leaves less than the full sentence.
		const lines = render({ token: "start-1", files: one }) ?? []

		expect(visibleWidth(lines[0])).toBe(80)
		expect(lines[0]).toContain(EXPAND)
		expect(lines[0]).not.toContain("(not loaded)")
		// The marker keeps its place: only the sentence gives way.
		expect(lines[0]).toContain(" ▸ ")
	})

	it("keeps the marker in the warning colour when the sentence is cut", () => {
		// A cut string ends with a colour reset; a marker appended to the same
		// span would fall back to the default colour.
		const paint = { fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>` } as never
		const renderer = createSkippedAgentFilesRenderer(() => "start-1")
		const line = renderer(entry({ token: "start-1", files: one }), { expanded: false }, paint)?.render(80)[0]

		expect(line).toContain("<warning> ▸</warning>")
	})

	it("pluralizes the count", () => {
		const files = [
			...one,
			{ path: ".kimchi/agents/b.md", reason: "bad indent" },
			{ path: ".kimchi/agents/c.md", reason: "bad indent" },
		]
		expect(render({ token: "start-1", files })?.[0]).toContain("Warning: Skipped 3 agent files")
	})

	it("expands to the header, one line per file and the fix line", () => {
		const lines = render({ token: "start-1", files: one }, { expanded: true }) ?? []

		// The sentence is the same collapsed or expanded — only the marker and
		// the hint change, so the count stays visible while reading the details.
		expect(lines[0].startsWith(" Warning: Skipped 1 agent file")).toBe(true)
		expect(lines[0]).toContain(" ▾ ")
		expect(lines[0]).toContain(COLLAPSE)
		expect(lines.slice(1)).toEqual([
			"   .kimchi/agents/a.md — unexpected end of the stream",
			" Fix the YAML frontmatter to load them.",
		])
	})

	it("paints only the header, leaving the details plain", () => {
		const fg = vi.fn((_colour: string, text: string) => text)
		const renderer = createSkippedAgentFilesRenderer(() => "start-1")
		renderer(entry({ token: "start-1", files: one }), { expanded: true }, { fg } as never)?.render(80)

		const colours = fg.mock.calls.map(([colour]) => colour)
		// The sentence and its marker, painted separately so a truncated
		// sentence cannot strip the marker's colour.
		expect(colours.filter((colour) => colour === "warning")).toHaveLength(2)
		expect(colours.filter((colour) => colour === "dim")).toHaveLength(1)
		// Nothing else is painted: the rows and the fix line stay default colour.
		expect(colours).toHaveLength(3)
	})

	describe("narrow terminals", () => {
		for (const width of [20, 8]) {
			it(`keeps every collapsed line within ${width} columns`, () => {
				const lines = render({ token: "start-1", files: one }, {}, width) ?? []
				expect(lines.length).toBeGreaterThan(0)
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			})

			it(`keeps every expanded line within ${width} columns`, () => {
				const files = [
					{
						path: ".kimchi/agents/a-very-long-agent-file-name.md",
						reason: "unexpected end of the stream, expected a closing bracket in the tools list",
					},
				]
				const lines = render({ token: "start-1", files }, { expanded: true }, width) ?? []

				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				expect(lines.length).toBeGreaterThan(1)
			})
		}

		it("wraps long rows with an indent that marks the continuation", () => {
			const files = [
				{
					path: ".kimchi/agents/a-very-long-agent-file-name.md",
					reason: "unexpected end of the stream, expected a closing bracket in the tools list",
				},
			]
			const rows = (render({ token: "start-1", files }, { expanded: true }, 40) ?? []).slice(1, -1)

			// One entry, several lines: the first indented like a row, the rest
			// deeper so a wrapped row cannot be read as a second file. No blank
			// line at the start — the failure this replaced produced one.
			expect(rows.length).toBeGreaterThan(2)
			expect(rows[0].startsWith("   .kimchi")).toBe(true)
			for (const row of rows.slice(1)) expect(row.startsWith("     ")).toBe(true)
			expect(rows.some((row) => row.trim().length === 0)).toBe(false)
			expect(rows.join("\n")).toContain("tools")
		})

		it("truncates instead of wrapping when the terminal is unusably narrow", () => {
			const files = [
				{
					path: ".kimchi/agents/a-very-long-agent-file-name.md",
					reason: "unexpected end of the stream, expected a closing bracket in the tools list",
				},
			]
			const lines = render({ token: "start-1", files }, { expanded: true }, 8) ?? []

			// Header, one row, one fix line — no dozens of wrapped fragments.
			expect(lines).toHaveLength(3)
		})
	})

	describe("click to toggle", () => {
		const data = { token: "start-1", files: one }
		const mouse = (overrides: Partial<TuiMouseEvent> = {}) =>
			({ type: "click", button: "left", x: 3, y: 0, ...overrides }) as TuiMouseEvent
		const isExpanded = (lines: string[] | undefined) => (lines ?? []).some((line) => line.includes("a.md"))

		it("expands on a left click and collapses on the next one", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			const line = renderer(entry(data), { expanded: false }, theme)

			expect(line?.handleMouse?.(mouse())).toEqual({ handled: true })
			expect(isExpanded(line?.render(120))).toBe(true)
			expect(line?.render(120)[0]).toContain(COLLAPSE)
			expect(line?.render(120)[0]).toContain("(not loaded) ▾")

			expect(line?.handleMouse?.(mouse())).toEqual({ handled: true })
			expect(isExpanded(line?.render(120))).toBe(false)
			expect(line?.render(120)[0]).toContain(EXPAND)
			expect(line?.render(120)[0]).toContain("(not loaded) ▸")
		})

		it("leaves presses, releases and other buttons to text selection and paste", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			const line = renderer(entry(data), { expanded: false }, theme)

			expect(line?.handleMouse?.(mouse({ type: "press" }))).toBeUndefined()
			expect(line?.handleMouse?.(mouse({ type: "release" }))).toBeUndefined()
			expect(line?.handleMouse?.(mouse({ button: "right" }))).toBeUndefined()
			expect(isExpanded(line?.render(120))).toBe(false)
		})

		it("keeps the clicked state when pi rebuilds the component", () => {
			// pi re-runs the renderer on invalidate (theme change, resize): the
			// state must come back from the renderer, not the discarded component.
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			renderer(entry(data), { expanded: false }, theme)?.handleMouse?.(mouse())

			expect(isExpanded(renderer(entry(data), { expanded: false }, theme)?.render(120))).toBe(true)
		})

		it("targets the live child when clicking after an invalidated render", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			const container = new Container()
			const first = renderer(entry(data), { expanded: false }, theme)
			if (!first) throw new Error("Expected the initial notice renderer to produce a child")
			container.addChild(new Spacer(1))
			container.addChild(first)
			container.render(120)
			const click = mouse({ x: 3, y: 1, screenX: 3, screenY: 1, width: 120, height: 40 })

			expect(container.handleMouse(click)?.handled).toBe(true)
			expect(isExpanded(first.render(120))).toBe(true)
			container.clear()
			container.addChild(new Spacer(1))
			const rebuilt = renderer(entry(data), { expanded: false }, theme)
			if (!rebuilt) throw new Error("Expected the invalidated notice renderer to produce a child")
			container.addChild(rebuilt)

			expect(container.handleMouse(click)?.handled).toBe(true)
			expect(isExpanded(rebuilt.render(120))).toBe(false)
		})

		it("toggles only the clicked notice", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			renderer(entry(data, "entry-1"), { expanded: false }, theme)?.handleMouse?.(mouse())

			expect(isExpanded(renderer(entry(data, "entry-1"), { expanded: false }, theme)?.render(120))).toBe(true)
			expect(isExpanded(renderer(entry(data, "entry-2"), { expanded: false }, theme)?.render(120))).toBe(false)
		})

		// Click and ctrl+o share one state: whichever comes next flips the
		// notice, so the "(ctrl+o to …)" hint never lies. `expanded` below is
		// pi's shared toggle, which each ctrl+o press inverts.
		it("closes with ctrl+o after being clicked open", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			renderer(entry(data), { expanded: false }, theme)?.handleMouse?.(mouse())

			const afterCtrlO = renderer(entry(data), { expanded: true }, theme)?.render(120)
			expect(isExpanded(afterCtrlO)).toBe(false)
			expect(afterCtrlO?.[0]).toContain(EXPAND)
			// …and the next press opens it again.
			expect(isExpanded(renderer(entry(data), { expanded: false }, theme)?.render(120))).toBe(true)
		})

		it("closes with a click after being opened with ctrl+o", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			const opened = renderer(entry(data), { expanded: true }, theme)
			expect(isExpanded(opened?.render(120))).toBe(true)

			opened?.handleMouse?.(mouse())
			expect(isExpanded(opened?.render(120))).toBe(false)
			// The click survives a rebuild, and ctrl+o then reopens the notice.
			expect(isExpanded(renderer(entry(data), { expanded: true }, theme)?.render(120))).toBe(false)
			expect(isExpanded(renderer(entry(data), { expanded: false }, theme)?.render(120))).toBe(true)
		})

		it("falls back in step with ctrl+o after a second click", () => {
			const renderer = createSkippedAgentFilesRenderer(() => "start-1")
			renderer(entry(data), { expanded: false }, theme)?.handleMouse?.(mouse())
			renderer(entry(data), { expanded: false }, theme)?.handleMouse?.(mouse())

			expect(isExpanded(renderer(entry(data), { expanded: false }, theme)?.render(120))).toBe(false)
			expect(isExpanded(renderer(entry(data), { expanded: true }, theme)?.render(120))).toBe(true)
		})
	})

	it("hides entries it cannot understand", () => {
		expect(render(undefined)).toBeUndefined()
		expect(render({})).toBeUndefined()
		expect(render({ token: "start-1" })).toBeUndefined()
		expect(render({ token: "start-1", files: [] })).toBeUndefined()
		expect(render({ token: 7, files: one })).toBeUndefined()
		expect(render({ token: "start-1", files: [{ path: "a.md" }] })).toBeUndefined()
		expect(render("legacy string payload")).toBeUndefined()
	})

	it("hides notices from an earlier session start", () => {
		const data = { token: "start-1", files: one }

		expect(render(data, { token: "start-2" })).toBeUndefined()
		expect(render(data, { token: "start-1" })).toHaveLength(1)
	})

	it("hides the notice when no session start has claimed a token yet", () => {
		const renderer = createSkippedAgentFilesRenderer(() => undefined)

		expect(renderer(entry({ token: "start-1", files: one }), { expanded: false }, theme)).toBeUndefined()
	})
})
