import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSubagent } from "../subagent.js"
import type { ConsolidationProposal } from "./types.js"

export async function readSkillContent(name: string, skillsDir: string): Promise<string> {
	const path = join(skillsDir, name, "SKILL.md")
	return await readFile(path, "utf-8")
}

export async function readMemberContents(members: string[], skillsDir: string): Promise<Record<string, string>> {
	const contents: Record<string, string> = {}
	for (const member of members) {
		contents[member] = await readSkillContent(member, skillsDir)
	}
	return contents
}

export async function synthesizeUmbrellaContent(
	memberContents: Record<string, string>,
	proposal: ConsolidationProposal,
): Promise<string> {
	const memberList = Object.entries(memberContents)
		.map(([name, content]) => `## ${name}\n${content}`)
		.join("\n\n")

	const prompt = `You are creating a class-level umbrella skill called "${proposal.umbrella}" that absorbs these member skills:

${memberList}

Rationale for consolidation: ${proposal.rationale}

Create a single SKILL.md that:
1. Has frontmatter with name, description (triggering conditions), category, triggers
2. Has a body that synthesizes all member content under appropriate section headings
3. Each section covers one former member's expertise
4. Description must be triggering conditions, NOT a workflow summary

Output ONLY the raw SKILL.md content (with --- frontmatter).`

	const result = await spawnSubagent({ prompt, model: "gemini-3-pro-preview" })
	return result.trim()
}

export function getAuditDir(memoryDir: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
	return join(memoryDir, "logs", "curator", timestamp)
}
