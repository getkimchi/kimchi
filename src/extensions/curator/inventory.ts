import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { agentCreatedReport } from "../skills-manager/usage.js"
import type { SkillMetadata, TransitionProposal } from "./types.js"

export async function inventoryAgentSkills(skillsDir: string): Promise<SkillMetadata[]> {
	const usage = await agentCreatedReport(skillsDir)
	const agentCreatedNames = new Set(usage.map((r) => r.name))

	const skills: SkillMetadata[] = []

	// Scan for SKILL.md files in skill subdirectories
	const entries = await readdir(skillsDir, { withFileTypes: true })

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue

		const skillPath = join(skillsDir, entry.name, "SKILL.md")
		try {
			const content = await readFile(skillPath, "utf-8")
			const metadata = parseSkillFrontmatter(content)

			if (agentCreatedNames.has(metadata.name)) {
				const usageRecord = usage.find((r) => r.name === metadata.name)
				skills.push({
					...metadata,
					state: (usageRecord?.state as SkillMetadata["state"]) || "active",
					useCount: 0,
					lastUsedAt: null,
					agentCreated: true,
				})
			}
		} catch {
			// Skip files that can't be read
		}
	}

	return skills
}

function parseSkillFrontmatter(
	content: string,
): Omit<SkillMetadata, "state" | "useCount" | "lastUsedAt" | "agentCreated"> {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/)

	if (frontmatterMatch) {
		const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
		return {
			name: String(frontmatter.name || ""),
			description: String(frontmatter.description || ""),
			triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers.map(String) : [],
			category: String(frontmatter.category || ""),
		}
	}

	return { name: "", description: "", triggers: [], category: "" }
}

export function buildProjectedInventory(skills: SkillMetadata[], proposal: TransitionProposal): SkillMetadata[] {
	const archiveSet = new Set(proposal.proposeArchive)

	return skills.filter((skill) => !archiveSet.has(skill.name) && skill.state !== "archived")
}
