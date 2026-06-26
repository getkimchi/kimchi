import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import {
	PENDING_PROPOSAL_SCHEMA_VERSION,
	type PendingProposalData,
	deletePendingProposal,
	loadPendingProposal,
	savePendingProposal,
} from "./pending-proposal-store.js"

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ferment-pending-proposal-"))
})

afterEach(() => {
	// tmpdirs are auto-cleaned by the OS; nothing global to reset since every
	// call passes `root` explicitly (no setRuntimeStatePersistRoot equivalent
	// needed — the store takes an optional root arg).
})

function sampleData(fermentId: string, overrides: Partial<PendingProposalData> = {}): PendingProposalData {
	return {
		schemaVersion: PENDING_PROPOSAL_SCHEMA_VERSION,
		fermentId,
		title: "Test Ferment",
		goal: "Do the thing",
		successCriteria: ["criterion A", "criterion B"],
		constraints: ["constraint X"],
		assumptions: "assume Z holds",
		phases: [
			{
				name: "Phase 1",
				goal: "Implement",
				steps: [{ description: "write code", verify: "pnpm test" }],
			},
		] satisfies ScopePhaseInput[],
		planMarkdown: "# Plan\n\n- step 1\n- step 2",
		proposeIterations: 1,
		savedAt: "2026-06-26T00:00:00.000Z",
		...overrides,
	}
}

