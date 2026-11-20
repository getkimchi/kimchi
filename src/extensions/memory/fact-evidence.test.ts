import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readFactRecallEvidence } from "./fact-evidence.js"
import { tracesDir, traceTextHash } from "./trace.js"

const roots: string[] = []

function fixture(events: Array<Record<string, unknown>>, filename = "recall-2026-11-17T10-00-00-000-1.jsonl"): string {
	const root = mkdtempSync(join(tmpdir(), "kimchi-fact-evidence-"))
	roots.push(root)
	const dir = tracesDir(root)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, filename),
		`${events.map((event) => JSON.stringify({ type: "recall", ...event })).join("\n")}\n`,
	)
	return root
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop()
		if (root) rmSync(root, { recursive: true, force: true })
	}
})

describe("fact recall evidence", () => {
	it("links selected and delivered fields by stable fact and recall IDs", () => {
		const root = fixture([
			{
				ts: "2026-11-17T10:00:00.000Z",
				recall_id: "r1",
				kind: "recall",
				selectedIds: ["fact-1"],
				conclusion: "selected",
			},
			{
				ts: "2026-11-17T10:00:00.100Z",
				recall_id: "r1",
				injectedIds: ["fact-1"],
				steered: true,
				conclusion: "steered",
			},
		])
		expect(readFactRecallEvidence({ id: "fact-1", memory: "Use pnpm" }, { root })).toEqual([
			expect.objectContaining({
				recallId: "r1",
				selected: true,
				delivered: true,
				conclusion: "steered",
				identity: "fact-id",
			}),
		])
	})

	it("labels hashed pre-ID matches as legacy rather than authoritative ID linkage", () => {
		const root = fixture([
			{
				ts: "2026-11-17T10:00:00.000Z",
				recall_id: "r1",
				kind: "digest-init",
				selected: [traceTextHash("Use pnpm")],
				conclusion: "selected",
			},
		])
		expect(readFactRecallEvidence({ id: "fact-1", memory: "Use pnpm" }, { root })[0]).toMatchObject({
			selected: true,
			delivered: false,
			identity: "legacy-text",
		})
	})

	it("merges one fact's selection and delivery across separate recall files", () => {
		const root = fixture([
			{ ts: "2026-11-17T10:00:00.000Z", recall_id: "r1", selectedIds: ["fact-1"], conclusion: "selected" },
		])
		writeFileSync(
			join(tracesDir(root), "recall-later.jsonl"),
			`${JSON.stringify({ type: "recall", ts: "2026-11-17T10:00:01.000Z", recall_id: "r1", injectedIds: ["fact-1"], conclusion: "steered" })}\n`,
		)
		expect(readFactRecallEvidence({ id: "fact-1", memory: "Use pnpm" }, { root })).toHaveLength(1)
		expect(readFactRecallEvidence({ id: "fact-1", memory: "Use pnpm" }, { root })[0]).toMatchObject({
			recallId: "r1",
			selected: true,
			delivered: true,
			conclusion: "steered",
		})
	})

	it("ignores unrelated facts and returns at most the requested number of recent groups", () => {
		const root = fixture(
			[
				{ ts: "2026-11-17T10:00:00.000Z", recall_id: "r1", selectedIds: ["fact-1", "other"] },
				{ ts: "2026-11-17T10:00:01.000Z", recall_id: "r2", selectedIds: ["fact-1"], attachedToTurn: true },
			],
			"recall-a.jsonl",
		)
		expect(readFactRecallEvidence({ id: "fact-1", memory: "new fact body" }, { root, limit: 1 })).toHaveLength(1)
		expect(readFactRecallEvidence({ id: "other", memory: "other fact" }, { root })).toHaveLength(1)
		expect(readFactRecallEvidence({ id: "missing", memory: "absent" }, { root })).toEqual([])
	})
})
