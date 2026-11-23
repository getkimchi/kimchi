import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { auditCaptureQueue } from "./maintenance-queue.js"

describe("capture queue audit", () => {
	const roots: string[] = []
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
	})

	it("counts scoped duplicate bodies, invalid jobs, sizes, and oldest age", () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-queue-audit-"))
		roots.push(root)
		const pending = join(root, "pending")
		mkdirSync(pending)
		const messages = [{ role: "user", content: "Use pnpm" }]
		const first = JSON.stringify({ dedupeSession: "session-a", messages })
		const second = JSON.stringify({ session: "session-b", messages })
		writeFileSync(join(pending, "first.json"), first)
		writeFileSync(join(pending, "duplicate.json"), first)
		writeFileSync(join(pending, "different-session.json"), second)
		writeFileSync(join(pending, "invalid.json"), "{broken")
		const now = Date.parse("2026-11-16T11:00:00Z")
		utimesSync(join(pending, "first.json"), (now - 60 * 60 * 1000) / 1000, (now - 60 * 60 * 1000) / 1000)

		expect(auditCaptureQueue(root, now)).toEqual({
			jobs: 4,
			duplicateGroups: 1,
			duplicateJobs: 1,
			duplicateGroupSizes: { 2: 1 },
			invalidJobs: 1,
			bytes: Buffer.byteLength(first) * 2 + Buffer.byteLength(second) + Buffer.byteLength("{broken"),
			oldestPendingAgeMs: 60 * 60 * 1000,
		})
	})

	it("reports an empty queue without inventing an age", () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-queue-audit-empty-"))
		roots.push(root)
		expect(auditCaptureQueue(root)).toEqual({
			jobs: 0,
			duplicateGroups: 0,
			duplicateJobs: 0,
			duplicateGroupSizes: {},
			invalidJobs: 0,
			bytes: 0,
		})
	})
})
