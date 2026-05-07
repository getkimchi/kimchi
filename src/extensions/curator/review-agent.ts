import { parse as parseYaml } from "yaml"
import type { CuratorReport, LogSummary, SkillMetadata, TransitionProposal } from "./types.js"

export function buildReviewPrompt(skills: SkillMetadata[], proposal: TransitionProposal, logs: LogSummary): string {
	const skillList = skills
		.map((s) => `- ${s.name}: ${s.description} (triggers: ${s.triggers.join(", ") || "none"})`)
		.join("\n")

	const summaryContext = logs.summaries.slice(-5).join("\n\n---\n\n")
	const failureContext = logs.failurePatterns
		.map(
			(f: { type: string; count: number; lastSeen: string }) =>
				`- ${f.type} (${f.count} occurrences, last: ${f.lastSeen})`,
		)
		.join("\n")

	return `You are reviewing the agent's skill library to identify:
1. Consolidation opportunities (prefix clusters that could be umbrella skills)
2. Skill gaps (topics with no matching skill)
3. Quality issues (missing descriptions, triggers)

## Skill Inventory (${skills.length} agent-created skills)
${skillList || "(no skills)"}

## Auto-Transition Proposal (from timestamps)
These state changes were computed automatically:
- checked: ${proposal.checked.length} skills
- proposeStale: ${proposal.proposeStale.length} skills
- proposeArchive: ${proposal.proposeArchive.length} skills
- proposeReactivate: ${proposal.proposeReactivate.length} skills

## Recent Session Summaries
${summaryContext || "(no recent sessions)"}

## Failure Patterns
${failureContext || "(no failures logged)"}

## Output Format
Return a YAML block with:
\`\`\`yaml
consolidation_proposals:
  - umbrella: <name>
    members: [<skill1>, <skill2>]
    rationale: <reason>
skill_gaps:
  - topic: <topic>
    evidence: <what suggests this gap>
    suggested_triggers: [<trigger1>, <trigger2>]
quality_issues:
  - skill: <name>
    issue: missing_description|missing_triggers|unclear
    suggestion: <fix>
\`\`\`

Only output the YAML block. Do not include any other text.`
}

interface LLMResponseYaml {
	consolidation_proposals?: Array<{
		umbrella: string
		members: string[]
		rationale: string
	}>
	skill_gaps?: Array<{
		topic: string
		evidence: string
		suggested_triggers: string[]
	}>
	quality_issues?: Array<{
		skill: string
		issue: string
		suggestion: string
	}>
}

export function parseLLMResponse(
	response: string,
): Pick<CuratorReport, "consolidationProposals" | "skillGaps" | "qualityIssues"> {
	try {
		// Extract YAML block if present
		const yamlMatch = response.match(/```yaml\n([\s\S]*?)```/)
		const yamlContent = yamlMatch ? yamlMatch[1] : response

		const parsed = parseYaml(yamlContent) as LLMResponseYaml | null

		if (!parsed) {
			return { consolidationProposals: [], skillGaps: [], qualityIssues: [] }
		}

		return {
			consolidationProposals: (parsed.consolidation_proposals || []).map((p) => ({
				umbrella: p.umbrella,
				members: p.members,
				rationale: p.rationale,
			})),
			skillGaps: (parsed.skill_gaps || []).map((g) => ({
				topic: g.topic,
				evidence: g.evidence,
				suggestedTriggers: g.suggested_triggers || [],
			})),
			qualityIssues: (parsed.quality_issues || []).map((q) => ({
				skill: q.skill,
				issue: q.issue as "missing_description" | "missing_triggers" | "unclear",
				suggestion: q.suggestion,
			})),
		}
	} catch {
		return { consolidationProposals: [], skillGaps: [], qualityIssues: [] }
	}
}
