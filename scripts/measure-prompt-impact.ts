#!/usr/bin/env bun
// Measure the prompt/token impact of the skill-suggest changes.
// (MCP-related measurements live on the wip/mcp-discovery branch — they will
// return with the MCP adapter rework.)
//
// Run: bun scripts/measure-prompt-impact.ts
//
// Reports:
//   1. Skill-suggest reminder — the per-turn message injected after a matching
//      user prompt. One-shot cost, not per-request.
//
// Token counts are estimates at ~4 chars/token (the convention used
// throughout the harness).

import { buildSkillReminder, type SkillSuggestion } from "../src/extensions/prompt-construction/skill-suggest.js"

const estTokens = (chars: number): number => Math.round(chars / 4)

console.log("== Skill-suggest reminder (one-shot message, only when a match fires) ==\n")
const suggestions: SkillSuggestion[] = [
	{
		name: "vcs-workflow",
		description: "Safe and disciplined Git workflow — staging, committing, branching, and hook discipline.",
		filePath: "/Users/demo/.config/kimchi/harness/skills/vcs-workflow/SKILL.md",
		score: 1,
	},
	{
		name: "release-notes-helper",
		description:
			"Draft release notes from merged commits. Use when preparing a release, writing changelogs, or summarizing shipped work.",
		filePath: "/Users/demo/.config/kimchi/harness/skills/release-notes-helper/SKILL.md",
		score: 0.8,
	},
]
for (const [label, slice] of [
	["1 suggested skill", suggestions.slice(0, 1)],
	["2 suggested skills (cap)", suggestions.slice(0, 2)],
] as const) {
	const reminder = buildSkillReminder(slice)
	console.log(`  ${label}: ${reminder.length} chars (~${estTokens(reminder.length)} tok) + steer wrapper\n`)
}
console.log("  The system prompt itself is unchanged by this work — the reminder is a")
console.log("  conversation message, and nothing was added to buildSystemPrompt output.")
