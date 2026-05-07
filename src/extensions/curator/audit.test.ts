import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateAuditDigest, writeAuditReport } from "./audit.js"

describe("generateAuditDigest", () => {
	it("computes skillCountAfter correctly", () => {
		const consolidations = [
			{
				umbrella: "umbrella-skill",
				members: ["skill-a", "skill-b"],
				strategy: "merge_into_existing" as const,
				rationale: "test",
				referencesCreated: [],
			},
		]

		const digest = generateAuditDigest(10, consolidations)
		// 10 - 2 absorbed + 1 umbrella = 9
		expect(digest.skillCountAfter).toBe(9)
	})

	it("computes skillCountAfter correctly with multiple consolidations", () => {
		const consolidations = [
			{
				umbrella: "umbrella-1",
				members: ["a", "b"],
				strategy: "merge_into_existing" as const,
				rationale: "test",
				referencesCreated: [],
			},
			{
				umbrella: "umbrella-2",
				members: ["c", "d", "e"],
				strategy: "merge_into_existing" as const,
				rationale: "test",
				referencesCreated: [],
			},
		]

		const digest = generateAuditDigest(20, consolidations)
		// 20 - 2 - 3 + 2 umbrellas = 17
		expect(digest.skillCountAfter).toBe(17)
	})

	it("includes timestamp in ISO format", () => {
		const digest = generateAuditDigest(5, [])
		expect(digest.timestamp).toBeDefined()
		expect(() => new Date(digest.timestamp)).not.toThrow()
	})

	it("includes all consolidations", () => {
		const consolidations = [
			{
				umbrella: "skill-1",
				members: ["a", "b", "c"],
				strategy: "merge_into_existing" as const,
				rationale: "rationale-1",
				referencesCreated: ["ref-1"],
			},
			{
				umbrella: "skill-2",
				members: ["d", "e"],
				strategy: "create_new" as const,
				rationale: "rationale-2",
				referencesCreated: [],
			},
		]

		const digest = generateAuditDigest(10, consolidations)
		expect(digest.consolidations).toHaveLength(2)
		expect(digest.consolidations[0].umbrella).toBe("skill-1")
		expect(digest.consolidations[1].umbrella).toBe("skill-2")
	})

	it("includes autoTransitionsApplied", () => {
		const autoTransitions = [{ name: "test-skill", from: "stale", to: "archived" }]

		const digest = generateAuditDigest(5, [], autoTransitions)
		expect(digest.autoTransitionsApplied).toHaveLength(1)
		expect(digest.autoTransitionsApplied[0]).toEqual(autoTransitions[0])
	})

	it("defaults autoTransitionsApplied to empty array", () => {
		const digest = generateAuditDigest(5, [])
		expect(digest.autoTransitionsApplied).toEqual([])
	})

	it("includes rollbacks", () => {
		const rollbacks = [{ timestamp: "2024-01-01T00:00:00Z", backupDir: "/backup/1", reason: "test" }]

		const digest = generateAuditDigest(5, [], [], rollbacks)
		expect(digest.rollbacks).toHaveLength(1)
		expect(digest.rollbacks[0].reason).toBe("test")
	})

	it("defaults rollbacks to empty array", () => {
		const digest = generateAuditDigest(5, [])
		expect(digest.rollbacks).toEqual([])
	})
})

describe("writeAuditReport", () => {
	const testDir = "/tmp/curator-audit-test"

	beforeEach(async () => {
		// Clean up test directory before each test
		try {
			await rm(testDir, { recursive: true })
		} catch {
			// Ignore if doesn't exist
		}
	})

	afterEach(async () => {
		// Clean up after each test
		try {
			await rm(testDir, { recursive: true })
		} catch {
			// Ignore if doesn't exist
		}
	})

	it("writes both JSON and markdown files", async () => {
		const digest = generateAuditDigest(10, [])

		await writeAuditReport(digest, testDir)

		const jsonPath = join(testDir, "audit.json")
		const mdPath = join(testDir, "REPORT.md")

		const jsonContent = await readFile(jsonPath, "utf-8")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(jsonContent).toBeTruthy()
		expect(mdContent).toBeTruthy()
	})

	it("writes valid JSON in audit.json", async () => {
		const digest = generateAuditDigest(5, [])

		await writeAuditReport(digest, testDir)

		const jsonPath = join(testDir, "audit.json")
		const jsonContent = await readFile(jsonPath, "utf-8")
		const parsed = JSON.parse(jsonContent)

		expect(parsed.skillCountBefore).toBe(5)
		expect(parsed.timestamp).toBeDefined()
	})

	it("writes markdown with header sections", async () => {
		const digest = generateAuditDigest(10, [])

		await writeAuditReport(digest, testDir)

		const mdPath = join(testDir, "REPORT.md")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(mdContent).toContain("# Curator Audit Report")
		expect(mdContent).toContain("**Timestamp:**")
		expect(mdContent).toContain("**Skill Count:**")
		expect(mdContent).toContain("**Delta:**")
	})

	it("writes consolidations section in markdown", async () => {
		const consolidations = [
			{
				umbrella: "my-umbrella",
				members: ["skill-a", "skill-b"],
				strategy: "merge_into_existing" as const,
				rationale: "These skills overlap",
				referencesCreated: ["ref-1"],
			},
		]

		const digest = generateAuditDigest(10, consolidations)

		await writeAuditReport(digest, testDir)

		const mdPath = join(testDir, "REPORT.md")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(mdContent).toContain("## Consolidations")
		expect(mdContent).toContain("### my-umbrella")
		expect(mdContent).toContain("**Strategy:** merge_into_existing")
		expect(mdContent).toContain("**Rationale:** These skills overlap")
		expect(mdContent).toContain("**Absorbed:** skill-a, skill-b")
		expect(mdContent).toContain("**References created:** ref-1")
	})

	it("writes auto-transitions section in markdown", async () => {
		const autoTransitions = [
			{ name: "stale-skill", from: "stale", to: "archived" },
			{ name: "another-skill", from: "active", to: "stale" },
		]

		const digest = generateAuditDigest(5, [], autoTransitions)

		await writeAuditReport(digest, testDir)

		const mdPath = join(testDir, "REPORT.md")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(mdContent).toContain("## Auto-Transitions")
		expect(mdContent).toContain("stale-skill: stale → archived")
		expect(mdContent).toContain("another-skill: active → stale")
	})

	it("writes rollbacks section in markdown", async () => {
		const rollbacks = [{ timestamp: "2024-01-01T10:00:00Z", backupDir: "/backup/test", reason: "Error occurred" }]

		const digest = generateAuditDigest(5, [], [], rollbacks)

		await writeAuditReport(digest, testDir)

		const mdPath = join(testDir, "REPORT.md")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(mdContent).toContain("## Rollbacks")
		expect(mdContent).toContain("2024-01-01T10:00:00Z: Error occurred (/backup/test)")
	})

	it("omits section headers when no data", async () => {
		const digest = generateAuditDigest(5, [])

		await writeAuditReport(digest, testDir)

		const mdPath = join(testDir, "REPORT.md")
		const mdContent = await readFile(mdPath, "utf-8")

		expect(mdContent).not.toContain("## Consolidations")
		expect(mdContent).not.toContain("## Auto-Transitions")
		expect(mdContent).not.toContain("## Rollbacks")
	})
})
