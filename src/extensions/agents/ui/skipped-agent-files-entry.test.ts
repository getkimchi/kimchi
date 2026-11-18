import type { CustomEntry } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
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

function entry(data: unknown): CustomEntry<SkippedAgentFilesEntryData> {
	return {
		type: "custom",
		id: "entry-1",
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

		// The header text is the same collapsed or expanded — only the hint
		// changes, so the count stays visible while reading the details.
		expect(lines[0].startsWith(" Warning: Skipped 1 agent file")).toBe(true)
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
		expect(colours.filter((colour) => colour === "warning")).toHaveLength(1)
		expect(colours.filter((colour) => colour === "dim")).toHaveLength(1)
		// Nothing else is painted: the rows and the fix line stay default colour.
		expect(colours).toHaveLength(2)
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
