import { describe, expect, it } from "vitest"
import { type SessionRow, formatRelativeTime, renderSessionsTable } from "./sessions-table.js"

const NOW = new Date("2026-05-17T12:00:00Z")

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
		const out = renderSessionsTable([], NOW)
		expect(out.split("\n")).toHaveLength(1)
		expect(out).toContain("STATE")
		expect(out).toContain("ID")
		expect(out).toContain("NAME")
		expect(out).toContain("STATUS")
		expect(out).toContain("LAST ACTIVITY")
	})

	it("prefixes the foreground row with a *", () => {
		const out = renderSessionsTable([makeRow({})], NOW)
		const lines = out.split("\n")
		expect(lines[1].startsWith("*")).toBe(true)
	})

	it("uses a leading space for non-foreground rows", () => {
		const out = renderSessionsTable([makeRow({ state: "detached" })], NOW)
		const lines = out.split("\n")
		expect(lines[1].startsWith(" ")).toBe(true)
		expect(lines[1].startsWith("*")).toBe(false)
	})

	it("truncates long names with an ellipsis", () => {
		const out = renderSessionsTable([makeRow({ name: "this-is-a-very-long-feature-name" })], NOW)
		expect(out).toContain("this-is-a-very-…")
	})

	it("renders empty names as '-'", () => {
		const out = renderSessionsTable([makeRow({ name: "" })], NOW)
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
		const out = renderSessionsTable(rows, NOW)
		const lines = out.split("\n")
		expect(lines).toHaveLength(4)
		expect(lines[1]).toContain("fg111111")
		expect(lines[2]).toContain("dt222222")
		expect(lines[3]).toContain("sv333333")
		expect(lines[1].startsWith("*")).toBe(true)
		expect(lines[2].startsWith(" ")).toBe(true)
		expect(lines[3]).toContain("active elsewhere")
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
		expect(renderSessionsTable(rows, NOW)).toMatchSnapshot()
	})
})