describe("pending-proposal-store", () => {
	describe("save → load round-trip", () => {
		it("persists and reloads every field unchanged", () => {
			const fId = "ferment-rt-1"
			const data = sampleData(fId, {
				title: "Round Trip",
				phases: [
					{ name: "P1", goal: "g1", steps: [{ description: "d1" }] },
					{ name: "P2", goal: "g2", steps: [{ description: "d2", verify: "echo ok" }] },
				],
				proposeIterations: 2,
				savedAt: "2026-06-26T12:34:56.789Z",
			})

			expect(savePendingProposal(fId, data, { root })).toBe(true)

			const loaded = loadPendingProposal(fId, root)
			expect(loaded).toBeDefined()
			expect(loaded).toEqual(data)
		})

		it("creates the sidecar file at {root}/{fermentId}/pending-proposal.json", () => {
			const fId = "ferment-path-1"
			savePendingProposal(fId, sampleData(fId), { root })

			const expected = join(root, fId, "pending-proposal.json")
			expect(existsSync(expected)).toBe(true)

			// The persisted JSON must be valid and carry the schema version.
			const onDisk = JSON.parse(readFileSync(expected, "utf-8"))
			expect(onDisk.schemaVersion).toBe(PENDING_PROPOSAL_SCHEMA_VERSION)
		})
	})

	describe("deletePendingProposal", () => {
		it("removes an existing sidecar file", () => {
			const fId = "ferment-del-1"
			savePendingProposal(fId, sampleData(fId), { root })
			const file = join(root, fId, "pending-proposal.json")
			expect(existsSync(file)).toBe(true)

			deletePendingProposal(fId, root)

			expect(existsSync(file)).toBe(false)
			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})

		it("is a no-op when no sidecar exists (does not throw)", () => {
			const fId = "ferment-del-missing"
			expect(() => deletePendingProposal(fId, root)).not.toThrow()
			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})
	})

	describe("loadPendingProposal error tolerance", () => {
		it("returns undefined when the file is missing", () => {
			expect(loadPendingProposal("ferment-missing", root)).toBeUndefined()
		})

		it("returns undefined on corrupted JSON (does not throw)", () => {
			const fId = "ferment-corrupt"
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			// Manually write invalid JSON to the sidecar path.
			writeFileSync(join(dir, "pending-proposal.json"), "{ not valid json {{{", "utf-8")

			expect(() => loadPendingProposal(fId, root)).not.toThrow()
			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})

		it("returns undefined when schemaVersion does not match", () => {
			const fId = "ferment-schema-mismatch"
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, "pending-proposal.json"),
				JSON.stringify({
					schemaVersion: 999,
					fermentId: fId,
					title: "future",
					goal: "g",
					successCriteria: [],
					constraints: [],
					assumptions: "",
					phases: [],
					planMarkdown: "",
					proposeIterations: 0,
					savedAt: "2026-06-26T00:00:00.000Z",
				}),
				"utf-8",
			)

			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})

		it("returns undefined when fermentId field does not match the requested id", () => {
			const fId = "ferment-id-mismatch"
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, "pending-proposal.json"),
				JSON.stringify({
					schemaVersion: PENDING_PROPOSAL_SCHEMA_VERSION,
					fermentId: "some-other-ferment",
					title: "t",
					goal: "g",
					successCriteria: [],
					constraints: [],
					assumptions: "",
					phases: [],
					planMarkdown: "",
					proposeIterations: 0,
					savedAt: "2026-06-26T00:00:00.000Z",
				}),
				"utf-8",
			)

			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})

		it("returns undefined when successCriteria contains non-string elements", () => {
			const fId = "ferment-bad-sc-elems"
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, "pending-proposal.json"),
				JSON.stringify({
					schemaVersion: PENDING_PROPOSAL_SCHEMA_VERSION,
					fermentId: fId,
					title: "t",
					goal: "g",
					successCriteria: ["ok", 123],
					constraints: [],
					assumptions: "",
					phases: [],
					planMarkdown: "",
					proposeIterations: 0,
					savedAt: "2026-06-26T00:00:00.000Z",
				}),
				"utf-8",
			)

			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})

		it("returns undefined when phases contains non-object elements", () => {
			const fId = "ferment-bad-phases"
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, "pending-proposal.json"),
				JSON.stringify({
					schemaVersion: PENDING_PROPOSAL_SCHEMA_VERSION,
					fermentId: fId,
					title: "t",
					goal: "g",
					successCriteria: [],
					constraints: [],
					assumptions: "",
					phases: [null],
					planMarkdown: "",
					proposeIterations: 0,
					savedAt: "2026-06-26T00:00:00.000Z",
				}),
				"utf-8",
			)

			expect(loadPendingProposal(fId, root)).toBeUndefined()
		})
	})

	describe("atomic temp + rename write", () => {
		it("leaves no stray .tmp files after a successful save", () => {
			const fId = "ferment-atomic-1"
			savePendingProposal(fId, sampleData(fId), { root })

			const dir = join(root, fId)
			const entries = readdirSync(dir)
			// Only the final sidecar should exist — no leftover .tmp.* files.
			expect(entries).toEqual(["pending-proposal.json"])
		})

		it("reports failure via onError and returns false when the write throws", () => {
			const fId = "ferment-atomic-fail"
			// Point the root at a path whose parent cannot be created: create
			// a regular file at the location where mkdir would need to make a
			// directory. We do this by making `root` a file, not a directory,
			// so mkdirSync(recursive) on {root}/{fId} throws EEXIST/ENOTDIR.
			const blockerPath = join(root, "blocker-file")
			writeFileSync(blockerPath, "", "utf-8")

			let captured: unknown
			const ok = savePendingProposal(fId, sampleData(fId), {
				root: blockerPath,
				onError: (err) => {
					captured = err
				},
			})

			expect(ok).toBe(false)
			expect(captured).toBeDefined()
			// No final file should exist at the (impossible) target path.
			expect(existsSync(join(blockerPath, fId, "pending-proposal.json"))).toBe(false)
		})

		it("cleans up orphaned .tmp files when renameSync fails", () => {
			const fId = "ferment-tmp-cleanup"
			// Create the target directory so writeFileSync succeeds, but make
			// the target path itself a directory so renameSync fails (can't
			// rename over a directory).
			const dir = join(root, fId)
			mkdirSync(dir, { recursive: true })
			mkdirSync(join(dir, "pending-proposal.json"), { recursive: true })

			const ok = savePendingProposal(fId, sampleData(fId), { root })
			expect(ok).toBe(false)

			// No stray .tmp.* files should remain.
			const entries = readdirSync(dir)
			const tmpFiles = entries.filter((e) => e.startsWith("pending-proposal.json.tmp."))
			expect(tmpFiles).toEqual([])
		})
	})
})
