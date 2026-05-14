/**
 * Formatters that produce plain-text representations of ferment state.
 *
 * Used by:
 * - `/progress` headless fallback (formatFermentStatus)
 * - planner system-prompt supplement (formatDecisionsAndMemories, formatScopingContext)
 * - resume nudges in plan mode (stripToolRefs)
 */

import { computeStats } from "../../ferment/stats.js"
import type { Ferment } from "../../ferment/types.js"

export function formatFermentStatus(f: Ferment): string {
	const total = f.phases.length
	const done = f.phases.filter((p) => p.status === "completed").length
	const active = f.phases.filter((p) => p.status === "active").length
	const planned = f.phases.filter((p) => p.status === "planned").length
	const wt = f.worktree
	const wtBranch = wt.branch ?? "n/a"
	const wtPath = wt.path ?? process.cwd()
	const wtCommit = wt.commit ? wt.commit.slice(0, 7) : "n/a"

	const stats = computeStats(f)

	const lines: string[] = [
		`🍺 Ferment: "${f.name}"  •  ${f.status.toUpperCase()}  •  ${f.mode} mode`,
		`   📍 ${wtBranch} @ ${wtCommit} — ${wtPath}`,
		`   Phases: ${total} total, ${planned} planned, ${active} active, ${done} done`,
	]

	if (f.goal) lines.push(`   🎯 ${f.goal}`)

	if (total > 0) {
		for (const p of f.phases) {
			const m = p.id === f.activePhaseId ? "▶" : p.status === "completed" ? "✓" : "○"
			lines.push(`   ${m} Phase ${p.index}: ${p.name} [${p.status}]`)
			for (const s of p.steps) {
				const sm = s.status === "done" || s.status === "verified" ? "✓" : s.status === "skipped" ? "⊘" : "○"
				let elapsed = ""
				if (s.startedAt) {
					const end = s.completedAt ? new Date(s.completedAt) : new Date()
					const ms = end.getTime() - new Date(s.startedAt).getTime()
					elapsed = ms > 0 ? ` ⏱ ${(ms / 1000).toFixed(1)}s` : ""
				}
				const modelTag = s.workerModel ? ` 🧠 ${s.workerModel}` : ""
				// `?` suffix on grade indicates the judge was unavailable when this
				// step was scored — the visible letter is a placeholder, not a real signal.
				const gradeTag = s.grade ? ` 📊 ${s.grade.grade}${s.grade.unavailable ? "?" : ""}` : ""
				lines.push(`      ${sm} ${s.description}${elapsed}${modelTag}${gradeTag} [${s.status}]`)
				if (s.summary) {
					// Worker-written summary on a continuation line, symmetric with phase summary.
					lines.push(`         ↳ ${s.summary}`)
				}
			}
		}
	}

	if (f.decisions.length || f.memories.length) {
		lines.push(`   Decisions: ${f.decisions.length}  •  Memories: ${f.memories.length}`)
	}

	lines.push(`   ⏱️  Duration: ${(stats.timing.totalDurationMs / 60000).toFixed(1)} min`)
	if (stats.timing.averageStepDurationMs) {
		lines.push(`   ⏱️  Avg step: ${(stats.timing.averageStepDurationMs / 1000).toFixed(1)} s`)
	}
	if (stats.steps.running > 0 || stats.steps.planned > 0) {
		lines.push(
			`   👟 Steps: ${stats.steps.done + stats.steps.skipped + stats.steps.failed} / ${stats.steps.total} done, ${stats.steps.running} running, ${stats.steps.planned} planned`,
		)
	}
	lines.push(`   ID: ${f.id}  •  Created: ${f.createdAt}`)
	return lines.join("\n")
}

/** Markdown blocks with all decisions and memories — for system-prompt injection. */
export function formatDecisionsAndMemories(f: Ferment): string {
	const parts: string[] = []
	if (f.decisions.length > 0) {
		parts.push(
			`## Past Decisions\n${f.decisions.map((d) => `- ${d.id}: **${d.title}** — ${d.description}`).join("\n")}`,
		)
	}
	if (f.memories.length > 0) {
		parts.push(
			`## Accumulated Knowledge\n${f.memories.map((m) => `- ${m.id} [${m.category}]: ${m.content}`).join("\n")}`,
		)
	}
	return parts.join("\n\n")
}

/** Captured scoping answers as a markdown block — injected into planner context. */
export function formatScopingContext(f: Ferment): string {
	const lines: string[] = []
	if (f.scoping.goal) lines.push(`Goal: ${f.scoping.goal.answer}`)
	if (f.scoping.criteria) lines.push(`Success criteria: ${f.scoping.criteria.answer}`)
	if (f.scoping.constraints) lines.push(`Constraints: ${f.scoping.constraints.answer}`)
	return lines.length > 0 ? `## Ferment Specification\n${lines.join("\n")}` : ""
}

/**
 * Strip references to specific tool names from engine messages, for plan mode.
 * Match "Use <tool_name> to ..." up to the next sentence boundary or newline —
 * `[^.\n]*` so we never swallow across sentences.
 */
export function stripToolRefs(text: string): string {
	return text
		.replace(/Use \w+ to\b[^.\n]*\.?/g, (m) => m.replace(/\w+_\w+/, "..."))
		.replace(/call \w+\b/g, "decide")
		.replace(/via \w+_\w+/g, "by deciding")
}
