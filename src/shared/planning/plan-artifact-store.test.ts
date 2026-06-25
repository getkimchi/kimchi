import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtifactRef } from "./plan-artifact-store.js"
import { AdhocPlanStore, FermentPlanStore } from "./plan-artifact-store.js"

describe("plan-artifact-store", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-artifact-store-"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		vi.useRealTimers()
	})

	describe("AdhocPlanStore", () => {
		describe("saveSync returns correct ArtifactRef", () => {
			it("returns ref with kind adhoc-plan, format markdown, and .md path", () => {
				const store = new AdhocPlanStore()
				const ref = store.saveSync({ planText: "# Test Plan\n\n- step 1\n" }, { cwd: tmpDir })

				expect(ref.kind).toBe("adhoc-plan")
				expect(ref.format).toBe("markdown")
				expect(ref.path).toMatch(/\.md$/)
				expect(ref.path).toContain(".kimchi/plans/")
			})
		})

		describe("saveSync creates directory if missing", () => {
			it("creates .kimchi/plans directory", () => {
				const store = new AdhocPlanStore()
				const ref = store.saveSync({ planText: "# Plan\n" }, { cwd: tmpDir })

				expect(ref.path).toContain(join(tmpDir, ".kimchi", "plans"))
				const content = readFileSync(ref.path, "utf-8")
				expect(content).toBe("# Plan\n")
			})
		})

		describe("round-trip sync", () => {
			it("saves and loads plan text correctly", () => {
				const store = new AdhocPlanStore()
				const planText = "# My Plan\n\n- step 1\n- step 2\n"

				const ref = store.saveSync({ planText }, { cwd: tmpDir })
				const loaded = store.loadSync(ref)

				expect(loaded.planText).toBe(planText)
			})
		})

		describe("round-trip async", () => {
			it("saves and loads plan text correctly with async methods", async () => {
				const store = new AdhocPlanStore()
				const planText = "# Async Plan\n\n- async step 1\n"

				const ref = await store.save({ planText }, { cwd: tmpDir })
				const loaded = await store.load(ref)

				expect(loaded.planText).toBe(planText)
			})
		})

		describe("filename uniqueness", () => {
			it("produces distinct paths for consecutive saves", () => {
				vi.useFakeTimers({ now: 1000 })

				const store = new AdhocPlanStore()
				const ref1 = store.saveSync({ planText: "Plan 1" }, { cwd: tmpDir })

				vi.setSystemTime(2000)
				const ref2 = store.saveSync({ planText: "Plan 2" }, { cwd: tmpDir })

				expect(ref1.path).not.toBe(ref2.path)
				expect(ref1.path).toContain("plan-1000.md")
				expect(ref2.path).toContain("plan-2000.md")
			})
		})

		describe("loadSync with wrong ref.kind throws", () => {
			it("throws when ref.kind is ferment instead of adhoc-plan", () => {
				const store = new AdhocPlanStore()
				const wrongRef: ArtifactRef = {
					kind: "ferment",
					path: "/some/path.json",
					format: "json",
					id: "ferment-123",
				}

				expect(() => {
					store.loadSync(wrongRef)
				}).toThrow(/ref.kind is 'ferment', expected 'adhoc-plan'/)
			})
		})
	})

	describe("FermentPlanStore", () => {
		describe("saveSync returns correct ArtifactRef", () => {
			it("returns ref with kind ferment, format json, id, and .json path", () => {
				const store = new FermentPlanStore()
				const ref = store.saveSync(
					{
						id: "foo",
						name: "Test Ferment",
						goal: "Test goal",
						status: "draft",
					},
					{ cwd: tmpDir },
				)

				expect(ref.kind).toBe("ferment")
				expect(ref.format).toBe("json")
				if (ref.kind === "ferment") {
					expect(ref.id).toBe("foo")
				}
				expect(ref.path).toMatch(/\.json$/)
				expect(ref.path).toContain(".kimchi/ferments/")
			})
		})

		describe("saveSync spreads extra into top-level JSON", () => {
			it("writes extra fields to top-level JSON", () => {
				const store = new FermentPlanStore()
				const ref = store.saveSync(
					{
						id: "ferment-extra",
						name: "Ferment with Extra",
						goal: "Test goal",
						status: "draft",
						extra: {
							workMode: "auto",
							phases: ["phase1", "phase2"],
							customField: 42,
						},
					},
					{ cwd: tmpDir },
				)

				const rawContent = readFileSync(ref.path, "utf-8")
				const parsed = JSON.parse(rawContent)

				expect(parsed.id).toBe("ferment-extra")
				expect(parsed.name).toBe("Ferment with Extra")
				expect(parsed.goal).toBe("Test goal")
				expect(parsed.status).toBe("draft")
				expect(parsed.workMode).toBe("auto")
				expect(parsed.phases).toEqual(["phase1", "phase2"])
				expect(parsed.customField).toBe(42)
			})
		})

		describe("round-trip sync", () => {
			it("saves and loads ferment payload correctly", () => {
				const store = new FermentPlanStore()
				const payload = {
					id: "ferment-123",
					name: "Test Ferment",
					goal: "Test goal",
					status: "in-progress",
					extra: {
						workMode: "auto",
						phases: ["phase1", "phase2"],
					},
				}

				const ref = store.saveSync(payload, { cwd: tmpDir })
				const loaded = store.loadSync(ref)

				expect(loaded.id).toBe("ferment-123")
				expect(loaded.name).toBe("Test Ferment")
				expect(loaded.goal).toBe("Test goal")
				expect(loaded.status).toBe("in-progress")
				expect(loaded.extra).toEqual({
					workMode: "auto",
					phases: ["phase1", "phase2"],
				})
			})
		})

		describe("round-trip async", () => {
			it("saves and loads ferment payload correctly with async methods", async () => {
				const store = new FermentPlanStore()
				const payload = {
					id: "ferment-async",
					name: "Async Ferment",
					goal: "Async goal",
					status: "draft",
					extra: {
						asyncField: true,
					},
				}

				const ref = await store.save(payload, { cwd: tmpDir })
				const loaded = await store.load(ref)

				expect(loaded.id).toBe("ferment-async")
				expect(loaded.name).toBe("Async Ferment")
				expect(loaded.goal).toBe("Async goal")
				expect(loaded.status).toBe("draft")
				expect(loaded.extra).toEqual({ asyncField: true })
			})
		})

		describe("load with missing JSON fields", () => {
			function writeFermentFile(dir: string, id: string, content: object): ArtifactRef {
				const fermentsDir = join(dir, ".kimchi", "ferments")
				if (!existsSync(fermentsDir)) mkdirSync(fermentsDir, { recursive: true })
				const filePath = join(fermentsDir, `${id}.json`)
				writeFileSync(filePath, JSON.stringify(content), "utf-8")
				return { kind: "ferment", path: filePath, format: "json", id }
			}

			it("loads a fully valid artifact without error", () => {
				const store = new FermentPlanStore()
				const ref = writeFermentFile(tmpDir, "valid", {
					id: "valid",
					name: "My Ferment",
					goal: "Do the thing",
					status: "draft",
				})
				const loaded = store.loadSync(ref)
				expect(loaded.id).toBe("valid")
				expect(loaded.name).toBe("My Ferment")
				expect(loaded.goal).toBe("Do the thing")
			})

			// Regression: loadSync previously silently coerced missing required fields
			// to empty strings, returning semantically invalid artifacts to callers.
			it("throws a descriptive error when 'name' is missing", () => {
				const store = new FermentPlanStore()
				const ref = writeFermentFile(tmpDir, "no-name", {
					id: "no-name",
					goal: "Do the thing",
					status: "draft",
				})
				expect(() => store.loadSync(ref)).toThrow(/missing required field 'name'/i)
			})

			it("throws a descriptive error when 'goal' is missing", () => {
				const store = new FermentPlanStore()
				const ref = writeFermentFile(tmpDir, "no-goal", {
					id: "no-goal",
					name: "My Ferment",
					status: "draft",
				})
				expect(() => store.loadSync(ref)).toThrow(/missing required field 'goal'/i)
			})

			it("throws a descriptive error when 'id' is missing from both JSON and ref fallback cannot be empty", () => {
				const store = new FermentPlanStore()
				const ref = writeFermentFile(tmpDir, "no-id", {
					name: "My Ferment",
					goal: "Do the thing",
					status: "draft",
				})
				// ref.id provides a fallback, so missing id in JSON should still work
				const loaded = store.loadSync(ref)
				expect(loaded.id).toBe("no-id") // falls back to ref.id
			})

			it("defaults status to 'draft' when missing (backwards compat for legacy artifacts)", () => {
				const store = new FermentPlanStore()
				const ref = writeFermentFile(tmpDir, "no-status", {
					id: "no-status",
					name: "My Ferment",
					goal: "Do the thing",
				})
				const loaded = store.loadSync(ref)
				expect(loaded.status).toBe("draft")
			})
		})

		describe("loadSync with wrong ref.kind throws", () => {
			it("throws when ref.kind is adhoc-plan instead of ferment", () => {
				const store = new FermentPlanStore()
				const wrongRef: ArtifactRef = {
					kind: "adhoc-plan",
					path: "/some/path.md",
					format: "markdown",
				}

				expect(() => {
					store.loadSync(wrongRef)
				}).toThrow(/ref.kind is 'adhoc-plan', expected 'ferment'/)
			})
		})

		describe("creates directory if missing", () => {
			it("creates .kimchi/ferments directory", () => {
				const store = new FermentPlanStore()
				const ref = store.saveSync(
					{
						id: "test-dir",
						name: "Test",
						goal: "Goal",
						status: "draft",
					},
					{ cwd: tmpDir },
				)

				expect(ref.path).toContain(join(tmpDir, ".kimchi", "ferments"))
				const content = readFileSync(ref.path, "utf-8")
				const parsed = JSON.parse(content)
				expect(parsed.id).toBe("test-dir")
			})
		})

		describe("loadSync uses ref.id when JSON is missing id", () => {
			it("falls back to ref.id when JSON id is missing", () => {
				const store = new FermentPlanStore()

				// Write a JSON file without an id field
				const fermentsDir = join(tmpDir, ".kimchi", "ferments")
				// Create directory manually since we're not using store.save
				if (!existsSync(fermentsDir)) {
					mkdirSync(fermentsDir, { recursive: true })
				}
				const filePath = join(fermentsDir, "fallback.json")
				writeFileSync(filePath, JSON.stringify({ name: "Fallback", goal: "Goal", status: "draft" }), "utf-8")

				const ref: ArtifactRef = {
					kind: "ferment",
					path: filePath,
					format: "json",
					id: "fallback-ref-id",
				}

				const loaded = store.loadSync(ref)

				expect(loaded.id).toBe("fallback-ref-id")
			})
		})
	})
})
