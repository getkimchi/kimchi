import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentCreatedSkillReport } from "../skills-manager/usage.js"

// Mock the usage module
vi.mock("../skills-manager/usage.js", () => ({
	agentCreatedReport: vi.fn(),
	STATE_ACTIVE: "active",
	STATE_STALE: "stale",
	STATE_ARCHIVED: "archived",
}))

import { agentCreatedReport } from "../skills-manager/usage.js"
import { applyAutoTransitions } from "./auto-transitions.js"

const mockAgentCreatedReport = agentCreatedReport as ReturnType<typeof vi.fn>

describe("applyAutoTransitions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("returns proper TransitionProposal shape", () => {
		it("returns all required fields", async () => {
			mockAgentCreatedReport.mockResolvedValue([])

			const result = await applyAutoTransitions()

			expect(result).toHaveProperty("checked")
			expect(result).toHaveProperty("proposeStale")
			expect(result).toHaveProperty("proposeArchive")
			expect(result).toHaveProperty("proposeReactivate")
		})

		it("returns empty arrays when no skills exist", async () => {
			mockAgentCreatedReport.mockResolvedValue([])

			const result = await applyAutoTransitions()

			expect(result.checked).toHaveLength(0)
			expect(result.proposeStale).toHaveLength(0)
			expect(result.proposeArchive).toHaveLength(0)
			expect(result.proposeReactivate).toHaveLength(0)
		})
	})

	describe("skills unused > 30 days are proposed for stale", () => {
		it("proposes stale for active skill with activity > 30 days ago", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "unused-skill",
					pinned: false,
					state: "active",
					created_at: thirtyFiveDaysAgo.toISOString(),
					last_activity_at: thirtyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeStale).toContain("unused-skill")
			expect(result.proposeArchive).not.toContain("unused-skill")
			expect(result.proposeReactivate).not.toContain("unused-skill")
		})

		it("does NOT propose stale for skill with activity <= 30 days ago", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "recent-skill",
					pinned: false,
					state: "active",
					created_at: twentyDaysAgo.toISOString(),
					last_activity_at: twentyDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeStale).not.toContain("recent-skill")
		})

		it("uses created_at when last_activity_at is missing", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "never-used-skill",
					pinned: false,
					state: "active",
					created_at: thirtyFiveDaysAgo.toISOString(),
					// no last_activity_at
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeStale).toContain("never-used-skill")
		})
	})

	describe("skills unused > 90 days are proposed for archive", () => {
		it("proposes archive for active skill with activity > 90 days ago", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "very-old-skill",
					pinned: false,
					state: "active",
					created_at: ninetyFiveDaysAgo.toISOString(),
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeArchive).toContain("very-old-skill")
		})

		it("proposes archive for stale skill with activity > 90 days ago", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "stale-old-skill",
					pinned: false,
					state: "stale",
					created_at: ninetyFiveDaysAgo.toISOString(),
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeArchive).toContain("stale-old-skill")
		})

		it("does NOT propose archive for already archived skill", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "already-archived-skill",
					pinned: false,
					state: "archived",
					created_at: ninetyFiveDaysAgo.toISOString(),
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeArchive).not.toContain("already-archived-skill")
		})

		it("prioritizes archive over stale when skill is active but > 90 days old", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "old-active-skill",
					pinned: false,
					state: "active",
					created_at: ninetyFiveDaysAgo.toISOString(),
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeArchive).toContain("old-active-skill")
			expect(result.proposeStale).not.toContain("old-active-skill")
		})
	})

	describe("stale skills with recent activity are proposed for reactivate", () => {
		it("proposes reactivate for stale skill with activity > 30 days ago", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000)
			const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "reactivated-skill",
					pinned: false,
					state: "stale",
					created_at: thirtyFiveDaysAgo.toISOString(),
					last_activity_at: fiveDaysAgo.toISOString(), // recent activity
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeReactivate).toContain("reactivated-skill")
		})

		it("does NOT propose reactivate for already active skill", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "already-active-skill",
					pinned: false,
					state: "active",
					created_at: fiveDaysAgo.toISOString(),
					last_activity_at: fiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeReactivate).not.toContain("already-active-skill")
		})

		it("does NOT propose reactivate for stale skill that is still > 30 days old", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "still-stale-skill",
					pinned: false,
					state: "stale",
					created_at: sixtyDaysAgo.toISOString(),
					last_activity_at: sixtyDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeReactivate).not.toContain("still-stale-skill")
		})
	})

	describe("pinned skills are skipped", () => {
		it("does NOT propose any transition for pinned skill", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "important-pinned-skill",
					pinned: true,
					state: "active",
					created_at: ninetyFiveDaysAgo.toISOString(),
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.checked).toContain("important-pinned-skill")
			expect(result.proposeStale).not.toContain("important-pinned-skill")
			expect(result.proposeArchive).not.toContain("important-pinned-skill")
			expect(result.proposeReactivate).not.toContain("important-pinned-skill")
		})

		it("pinned stale skill is not proposed for reactivate", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "pinned-stale-skill",
					pinned: true,
					state: "stale",
					created_at: "2026-01-01T00:00:00Z",
					last_activity_at: fiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.proposeReactivate).not.toContain("pinned-stale-skill")
		})
	})

	describe("edge cases", () => {
		it("handles skill with no created_at (uses now as anchor)", async () => {
			const now = new Date("2026-05-07T10:00:00Z")

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "mystery-skill",
					pinned: false,
					state: "active",
					// no created_at, no last_activity_at
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			// With anchor = now, it should not be proposed for anything
			expect(result.proposeStale).not.toContain("mystery-skill")
			expect(result.proposeArchive).not.toContain("mystery-skill")
		})

		it("checks all skills and tracks them", async () => {
			const now = new Date("2026-05-07T10:00:00Z")
			const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000)
			const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)

			const skills: AgentCreatedSkillReport[] = [
				{
					name: "skill-1",
					pinned: false,
					state: "active",
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
				{
					name: "skill-2",
					pinned: false,
					state: "stale",
					last_activity_at: fiveDaysAgo.toISOString(),
				},
				{
					name: "skill-3",
					pinned: true,
					state: "active",
					last_activity_at: ninetyFiveDaysAgo.toISOString(),
				},
			]
			mockAgentCreatedReport.mockResolvedValue(skills)

			const result = await applyAutoTransitions(now)

			expect(result.checked).toContain("skill-1")
			expect(result.checked).toContain("skill-2")
			expect(result.checked).toContain("skill-3")
			expect(result.proposeArchive).toContain("skill-1")
			expect(result.proposeReactivate).toContain("skill-2")
			// skill-3 is pinned and should not be in any proposal
			expect(result.proposeArchive).not.toContain("skill-3")
		})
	})
})
