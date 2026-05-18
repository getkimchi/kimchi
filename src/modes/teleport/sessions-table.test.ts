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

	it("truncates long names with an ellipsis when name budget is exceeded", () => {
		// Pin a narrow width so the NAME budget is ~8 chars (the floor) and the
		// long name has to truncate.
		const out = renderSessionsTable([makeRow({ name: "this-is-a-very-long-feature-name" })], NOW, 60)
		expect(out).toContain("…")
		const lines = out.split("\n")
		// No row overflows the configured width.
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(60)
	})

	it("expands NAME to consume the available width", () => {
		const out = renderSessionsTable([makeRow({ name: "fairly-long-but-fits-easily" })], NOW, 160)
		// At 160 cols there's plenty of room — the name should appear in full.
		expect(out).toContain("fairly-long-but-fits-easily")
		expect(out).not.toContain("fairly-long-…")
		const lines = out.split("\n")
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(160)
	})

	it("shrinks STATE column to fit actual content (not the worst-case state label)", () => {
		// All rows are 'detached' (8 chars). State column should pack to 8, not
		// the 22 chars 'detached (this kimchi)' would have required.
		const out = renderSessionsTable(
			[
				makeRow({ id: "11111111", name: "alpha", state: "detached" }),
				makeRow({ id: "22222222", name: "beta", state: "detached" }),
			],
			NOW,
			120,
		)
		const headerLine = out.split("\n")[0]
		// "STATE" is 5 chars but the header column floor is max(header, content).
		// We expect 8 (length of "detached") since that's the widest content.
		// Verify by checking the gap between "STATE" and "ID" headers.
		const stateIdx = headerLine.indexOf("STATE")
		const idIdx = headerLine.indexOf("ID")
		expect(idIdx - stateIdx).toBe("STATE".length + (8 - "STATE".length) + 1) // STATE + pad-to-8 + 1 separator
	})

	it("renders the full session id (no 8-char prefix truncation)", () => {
		const fullId = "s-aee85ef3-501b-4e6c-bfff-37556b224dae"
		const out = renderSessionsTable([makeRow({ id: fullId, name: "n" })], NOW, 200)
		expect(out).toContain(fullId)
		// And explicitly that the prefix isn't followed by an ellipsis or padding gap.
		expect(out).not.toMatch(/s-aee85ef3 /)
	})

	it("never shrinks NAME below the floor (MIN_NAME_WIDTH = 8)", () => {
		// Force a tiny width — NAME should still be 8 chars wide minimum.
		const out = renderSessionsTable([makeRow({ name: "abcdefghijklmnop" })], NOW, 20)
		// The NAME cell will contain a 7-char prefix + "…" = 8 chars.
		expect(out).toContain("abcdefg…")
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
		// Pin width so the snapshot is deterministic regardless of the runner's terminal.
		expect(renderSessionsTable(rows, NOW, 100)).toMatchSnapshot()
	})
})
