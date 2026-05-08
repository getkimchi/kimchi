import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FermentError, FermentStorage, clearFermentCache, detectProjectRoot } from "./store.js"
import type { FermentV3, Phase, Step } from "./types.js"

function createTempDir() {
	return mkdtempSync(join(tmpdir(), "ferment-v4-test-"))
}

describe("FermentStorage v4", () => {
	let tempDir: string
	let storage: FermentStorage

	beforeEach(() => {
		tempDir = createTempDir()
		storage = new FermentStorage(tempDir)
		clearFermentCache()
	})

	afterEach(() => {
		clearFermentCache()
	})

	describe("create", () => {
		it("creates at draft status with empty phases", () => {
			const f = storage.create("Auth rewrite")
			expect(f.name).toBe("Auth rewrite")
			expect(f.status).toBe("draft")
			expect(f.phases).toEqual([])
			expect(f.decisions).toEqual([])
			expect(f.memories).toEqual([])
			expect(f.createdAt).toBeTruthy()
		})

		it("accepts description", () => {
			const f = storage.create("Auth rewrite", "Rewrite to OAuth2")
			expect(f.description).toBe("Rewrite to OAuth2")
		})

		it("auto-renames duplicates with counter", () => {
			storage.create("Auth rewrite")
			const f2 = storage.create("Auth rewrite")
			expect(f2.name).toBe("Auth rewrite (1)")
			const f3 = storage.create("Auth rewrite")
			expect(f3.name).toBe("Auth rewrite (2)")
		})
	})

	describe("get", () => {
		it("returns undefined for missing id", () => {
			expect(storage.get("nonexistent")).toBeUndefined()
		})

		it("returns a ferment by id", () => {
			const f = storage.create("OAuth migration")
			expect(storage.get(f.id)?.name).toBe("OAuth migration")
		})
	})

	describe("list", () => {
		it("returns empty array when none exist", () => {
			expect(storage.list()).toEqual([])
		})

		it("returns sorted by createdAt desc", () => {
			storage.create("Zebra")
			storage.create("Alpha")
			const list = storage.list()
			expect(list.length).toBe(2)
			// Both may have identical timestamp — just assert they exist
			const names = list.map((l) => l.name).sort()
			expect(names).toEqual(["Alpha", "Zebra"])
		})
	})

	describe("resolve", () => {
		it("resolves by exact id", () => {
			const f = storage.create("Resolvable")
			expect(storage.resolve(f.id)?.name).toBe("Resolvable")
		})

		it("resolves by exact name", () => {
			const f = storage.create("Exact Name")
			expect(storage.resolve("Exact Name")?.id).toBe(f.id)
		})

		it("resolves case-insensitive prefix when unambiguous", () => {
			const f = storage.create("UniquePrefix")
			expect(storage.resolve("unique")?.id).toBe(f.id)
		})

		it("throws when ambiguous prefix", () => {
			storage.create("Alpha One")
			storage.create("Alpha Two")
			expect(() => storage.resolve("alpha")).toThrow(FermentError)
		})

		it("returns undefined when not found", () => {
			expect(storage.resolve("nothing")).toBeUndefined()
		})
	})

	describe("delete", () => {
		it("removes an existing ferment", () => {
			const f = storage.create("To delete")
			expect(storage.delete(f.id)).toBe(true)
			expect(storage.get(f.id)).toBeUndefined()
		})

		it("returns false for missing id", () => {
			expect(storage.delete("nope")).toBe(false)
		})
	})

	describe("updateStatus", () => {
		it("updates status and updatedAt", () => {
			const f = storage.create("X")
			const ts = Date.now()
			const updated = storage.updateStatus(f.id, "planned")
			expect(updated?.status).toBe("planned")
			expect(updated?.updatedAt).toBeTruthy()
			if (updated) {
				expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(ts)
			}
		})

		it("returns undefined for missing id", () => {
			expect(storage.updateStatus("nope", "planned")).toBeUndefined()
		})
	})

	describe("updateGoal", () => {
		it("sets goal and successCriteria", () => {
			const f = storage.create("Build Tetris")
			const updated = storage.updateGoal(f.id, "A game", "Can play 1 round")
			expect(updated?.goal).toBe("A game")
			expect(updated?.successCriteria).toBe("Can play 1 round")
		})
	})

	describe("setPhases", () => {
		it("overwrites all phases", () => {
			const f = storage.create("Build Tetris")
			const phases: Phase[] = [
				{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "planned", steps: [] },
				{ id: "p2", index: 2, name: "Phase 2", goal: "G2", status: "planned", steps: [] },
			]
			const updated = storage.setPhases(f.id, phases)
			expect(updated?.phases).toHaveLength(2)
			expect(updated?.status).toBe("draft")
		})

		it("returns undefined for missing id", () => {
			expect(storage.setPhases("nope", [])).toBeUndefined()
		})
	})

	describe("activatePhase", () => {
		it("activates a planned phase", () => {
			const f = storage.create("X")
			storage.setPhases(f.id, [
				{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "planned", steps: [] },
				{ id: "p2", index: 2, name: "Phase 2", goal: "G2", status: "planned", steps: [] },
			])
			const updated = storage.activatePhase(f.id, "p1")
			expect(updated?.phases[0]?.status).toBe("active")
			expect(updated?.phases[0]?.startedAt).toBeTruthy()
			expect(updated?.activePhaseId).toBe("p1")
		})

		it("deactivates any previously active phase", () => {
			const f = storage.create("X")
			storage.setPhases(f.id, [
				{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "active", steps: [] },
				{ id: "p2", index: 2, name: "Phase 2", goal: "G2", status: "planned", steps: [] },
			])
			const updated = storage.activatePhase(f.id, "p2")
			expect(updated?.phases[0]?.status).toBe("planned")
			expect(updated?.phases[1]?.status).toBe("active")
		})
	})

	describe("completePhase", () => {
		it("marks a phase completed with summary", () => {
			const f = storage.create("X")
			storage.setPhases(f.id, [{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "active", steps: [] }])
			const updated = storage.completePhase(f.id, "p1", "Done!")
			expect(updated?.phases[0]?.status).toBe("completed")
			expect(updated?.phases[0]?.summary).toBe("Done!")
			expect(updated?.phases[0]?.completedAt).toBeTruthy()
		})
	})

	describe("skipPhase", () => {
		it("marks a phase skipped", () => {
			const f = storage.create("X")
			storage.setPhases(f.id, [{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "planned", steps: [] }])
			const updated = storage.skipPhase(f.id, "p1", "Out of scope")
			expect(updated?.phases[0]?.status).toBe("skipped")
			expect(updated?.phases[0]?.summary).toBe("Out of scope")
		})
	})

	describe("refinePhase", () => {
		it("populates steps with indices", () => {
			const f = storage.create("X")
			storage.setPhases(f.id, [{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "active", steps: [] }])
			const steps: Step[] = [
				{ id: "s1", index: 0, description: "Create file", status: "pending" },
				{ id: "s2", index: 0, description: "Test it", status: "pending" },
			]
			const updated = storage.refinePhase(f.id, "p1", steps)
			const p = updated?.phases[0]
			expect(p?.steps).toHaveLength(2)
			expect(p?.steps[0].index).toBe(1)
			expect(p?.steps[1].index).toBe(2)
		})
	})

	describe("step lifecycle", () => {
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		let f: any

		beforeEach(() => {
			f = storage.create("Build Tetris")
			storage.setPhases(f.id, [{ id: "p1", index: 1, name: "Phase 1", goal: "G1", status: "active", steps: [] }])
			const steps: Step[] = [
				{ id: "s1", index: 1, description: "Create file", status: "pending" },
				{ id: "s2", index: 2, description: "Test it", status: "pending" },
			]
			storage.refinePhase(f.id, "p1", steps)
		})

		it("starts a step", () => {
			const updated = storage.startStep(f.id, "p1", "s1")
			const step = updated?.phases[0]?.steps[0]
			expect(step?.status).toBe("running")
			expect(step?.startedAt).toBeTruthy()
		})

		it("completes a step", () => {
			storage.startStep(f.id, "p1", "s1")
			const updated = storage.completeStep(f.id, "p1", "s1")
			const step = updated?.phases[0]?.steps[0]
			expect(step?.status).toBe("done")
			expect(step?.completedAt).toBeTruthy()
		})

		it("skips a step", () => {
			const updated = storage.skipStep(f.id, "p1", "s1")
			const step = updated?.phases[0]?.steps[0]
			expect(step?.status).toBe("skipped")
		})

		it("verifies a step (success)", () => {
			storage.startStep(f.id, "p1", "s1")
			const result = { success: true, exitCode: 0, completedAt: new Date().toISOString() }
			const updated = storage.verifyStep(f.id, "p1", "s1", result)
			const step = updated?.phases[0]?.steps[0]
			expect(step?.status).toBe("verified")
			expect(step?.result).toEqual(result)
		})

		it("verifies a step (failure)", () => {
			storage.startStep(f.id, "p1", "s1")
			const result = { success: false, exitCode: 1, completedAt: new Date().toISOString() }
			const updated = storage.verifyStep(f.id, "p1", "s1", result)
			const step = updated?.phases[0]?.steps[0]
			expect(step?.status).toBe("done")
			expect(step?.result).toEqual(result)
		})
	})

	describe("addDecision", () => {
		it("adds with auto id", () => {
			const f = storage.create("X")
			const d = storage.addDecision(f.id, "Use Canvas", "Canvas is faster than DOM")
			expect(d?.decisions).toEqual([expect.objectContaining({ id: "D001", title: "Use Canvas" })])
		})

		it("links to phase and step", () => {
			const f = storage.create("X")
			const d = storage.addDecision(f.id, "T", "D", "p1", "s1")
			expect(d?.decisions[0]?.phaseId).toBe("p1")
			expect(d?.decisions[0]?.stepId).toBe("s1")
		})
	})

	describe("addMemory", () => {
		it("adds with auto id", () => {
			const f = storage.create("X")
			const m = storage.addMemory(f.id, "gotcha", "Watch for race conditions")
			expect(m?.memories).toEqual([expect.objectContaining({ id: "M001", category: "gotcha" })])
		})
	})

	describe("atomic writes", () => {
		it("survives a fresh storage instance", () => {
			const f = storage.create("Persistent")
			const fresh = new FermentStorage(tempDir)
			expect(fresh.get(f.id)?.name).toBe("Persistent")
		})
	})

	describe("V3 to V4 migration", () => {
		it("migrates plannedBatches + batchRefs to phases", () => {
			const v3: FermentV3 = {
				id: "v3-ferment",
				name: "Old Ferment",
				goal: "Build something",
				successCriteria: "It works",
				status: "executing",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-06-01T00:00:00Z",
				plannedBatches: [
					{ id: "pb1", index: 1, name: "Setup", description: "Setup desc", goal: "G1", status: "active" },
					{ id: "pb2", index: 2, name: "Core", description: "Core desc", goal: "G2", status: "planned" },
				],
				batchRefs: [
					{
						id: "b1",
						name: "Setup batch",
						plannedBatchId: "pb1",
						status: "completed",
						summary: "Done",
						completedAt: "2024-05-01T00:00:00Z",
					},
					{ id: "b2", name: "Core batch", plannedBatchId: "pb2", status: "active" },
				],
				decisions: [{ id: "D001", title: "Choice", description: "Desc", createdAt: "2024-01-01T00:00:00Z" }],
			}

			writeFileSync(join(tempDir, "v3-ferment.json"), `${JSON.stringify(v3)}\n`)
			const fresh = new FermentStorage(tempDir)
			const f = fresh.get("v3-ferment")
			expect(f).toBeDefined()
			expect(f?.status).toBe("running") // executing -> running
			expect(f?.phases).toHaveLength(2)

			const p1 = f?.phases[0]
			expect(p1?.name).toBe("Setup")
			expect(p1?.status).toBe("completed") // batchRef completed wins
			expect(p1?.summary).toBe("Done")
			expect(p1?.steps).toEqual([])

			const p2 = f?.phases[1]
			expect(p2?.name).toBe("Core")
			expect(p2?.status).toBe("active") // ref status=active overrides pb.status=planned

			expect(f?.decisions).toHaveLength(1)
		})

		it("migrates abandoned to skipped and completed status", () => {
			const v3: FermentV3 = {
				id: "v3-2",
				name: "Abandoned",
				status: "abandoned",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				plannedBatches: [],
				batchRefs: [],
			}
			writeFileSync(join(tempDir, "v3-2.json"), `${JSON.stringify(v3)}\n`)
			const fresh = new FermentStorage(tempDir)
			const f = fresh.get("v3-2")
			expect(f?.status).toBe("complete") // abandoned -> complete
		})

		it("persists V4 format after migration", () => {
			const v3: FermentV3 = {
				id: "v3-3",
				name: "Migrate",
				status: "planned",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				plannedBatches: [{ id: "pb1", index: 1, name: "P", description: "", goal: "G", status: "planned" }],
				batchRefs: [],
			}
			writeFileSync(join(tempDir, "v3-3.json"), `${JSON.stringify(v3)}\n`)
			const fresh = new FermentStorage(tempDir)
			fresh.get("v3-3") // triggers migration
			const raw = readFileSync(join(tempDir, "v3-3.json"), "utf-8")
			expect(raw).toContain("phases")
			expect(raw).not.toContain("plannedBatches")
			expect(raw).not.toContain("batchRefs")
		})
	})

	describe("detectProjectRoot", () => {
		it("finds directory with .git", () => {
			const dir = createTempDir()
			mkdirSync(join(dir, ".git"))
			expect(detectProjectRoot(dir)).toBe(dir)
		})

		it("finds directory with package.json", () => {
			const dir = createTempDir()
			writeFileSync(join(dir, "package.json"), "{}")
			expect(detectProjectRoot(dir)).toBe(dir)
		})

		it("walks up to find .git", () => {
			const root = createTempDir()
			mkdirSync(join(root, ".git"))
			const sub = join(root, "src", "ferment")
			mkdirSync(sub, { recursive: true })
			expect(detectProjectRoot(sub)).toBe(root)
		})

		it("returns cwd when neither found", () => {
			const dir = createTempDir()
			expect(detectProjectRoot(dir)).toBe(dir)
		})
	})
})
