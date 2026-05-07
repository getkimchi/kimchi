import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildProjectedInventory } from "./inventory.js"
import type { SkillMetadata, TransitionProposal } from "./types.js"

// We need to mock fs/promises before importing inventory module
vi.mock("node:fs/promises", () => ({
	readdir: vi.fn(),
	readFile: vi.fn(),
}))

// Mock the usage module
vi.mock("../skills-manager/usage.js", () => ({
	agentCreatedReport: vi.fn(),
}))

// Import these after mocks are set up
import { readFile, readdir } from "node:fs/promises"
import { agentCreatedReport } from "../skills-manager/usage.js"
import { inventoryAgentSkills } from "./inventory.js"

describe("inventoryAgentSkills", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reads frontmatter from SKILL.md files and filters agent-created skills", async () => {
		// Set up agentCreatedReport mock
		vi.mocked(agentCreatedReport).mockResolvedValue([
			{ name: "test-skill", pinned: false, state: "active" },
			{ name: "another-skill", pinned: true, state: "stale" },
		])

		// Set up readdir to return skill directories
		vi.mocked(readdir).mockResolvedValue([
			{ isDirectory: () => true, name: "test-skill" },
			{ isDirectory: () => true, name: "another-skill" },
			{ isDirectory: () => true, name: "not-agent-created" },
			{ isDirectory: () => false, name: "README.md" },
			{ isDirectory: () => true, name: ".hidden" },
		] as unknown as Awaited<ReturnType<typeof readdir>>)

		// Set up frontmatter content
		vi.mocked(readFile).mockImplementation(async (path: unknown) => {
			const pathStr = String(path)
			if (pathStr.includes("test-skill")) {
				return `---
name: test-skill
description: A test skill
triggers:
  - test trigger
category: testing
---

# Test Skill`
			}
			if (pathStr.includes("another-skill")) {
				return `---
name: another-skill
description: Another skill
triggers:
  - another trigger
category: other
---

# Another Skill`
			}
			throw new Error("ENOENT: no such file")
		})

		const skills = await inventoryAgentSkills("/mock/skills/dir")

		expect(skills).toHaveLength(2)
		expect(skills.map((s) => s.name)).toEqual(["test-skill", "another-skill"])
		expect(skills[0]).toMatchObject({
			name: "test-skill",
			description: "A test skill",
			triggers: ["test trigger"],
			category: "testing",
			agentCreated: true,
		})
	})

	it("skips skill directories that cannot be read", async () => {
		vi.mocked(agentCreatedReport).mockResolvedValue([{ name: "unreadable-skill", pinned: false, state: "active" }])

		vi.mocked(readdir).mockResolvedValue([{ isDirectory: () => true, name: "unreadable-skill" }] as unknown as Awaited<
			ReturnType<typeof readdir>
		>)

		vi.mocked(readFile).mockRejectedValue(new Error("ENOENT: no such file or directory"))

		const skills = await inventoryAgentSkills("/mock/skills/dir")

		expect(skills).toHaveLength(0)
	})

	it("does not include skills that are not agent-created", async () => {
		vi.mocked(agentCreatedReport).mockResolvedValue([{ name: "agent-created-skill", pinned: false, state: "active" }])

		vi.mocked(readdir).mockResolvedValue([
			{ isDirectory: () => true, name: "agent-created-skill" },
			{ isDirectory: () => true, name: "not-agent-created" },
		] as unknown as Awaited<ReturnType<typeof readdir>>)

		vi.mocked(readFile).mockImplementation(async (path: unknown) => {
			const pathStr = String(path)
			if (pathStr.includes("agent-created-skill")) {
				return `---
name: agent-created-skill
description: Agent created
triggers: []
category: testing
---

# Skill`
			}
			throw new Error("ENOENT")
		})

		const skills = await inventoryAgentSkills("/mock/skills/dir")

		expect(skills).toHaveLength(1)
		expect(skills[0].name).toBe("agent-created-skill")
	})
})

describe("buildProjectedInventory", () => {
	it("filters out skills proposed for archive", () => {
		const skills: SkillMetadata[] = [
			{
				name: "keep-skill",
				description: "",
				triggers: [],
				category: "",
				state: "active",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
			{
				name: "archive-skill",
				description: "",
				triggers: [],
				category: "",
				state: "active",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
			{
				name: "another-keep",
				description: "",
				triggers: [],
				category: "",
				state: "stale",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
		]

		const proposal: TransitionProposal = {
			checked: [],
			proposeStale: [],
			proposeArchive: ["archive-skill"],
			proposeReactivate: [],
		}

		const result = buildProjectedInventory(skills, proposal)

		expect(result).toHaveLength(2)
		expect(result.map((s) => s.name)).toEqual(["keep-skill", "another-keep"])
	})

	it("filters out already archived skills", () => {
		const skills: SkillMetadata[] = [
			{
				name: "active-skill",
				description: "",
				triggers: [],
				category: "",
				state: "active",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
			{
				name: "archived-skill",
				description: "",
				triggers: [],
				category: "",
				state: "archived",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
		]

		const proposal: TransitionProposal = {
			checked: [],
			proposeStale: [],
			proposeArchive: [],
			proposeReactivate: [],
		}

		const result = buildProjectedInventory(skills, proposal)

		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("active-skill")
	})

	it("returns empty array when all skills are filtered out", () => {
		const skills: SkillMetadata[] = [
			{
				name: "archived-skill",
				description: "",
				triggers: [],
				category: "",
				state: "archived",
				useCount: 0,
				lastUsedAt: null,
				agentCreated: true,
			},
		]

		const proposal: TransitionProposal = {
			checked: [],
			proposeStale: ["archived-skill"],
			proposeArchive: [],
			proposeReactivate: [],
		}

		const result = buildProjectedInventory(skills, proposal)

		expect(result).toHaveLength(0)
	})

	it("handles empty skills array", () => {
		const proposal: TransitionProposal = {
			checked: [],
			proposeStale: [],
			proposeArchive: ["some-skill"],
			proposeReactivate: [],
		}

		const result = buildProjectedInventory([], proposal)

		expect(result).toHaveLength(0)
	})
})
