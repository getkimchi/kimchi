import { describe, expect, it } from "vitest"
import { type SessionRow, formatRelativeTime, renderSessionsTable } from "./sessions-table.js"

const NOW = new Date("2026-05-17T12:00:00Z")
const FIXED_WIDTH = 100

function makeRow(overrides: Partial<SessionRow>): SessionRow {
	return {
		id: "abcd1234efgh",
		name: "feature-x",
		state: "foreground",
		status: "idle",
		createdAt: new Date(NOW.getTime() - 60_000),
		lastActivityAt: new Date(NOW.getTime() - 60_000),
		...overrides,
	}
}

describe("formatRelativeTime", () => {
	it("returns 'just now' for sub-minute deltas", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now")
	})

	it("returns Nm ago for sub-hour", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5m ago")
	})

	it("returns Nh ago for sub-day", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() - 3 * 60 * 60_000), NOW)).toBe("3h ago")
	})

	it("returns 'yesterday' for ~1 day", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() - 25 * 60 * 60_000), NOW)).toBe("yesterday")
	})

	it("returns Nd ago for older", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 24 * 60 * 60_000), NOW)).toBe("5d ago")
	})

	it("handles future timestamps as 'just now'", () => {
		expect(formatRelativeTime(new Date(NOW.getTime() + 60_000), NOW)).toBe("just now")
	})
})

describe("renderSessionsTable", () => {
	it("renders only the header for an empty list", () => {
		const out = renderSessionsTable([], NOW, FIXED_WIDTH)
		expect(out.split("\n")).toHaveLength(1)
		expect(out).not.toContain("STATE")
		expect(out).toContain("ID")
		expect(out).toContain("NAME")
		expect(out).toContain("STATUS")
		expect(out).toContain("LAST ACTIVITY")
	})

	it("prefixes the foreground row with a *", () => {
		const out = renderSessionsTable([makeRow({})], NOW, FIXED_WIDTH)
		const lines = out.split("\n")
		expect(lines[1].startsWith("*")).toBe(true)
	})

	it("uses a leading space for non-foreground rows", () => {
		const out = renderSessionsTable([makeRow({ state: "detached" })], NOW, FIXED_WIDTH)
		const lines = out.split("\n")
		expect(lines[1].startsWith(" ")).toBe(true)
		expect(lines[1].startsWith("*")).toBe(false)
	})

	it("renders empty names as '-'", () => {
		const out = renderSessionsTable([makeRow({ name: "" })], NOW, FIXED_WIDTH)
		const lines = out.split("\n")
		// "-" appears in the NAME column on the row
		expect(lines[1]).toMatch(/ - /)
	})

	it("renders mixed foreground + detached + remote rows in order", () => {
		const rows: SessionRow[] = [
			makeRow({ id: "fg111111", name: "fg-name", state: "foreground" }),
			makeRow({ id: "dt222222", name: "dt-name", state: "detached (this kimchi)" }),
			makeRow({ id: "sv333333", name: "sv-name", state: "active elsewhere", status: "active" }),
		]
		const out = renderSessionsTable(rows, NOW, FIXED_WIDTH)
		const lines = out.split("\n")
		expect(lines).toHaveLength(4)
		expect(lines[1]).toContain("fg111111")
		expect(lines[2]).toContain("dt222222")
		expect(lines[3]).toContain("sv333333")
		expect(lines[1].startsWith("*")).toBe(true)
		expect(lines[2].startsWith(" ")).toBe(true)
		// STATE column is gone — verify it is not present anywhere.
		expect(out).not.toContain("active elsewhere")
		expect(out).not.toContain("detached (this kimchi)")
	})

	it("shows full IDs (not truncated)", () => {
		const longId = "019e3a7e-1234-5678-9abc-def012345678"
		const out = renderSessionsTable([makeRow({ id: longId })], NOW, 200)
		expect(out).toContain(longId)
	})

	it("renders lines strictly narrower than the requested width", () => {
		const out = renderSessionsTable([makeRow({})], NOW, 120)
		const lines = out.split("\n")
		for (const line of lines) {
			// One-column safety margin so the UI layer's prefix doesn't push the line onto the next row.
			expect(line.length).toBeLessThan(120)
		}
	})

	it("does not pad NAME past the longest actual name when width is generous", () => {
		const short = renderSessionsTable([makeRow({ name: "feature-x" })], NOW, 200)
		const long = renderSessionsTable([makeRow({ name: "a-much-longer-feature-name" })], NOW, 200)
		// With short names the line is short; with longer names the line grows. Neither
		// fills the terminal — NAME is sized to content, not to the available width.
		expect(short.split("\n")[0].length).toBeLessThan(long.split("\n")[0].length)
		expect(long.split("\n")[0].length).toBeLessThan(200)
	})

	it("truncates NAME (not ID) when width is tight", () => {
		const longName = "this-is-a-very-long-feature-name-indeed"
		const longId = "019e3a7e-1234-5678-9abc-def012345678"
		const out = renderSessionsTable([makeRow({ id: longId, name: longName })], NOW, 80)
		expect(out).toContain(longId)
		expect(out).not.toContain(longName)
		expect(out).toContain("…")
	})

	it("emits a stable snapshot for a representative mix", () => {
		const rows: SessionRow[] = [
			makeRow({
				id: "abcd1234",
				name: "feature-x",
				state: "foreground",
				status: "idle",
				lastActivityAt: new Date(NOW.getTime() - 2 * 60_000),
			}),
			makeRow({
				id: "ef567890",
				name: "bugfix-y",
				state: "detached (this kimchi)",
				status: "idle",
				lastActivityAt: new Date(NOW.getTime() - 15 * 60_000),
			}),
			makeRow({
				id: "12345678",
				name: "exp-z",
				state: "detached",
				status: "idle",
				lastActivityAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
			}),
			makeRow({
				id: "9abc0def",
				name: "",
				state: "active elsewhere",
				status: "active",
				lastActivityAt: new Date(NOW.getTime() - 30_000),
			}),
		]
		expect(renderSessionsTable(rows, NOW, FIXED_WIDTH)).toMatchSnapshot()
	})
})
