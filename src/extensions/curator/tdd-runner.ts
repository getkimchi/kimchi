import { spawnSubagent } from "../subagent.js"
import type { SubagentBaselineResult, SubagentVerifyResult } from "./types.js"

interface REDInput {
	task: string
	memberSkills: string[] // Only the skills being consolidated — not all skills
	skillsDir: string
}

interface REFACTORInput {
	task: string
	umbrellaName: string
	skillsDir: string
}

export async function runREDBaseline(input: REDInput): Promise<SubagentBaselineResult> {
	// Only exclude the member skills being consolidated — not all skills
	const excluded = input.memberSkills.length > 0 ? `Do NOT use these skills: ${input.memberSkills.join(", ")}` : ""

	const prompt = `Task: ${input.task}
${excluded ? `${excluded}\n\n` : ""}If you need knowledge from these skills, figure it out yourself or note what you're missing.

Run the task and report: what you did, what tools you used, what gaps you encountered.`

	const output = await spawnSubagent({ prompt, model: "gemini-3-pro-preview" })

	return {
		phase: "RED",
		prompt: input.task,
		output,
		skillsUsed: extractSkillsUsed(output),
		skillsNeeded: input.memberSkills,
		gapsIdentified: extractGaps(output),
	}
}

export async function runREFACTORVerify(input: REFACTORInput): Promise<SubagentVerifyResult> {
	const prompt = `Task: ${input.task}
Use the "${input.umbrellaName}" skill to complete this task.
Report what you did and whether you used the skill.`

	const output = await spawnSubagent({ prompt, model: "gemini-3-pro-preview" })

	return {
		phase: "REFACTOR",
		prompt: input.task,
		output,
		umbrellaUsed: output.toLowerCase().includes(input.umbrellaName.toLowerCase()),
		behaviors: extractBehaviors(output),
	}
}

function extractSkillsUsed(output: string): string[] {
	const skillPattern = /skill[:\s]+([a-z-]+)/gi
	const matches = output.match(skillPattern)
	return matches ? [...new Set(matches.map((m: string) => m.replace(/skill[:\s]+/i, "")))] : []
}

function extractGaps(output: string): string[] {
	const gaps: string[] = []
	if (/couldn'?t find|no skill|missing guidance/i.test(output)) {
		gaps.push("Agent could not find needed skill guidance")
	}
	if (/guess|trial|error|fail/i.test(output)) {
		gaps.push("Agent fell back to trial-and-error")
	}
	return gaps
}

function extractBehaviors(output: string): string[] {
	const behaviors: string[] = []
	if (output.includes("used")) behaviors.push("used_skill")
	if (output.includes("found")) behaviors.push("found_guidance")
	if (output.includes("tried") || output.includes("attempted")) {
		behaviors.push("attempted_directly")
	}
	return behaviors
}
