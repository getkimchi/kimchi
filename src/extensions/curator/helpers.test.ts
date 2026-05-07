import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawnSubagent } from "../subagent.js"
import { getAuditDir, readMemberContents, readSkillContent, synthesizeUmbrellaContent } from "./helpers.js"
import type { ConsolidationProposal } from "./types.js"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}))

vi.mock("../subagent.js", () => ({
	spawnSubagent: vi.fn(),
}))

const mockReadFile = vi.mocked((await import("node:fs/promises")).readFile)
const mockSpawnSubagent = vi.mocked(spawnSubagent)

describe("helpers", () => {
	describe("readSkillContent", () => {
		it("reads correct path", async () => {
			mockReadFile.mockResolvedValueOnce("# Skill content")
			const result = await readSkillContent("test-skill", "/skills")
			expect(result).toBe("# Skill content")
			expect(mockReadFile).toHaveBeenCalledWith("/skills/test-skill/SKILL.md", "utf-8")
		})
	})

	describe("readMemberContents", () => {
		it("returns all member contents", async () => {
			mockReadFile
				.mockResolvedValueOnce("# Skill A")
				.mockResolvedValueOnce("# Skill B")
				.mockResolvedValueOnce("# Skill C")

			const result = await readMemberContents(["skill-a", "skill-b", "skill-c"], "/skills")

			expect(result).toEqual({
				"skill-a": "# Skill A",
				"skill-b": "# Skill B",
				"skill-c": "# Skill C",
			})
		})

		it("returns empty object for empty members array", async () => {
			const result = await readMemberContents([], "/skills")
			expect(result).toEqual({})
		})
	})

	describe("synthesizeUmbrellaContent", () => {
		it("calls spawnSubagent and returns result", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("# Synthesized content")
			const memberContents = { "skill-a": "## A\nContent A", "skill-b": "## B\nContent B" }
			const proposal: ConsolidationProposal = {
				umbrella: "new-umbrella",
				members: ["skill-a", "skill-b"],
				rationale: "Consolidate for simplicity",
				strategy: "create_new",
			}

			const result = await synthesizeUmbrellaContent(memberContents, proposal)

			expect(result).toBe("# Synthesized content")
			expect(mockSpawnSubagent).toHaveBeenCalledTimes(1)
			const call = mockSpawnSubagent.mock.calls[0][0]
			expect(call.model).toBe("gemini-3-pro-preview")
			expect(call.prompt).toContain("new-umbrella")
			expect(call.prompt).toContain("skill-a")
			expect(call.prompt).toContain("skill-b")
			expect(call.prompt).toContain("Consolidate for simplicity")
		})

		it("trims whitespace from result", async () => {
			mockSpawnSubagent.mockResolvedValueOnce("  \n# Trimmed content\n  ")
			const result = await synthesizeUmbrellaContent(
				{ skill: "content" },
				{ umbrella: "u", members: ["skill"], rationale: "r", strategy: "create_new" },
			)
			expect(result).toBe("# Trimmed content")
		})
	})

	describe("getAuditDir", () => {
		beforeEach(() => {
			vi.useRealTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("returns correct path format", () => {
			vi.useFakeTimers({ now: new Date("2024-01-15T10:30:45.123Z") })
			const result = getAuditDir("/memory")

			// ISO timestamp with : and . replaced by -
			expect(result).toBe("/memory/logs/curator/2024-01-15T10-30-45-123Z")
		})

		it("handles different memory dirs", () => {
			vi.useFakeTimers({ now: new Date("2024-03-20T08:00:00.000Z") })
			const result = getAuditDir("/data/memory")

			expect(result).toBe("/data/memory/logs/curator/2024-03-20T08-00-00-000Z")
		})
	})
})
