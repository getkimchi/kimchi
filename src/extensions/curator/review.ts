import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import type { SkillManager } from "../skills-manager/skill-manager.js"
import { agentCreatedReport } from "../skills-manager/usage.js"
import { buildSubagentArgs, getSubagentInvocation, spawnSubagent } from "../subagent.js"
import { loadState, saveState } from "./state.js"

export interface CuratorCandidate {
	name: string
	description: string
	state: string
}

export interface CuratorSummary {
	consolidations: Array<{ from: string; into: string; reason: string }>
	prunings: Array<{ name: string; reason: string }>
}

export function buildCuratorPrompt(candidates: CuratorCandidate[]): string {
	const candidateList =
		candidates.length === 0
			? "(no agent_created skills to review)"
			: candidates.map((c) => `- ${c.name} [${c.state}]: ${c.description}`).join("\n")

	return `You are the Kimchi skill curator. Your job is **consolidation only** — not gap-finding, not creating new skills from scratch.

## Your scope

- **Agent-created skills only** — the candidate list below is pre-filtered. Bundled or harness skills are never touched.
- **No deletion** — only archive via \`skill_manage action=delete\` (archives are recoverable from .archive/).
- **Pinned skills are off-limits** — skip entirely.
- **Two consolidation strategies:**
  1. Merge into existing umbrella: patch it, archive siblings with \`absorbed_into\`
  2. Create new umbrella: \`skill_manage action=create\`, then archive absorbed skills

## Tools available

You have three tools: \`skill_manage\`, \`skill_view\`, \`skill_list\`. No terminal, no bash.

## Candidate skills (agent_created, capped at 40)

${candidateList}

## Instructions

1. Review the candidate list. Use \`skill_view\` to read any skill's full content before deciding.
2. Identify clusters of overlapping skills that can be consolidated under an umbrella.
3. Execute consolidations using \`skill_manage\`. When archiving a skill, set \`absorbed_into\` to the umbrella name.
4. After all tool calls are complete, output the structured summary below as your **final message**.

## Required output (emit after all tool calls)

\`\`\`yaml
consolidations:
  - from: <absorbed-skill-name>
    into: <umbrella-skill-name>
    reason: <one sentence>
prunings:
  - name: <archived-skill-name>
    reason: <one sentence>
\`\`\`

Every skill you archived must appear in exactly one list. If nothing was consolidated, output empty lists.`
}

export function parseCuratorOutput(text: string): CuratorSummary | null {
	const stripped = text.replace(/```ya?ml\n?/g, "").replace(/```\n?/g, "")
	const match = stripped.match(/(consolidations\s*:[\s\S]*|prunings\s*:[\s\S]*)/)
	if (!match) return null

	try {
		const parsed = parseYaml(match[0]) as Partial<CuratorSummary>
		return {
			consolidations: Array.isArray(parsed.consolidations) ? parsed.consolidations : [],
			prunings: Array.isArray(parsed.prunings) ? parsed.prunings : [],
		}
	} catch {
		return null
	}
}

async function readSkillDescription(skillPath: string): Promise<string> {
	try {
		const content = await readFile(join(skillPath, "SKILL.md"), "utf-8")
		const match = content.match(/^description:\s*(.+)$/m)
		return match ? match[1].trim() : "(no description)"
	} catch {
		return "(unreadable)"
	}
}

export async function buildCandidateList(
	manager: SkillManager,
	skillsDir: string,
	cap = 40,
): Promise<CuratorCandidate[]> {
	const [inventory, usageReports] = await Promise.all([manager.listInventory(), agentCreatedReport(skillsDir)])

	const stateMap = new Map(usageReports.map((r) => [r.name, r.state ?? "active"]))

	const agentCreated = inventory.filter((s) => s.agent_created).slice(0, cap)

	return Promise.all(
		agentCreated.map(async (s) => ({
			name: s.name,
			description: await readSkillDescription(s.path),
			state: stateMap.get(s.name) ?? "active",
		})),
	)
}

export interface RunCuratorReviewOptions {
	provider: string
	model: string
	statePath: string
	skillsDir: string
	manager: SkillManager
	background?: boolean
}

function collectExtensionArgs(): string[] {
	const result: string[] = []
	const argv = process.argv
	for (let i = 0; i < argv.length; i++) {
		if ((argv[i] === "-e" || argv[i] === "--extension") && i + 1 < argv.length) {
			result.push("-e", argv[i + 1])
			i++
		} else if (argv[i].startsWith("--extension=")) {
			result.push("-e", argv[i].slice("--extension=".length))
		}
	}
	return result
}

export async function runCuratorReview(opts: RunCuratorReviewOptions): Promise<CuratorSummary | null> {
	const { provider, model, statePath, manager, background = false } = opts

	const state = await loadState(statePath)
	await saveState(statePath, { ...state, running: true })

	const candidates = await buildCandidateList(manager, opts.skillsDir)
	const prompt = buildCuratorPrompt(candidates)

	const finalize = async (output: string, error?: string): Promise<CuratorSummary | null> => {
		const summary = error ? null : parseCuratorOutput(output)
		const current = await loadState(statePath)
		await saveState(statePath, {
			...current,
			running: false,
			last_run_at: new Date().toISOString(),
			run_count: current.run_count + 1,
			last_run_summary: error
				? `error: ${error}`
				: summary
					? `${summary.consolidations.length} merged, ${summary.prunings.length} archived`
					: "completed (no structured output)",
		})
		return summary
	}

	if (background) {
		const args = buildSubagentArgs({ provider, model, prompt }, [], collectExtensionArgs())
		const invocation = getSubagentInvocation(args)
		const proc = spawn(invocation.command, invocation.args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		})
		let output = ""
		proc.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString()
		})
		proc.on("close", () => {
			void finalize(output)
		})
		proc.on("error", (err) => {
			void finalize("", err.message)
		})
		return null
	}

	try {
		const output = await spawnSubagent({ provider, model, prompt })
		return finalize(output)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		await finalize("", msg)
		throw err
	}
}
