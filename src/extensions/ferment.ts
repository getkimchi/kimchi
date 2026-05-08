/**
 * Ferment Extension v4
 *
 * State-driven execution: the JSON plan IS the state.
 * Interactive breakdown: the LLM guides the user through
 * a conversational flow for creating and managing ferments.
 */

import { execSync } from "node:child_process"
import { complete } from "@mariozechner/pi-ai"
import type { Api, Model } from "@mariozechner/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { ORANGE_FG, RST_FG, SUCCESS_FG, TEAL_FG, WARNING_FG } from "../ansi.js"
import { findFirstPlannedPhase, getScopingProgress, whatNext } from "../ferment/engine.js"
import { shortenTitle } from "../ferment/shorten-title.js"
import { FermentError, FermentStorage } from "../ferment/store.js"
import type { Ferment, FermentWorkMode, MemoryCategory, Phase, Step, StepResult } from "../ferment/types.js"
import { notifyFermentActive } from "./permissions/index.js"

// ─── Module state ─────────────────────────────────────────────────────────────

let activeFermentId: string | undefined
let activeFerment: Ferment | undefined
let autoModeEnabled = true
let lastHumanInputAt: Date | undefined
let widgetUpdateFn: (() => void) | undefined
let restoringModel = false
let judgeModel: Model<Api> | undefined
let judgeModelRegistry: ModelRegistry | undefined

// ─── Exported accessors (footer, CLI) ──────────────────────────────────────────

export function getActiveFerment(): Ferment | undefined {
	return activeFerment
}

/** 1-based phase index or undefined */
export function getCurrentPhaseIndex(): number | undefined {
	if (!activeFerment || !activeFerment.activePhaseId) return undefined
	const idx = activeFerment.phases.findIndex((p) => p.id === activeFerment?.activePhaseId)
	return idx >= 0 ? idx + 1 : undefined
}

/** Active phase name or undefined */
export function getCurrentPhaseName(): string | undefined {
	if (!activeFerment || !activeFerment.activePhaseId) return undefined
	return activeFerment.phases.find((p) => p.id === activeFerment?.activePhaseId)?.name
}

/** For CLI --ferment resume */
export function getActiveFermentIdForResume(): string | undefined {
	return activeFermentId
}

/** Backward compat for any code using these names */
export function getCurrentBatchIndex(): number | undefined {
	return getCurrentPhaseIndex()
}
export function getCurrentBatchName(): string | undefined {
	return getCurrentPhaseName()
}
export function getCurrentRecipe(): import("../ferment/types.js").Step[] {
	return activeFerment?.phases.find((p) => p.id === activeFerment?.activePhaseId)?.steps ?? []
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getStorage(): FermentStorage {
	return new FermentStorage()
}

function setActive(f: Ferment | undefined): void {
	activeFerment = f
	activeFermentId = f?.id
	process.env.KIMCHI_ACTIVE_FERMENT = f?.id
	notifyFermentActive(f !== undefined)
	widgetUpdateFn?.()
}

function isPlanMode(): boolean {
	if (!activeFerment) return process.env.KIMCHI_PERMISSIONS === "plan"
	return activeFerment.mode === "plan"
}

function isExecMode(): boolean {
	if (!activeFerment) return process.env.KIMCHI_PERMISSIONS !== "plan"
	return activeFerment.mode !== "plan"
}

function stripToolRefs(text: string): string {
	return text
		.replace(/Use \w+ to\b[\s\S]*?\./g, (m) => m.replace(/\w+_\w+/, "..."))
		.replace(/call \w+\b/g, "decide")
		.replace(/via \w+_\w+/g, "by deciding")
}

function appendRefEntry(pi: ExtensionAPI, fermentId: string): void {
	pi.sendMessage({
		customType: "ferment_reference",
		content: [{ type: "text", text: `active: ${fermentId}` }],
		display: false,
		details: { fermentId },
	})
}

function maybeInjectAutoNudge(pi: ExtensionAPI): void {
	if (!autoModeEnabled || !activeFerment) return
	const action = whatNext(activeFerment)
	if (action.kind === "paused" || action.kind === "complete_ferment") return

	const f = activeFerment
	const activePhase = f.phases.find((p) => p.id === f.activePhaseId)
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = activePhase ? ` · phase ${activePhase.index}/${f.phases.length} "${activePhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const breadcrumb = `Auto-nudge [${action.kind}]: "${f.name}" [${f.status}]${phaseInfo}${stepInfo}`

	pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
	pi.sendMessage(
		{
			customType: "ferment_automode_nudge",
			content: [{ type: "text", text: action.message }],
			display: false,
			details: { action: action.kind },
		},
		{ triggerTurn: true },
	)
}

function onStepCompleted(pi: ExtensionAPI): void {
	if (!activeFermentId) return
	const fresh = getStorage().get(activeFermentId)
	if (fresh) {
		setActive(fresh)
		maybeInjectAutoNudge(pi)
	}
}

function onPhaseCompleted(pi: ExtensionAPI): void {
	if (!activeFermentId) return
	const fresh = getStorage().get(activeFermentId)
	if (fresh) {
		setActive(fresh)
		// Auto-advance in exec/automode — no "Activate it?" prompt
		if (isExecMode()) {
			const next = findFirstPlannedPhase(fresh)
			if (next) {
				const s = getStorage()
				const r = s.activatePhase(fresh.id, next.id)
				if (r) setActive(r)
			}
		}
		maybeInjectAutoNudge(pi)
	}
}

interface WorktreeCheck {
	severity: "ok" | "warn" | "block"
	message?: string
}

function checkWorktree(f: Ferment): WorktreeCheck {
	const cwd = process.cwd()
	if (!cwd.startsWith(f.worktree.path)) {
		return {
			severity: "block",
			message: `You are in ${cwd}, but this ferment was created in ${f.worktree.path}. Use /ferment switch to activate a different ferment, or /ferment switch --force to override.`,
		}
	}
	if (f.worktree.branch) {
		try {
			const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: f.worktree.path,
				encoding: "utf-8",
				timeout: 1000,
			}).trim()
			if (currentBranch !== f.worktree.branch) {
				return {
					severity: "warn",
					message: `⚠️  You're on branch '${currentBranch}', but this ferment was started on '${f.worktree.branch}'. Use /ferment switch --force to override.`,
				}
			}
		} catch {
			// not a git repo or git unavailable
		}
	}
	return { severity: "ok" }
}

function findStep(f: Ferment, phaseId: string, stepId: string) {
	return f.phases.find((p) => p.id === phaseId)?.steps.find((s) => s.id === stepId)
}

/** Resolve phase by exact id → name substring → active phase. Returns undefined if not found. */
function resolvePhase(f: Ferment, phaseId: string): Phase | undefined {
	let phase = f.phases.find((p) => p.id === phaseId)
	if (!phase) {
		const needle = phaseId.toLowerCase()
		phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
	}
	if (!phase) {
		phase = f.phases.find((p) => p.status === "active")
	}
	return phase
}

/** Resolve step by exact id → step-N index format → first pending. */
function resolveStep(phase: Phase, stepId: string): import("../ferment/types.js").Step | undefined {
	let step = phase.steps.find((s) => s.id === stepId)
	if (!step) {
		// Try "step-N" index pattern
		const idxMatch = stepId.match(/(\d+)$/)
		if (idxMatch) {
			const idx = Number.parseInt(idxMatch[1], 10)
			step = phase.steps.find((s) => s.index === idx)
		}
	}
	return step
}

// ─── Progress rendering ───────────────────────────────────────────────────────

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RST_ALL = "\x1b[0m"

function pr_teal(s: string): string { return `${TEAL_FG}${s}${RST_FG}` }
function pr_orange(s: string): string { return `${ORANGE_FG}${s}${RST_FG}` }
function pr_success(s: string): string { return `${SUCCESS_FG}${s}${RST_FG}` }
function pr_warn(s: string): string { return `${WARNING_FG}${s}${RST_FG}` }
function pr_dim(s: string): string { return `${DIM}${s}${RST_ALL}` }
function pr_bold(s: string): string { return `${BOLD}${s}${RST_ALL}` }

function truncateLabel(s: string, max = 40): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m ago`
	return `${Math.floor(h / 24)}d ago`
}

function gradeColor(g: import("../ferment/types.js").Grade): string {
	switch (g) {
		case "A": return pr_success("A")
		case "B": return pr_teal("B")
		case "C": return pr_warn("C")
		case "D": return pr_orange("D")
		case "F": return pr_orange("F")
	}
}

function phaseBullet(p: Phase): string {
	switch (p.status) {
		case "active":   return pr_teal("▶")
		case "completed": return pr_success("✓")
		case "failed":   return pr_orange("✗")
		case "skipped":  return pr_dim("⊘")
		default:         return pr_dim("○")
	}
}

function stepBulletChar(status: Step["status"]): string {
	switch (status) {
		case "done":
		case "verified":  return pr_success("✓")
		case "running":   return pr_teal("▶")
		case "failed":    return pr_orange("✗")
		case "skipped":   return pr_dim("⊘")
		default:          return pr_dim("○")
	}
}

// ─── Persistent mini-widget (always-on above editor) ─────────────────────────
// Compact: one line per phase, steps shown for the active phase only.
// Grade badge shown when available. No garbage — just signal.

function buildDashboardWidget(f: Ferment): string[] {
	const lines: string[] = []

	const statusColor =
		f.status === "running"   ? pr_teal(f.status) :
		f.status === "complete"  ? pr_success(f.status) :
		f.status === "abandoned" ? pr_orange(f.status) : pr_dim(f.status)

	const gradeTag = f.grade ? `  ${gradeColor(f.grade.grade)}` : ""
	lines.push(`${pr_teal("🍺")} ${pr_bold(f.name)}  ${pr_dim("[")}${statusColor}${pr_dim("]")}${gradeTag}`)

	const sinceHuman = lastHumanInputAt
		? formatDuration(Date.now() - lastHumanInputAt.getTime())
		: pr_dim("n/a")
	lines.push(`${pr_dim("last human input:")} ${sinceHuman}`)
	lines.push("")

	for (const p of f.phases) {
		const isActive = p.id === f.activePhaseId || (p.groupIndex !== undefined && p.status === "active")
		const bullet = phaseBullet(p)
		const parallelTag = p.groupIndex !== undefined ? pr_dim("∥ ") : ""
		const nameText = isActive ? pr_teal(p.name) : p.status === "completed" ? pr_dim(p.name) : p.name
		const stepsDone = p.steps.filter(
			(s) => s.status === "done" || s.status === "verified" || s.status === "skipped",
		).length
		const stepsTotal = p.steps.length
		const stepsTag = stepsTotal > 0 ? pr_dim(` ${stepsDone}/${stepsTotal}`) : ""
		const phaseGrade = p.grade ? `  ${gradeColor(p.grade.grade)}` : ""
		lines.push(`  ${bullet}  ${parallelTag}${nameText}${stepsTag}${phaseGrade}`)

		if (isActive && stepsTotal > 0) {
			for (const s of p.steps) {
				const sb = stepBulletChar(s.status)
				const sName = truncateLabel(s.description, 50)
				const sText =
					s.status === "running" ? pr_teal(sName) :
					s.status === "failed"  ? pr_orange(sName) :
					(s.status === "done" || s.status === "verified") ? pr_dim(sName) : sName
				const stepGrade = s.grade ? `  ${gradeColor(s.grade.grade)}` : ""
				lines.push(`       ${sb}  ${sText}${stepGrade}`)
			}
		}
	}

	if (f.phases.length === 0) lines.push(`  ${pr_dim("no phases yet")}`)

	lines.push("")
	lines.push(pr_dim("/progress · /pause · /auto"))
	return lines
}

// ─── /progress overlay — four-layer navigation ───────────────────────────────
// L1: phase list (name + bullet + steps count)
// L2: phase detail (goal, grade, step list by name only)
// L3: step detail (description, verify command, grade, result)
// L4: actions (context-sensitive)

function buildPhaseListTitle(f: Ferment): string {
	const terminalCount = f.phases.filter(
		(p) => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	).length
	const total = f.phases.length
	const barLen = 28
	const filled = total > 0 ? Math.round((terminalCount / total) * barLen) : 0
	const bar = `${SUCCESS_FG}${"█".repeat(filled)}${RST_FG}${DIM}${"░".repeat(barLen - filled)}${RST_ALL}`
	const pct = total > 0 ? Math.round((terminalCount / total) * 100) : 0
	const scopeProgress = getScopingProgress(f)
	const scopeTag = f.status === "draft" ? pr_dim(`  scoping ${scopeProgress.answered}/4`) : ""
	const fermentGrade = f.grade ? `  ${gradeColor(f.grade.grade)}` : ""
	const sinceHuman = lastHumanInputAt
		? formatDuration(Date.now() - lastHumanInputAt.getTime())
		: pr_dim("n/a")

	return [
		`${pr_teal("🍺")} ${pr_bold(f.name)}${fermentGrade}${scopeTag}`,
		`${bar}  ${pr_teal(`${pct}%`)}  ${pr_dim(`${terminalCount}/${total}`)}`,
		`${pr_dim("human:")} ${sinceHuman}  ${pr_dim("branch:")} ${f.worktree.branch ? pr_teal(f.worktree.branch) : pr_dim("—")}`,
		f.goal ? `${pr_dim("goal:")} ${truncateLabel(f.goal, 70)}` : "",
	].filter(Boolean).join("\n")
}

function buildPhaseListOptions(f: Ferment): string[] {
	const opts = f.phases.map((p) => {
		const isActive = p.id === f.activePhaseId || (p.groupIndex !== undefined && p.status === "active")
		const bullet = phaseBullet(p)
		const parallelTag = p.groupIndex !== undefined ? pr_dim("∥ ") : ""
		const name = isActive ? pr_teal(p.name) : p.status === "completed" ? pr_dim(p.name) : p.name
		const stepsDone = p.steps.filter(
			(s) => s.status === "done" || s.status === "verified" || s.status === "skipped",
		).length
		const stepsTag = p.steps.length > 0 ? pr_dim(`  ${stepsDone}/${p.steps.length}`) : ""
		const gradeTag = p.grade ? `  ${gradeColor(p.grade.grade)}` : ""
		return `${bullet}  ${parallelTag}${name}${stepsTag}${gradeTag}`
	})
	opts.push(pr_dim("─────────────────────────"))
	if (f.status !== "complete" && f.status !== "abandoned") opts.push("Abandon ferment")
	opts.push("Close")
	return opts
}

function buildPhaseDetailTitle(f: Ferment, p: Phase): string {
	const isActive = p.id === f.activePhaseId
	const bullet = phaseBullet(p)
	const stepsDone = p.steps.filter(
		(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
	).length
	const stepsTag = p.steps.length > 0 ? pr_dim(`  ${stepsDone}/${p.steps.length} steps`) : ""
	const gradeTag = p.grade ? `  ${gradeColor(p.grade.grade)}  ${pr_dim(p.grade.rationale)}` : ""

	const lines: string[] = [
		`${pr_dim(`Phase ${p.index}/${f.phases.length}`)}  ${pr_bold(f.name)}`,
		`${bullet}  ${pr_bold(p.name)}${stepsTag}${gradeTag}`,
		`   ${pr_dim(p.goal)}`,
	]
	if (p.constraints?.length) lines.push(`   ${pr_dim("constraints:")} ${pr_dim(p.constraints.join(", "))}`)
	if (p.summary) lines.push(`   ${pr_dim("↳")} ${pr_dim(p.summary)}`)
	if (isActive && p.steps.length === 0) lines.push(`   ${pr_dim("no steps yet — agent will refine")}`)
	return lines.join("\n")
}

function buildPhaseStepOptions(p: Phase): string[] {
	if (p.steps.length === 0) return [pr_dim("No steps defined yet"), pr_dim("─────────────"), "Phase actions", "Back"]
	const opts = p.steps.map((s) => {
		const bullet = stepBulletChar(s.status)
		const name = s.status === "running" ? pr_teal(s.description) :
			s.status === "failed" ? pr_orange(s.description) :
			(s.status === "done" || s.status === "verified") ? pr_dim(s.description) : s.description
		const gradeTag = s.grade ? `  ${gradeColor(s.grade.grade)}` : ""
		return `${bullet}  ${name}${gradeTag}`
	})
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Phase actions")
	opts.push("Back")
	return opts
}

function buildStepDetailTitle(p: Phase, s: Step): string {
	const bullet = stepBulletChar(s.status)
	const gradeTag = s.grade ? `  ${gradeColor(s.grade.grade)}  ${pr_dim(s.grade.rationale)}` : ""
	const lines: string[] = [
		`${pr_dim(`Step ${s.index}/${p.steps.length}`)}  ${pr_bold(p.name)}`,
		`${bullet}  ${pr_bold(s.description)}${gradeTag}`,
	]
	if (s.verification) {
		lines.push(`   ${pr_dim("verify:")} ${pr_teal(s.verification.command)}`)
	}
	if (s.result) {
		const exitColor = s.result.exitCode === 0 ? pr_success : pr_orange
		lines.push(`   ${pr_dim("exit:")} ${exitColor(String(s.result.exitCode ?? "—"))}`)
		if (s.result.stdout) lines.push(`   ${pr_dim("stdout:")} ${truncateLabel(s.result.stdout.trim(), 120)}`)
		if (s.result.stderr) lines.push(`   ${pr_dim("stderr:")} ${pr_orange(truncateLabel(s.result.stderr.trim(), 120))}`)
	}
	if (s.startedAt) lines.push(`   ${pr_dim("started:")} ${pr_dim(s.startedAt.slice(0, 19))}`)
	if (s.completedAt) lines.push(`   ${pr_dim("done:")}    ${pr_dim(s.completedAt.slice(0, 19))}`)
	return lines.join("\n")
}

function buildStepActionOptions(p: Phase, s: Step): string[] {
	const opts: string[] = []
	if (s.status === "pending" || s.status === "running") opts.push("Mark step done")
	if (s.status === "failed") { opts.push("Retry step"); opts.push("Skip step") }
	if (s.status !== "skipped") opts.push("Skip step")
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Back to phase")
	return opts
}

function buildPhaseActionOptions(f: Ferment, p: Phase): string[] {
	const isActive = p.id === f.activePhaseId
	const opts: string[] = []
	if (p.status === "planned" && !isActive) opts.push("Activate phase")
	if ((p.status === "active" || isActive) && p.steps.length === 0) opts.push("Ask agent to refine steps")
	if (p.status === "active" || isActive) {
		const allDone = p.steps.length > 0 && p.steps.every(
			(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
		)
		if (allDone) opts.push("Mark phase complete")
		opts.push("Mark phase failed")
		opts.push("Skip phase")
	}
	if (p.status === "failed") { opts.push("Re-activate phase"); opts.push("Skip phase") }
	opts.push(pr_dim("─────────────────────────"))
	opts.push("Back to steps")
	return opts
}

async function handleStepAction(
	choice: string,
	f: Ferment,
	p: Phase,
	s: Step,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const st = getStorage()
	if (choice === "Mark step done") {
		const r = st.completeStep(f.id, p.id, s.id)
		if (r) setActive(r)
		ctx.ui.notify(`Step ${s.index} marked done.`)
	} else if (choice === "Retry step") {
		const r = st.startStep(f.id, p.id, s.id)
		if (r) setActive(r)
		ctx.ui.notify(`Step ${s.index} reset to running — tell the agent to retry.`)
	} else if (choice === "Skip step") {
		const r = st.skipStep(f.id, p.id, s.id)
		if (r) setActive(r)
		ctx.ui.notify(`Step ${s.index} skipped.`)
	}
}

async function handlePhaseAction(
	choice: string,
	f: Ferment,
	p: Phase,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const st = getStorage()
	switch (choice) {
		case "Activate phase": {
			const r = st.activatePhase(f.id, p.id)
			if (r) { st.updateStatus(f.id, "running"); setActive(r) }
			ctx.ui.notify(`Phase "${p.name}" activated.`)
			break
		}
		case "Ask agent to refine steps":
			ctx.ui.notify(`Tell the agent: refine_phase for phase ${p.index} "${p.name}"`)
			break
		case "Mark phase complete": {
			const r = st.completePhase(f.id, p.id, "Completed via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" complete.`)
			break
		}
		case "Mark phase failed": {
			const reason = ctx.ui.input ? await ctx.ui.input("Reason for failure:", "") : ""
			const r = st.failPhase(f.id, p.id, reason || "Failed via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" marked failed.`)
			break
		}
		case "Skip phase": {
			const r = st.skipPhase(f.id, p.id, "Skipped via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" skipped.`)
			break
		}
		case "Re-activate phase": {
			const r = st.activatePhase(f.id, p.id)
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" re-activated.`)
			break
		}
	}
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatFermentStatus(f: Ferment): string {
	const total = f.phases.length
	const done = f.phases.filter((p) => p.status === "completed").length
	const active = f.phases.filter((p) => p.status === "active").length
	const planned = f.phases.filter((p) => p.status === "planned").length
	const wt = f.worktree
	const wtBranch = wt.branch ?? "n/a"
	const wtPath = wt.path ?? process.cwd()
	const wtCommit = wt.commit ? wt.commit.slice(0, 7) : "n/a"

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
				lines.push(`      ${sm} ${s.description} — ${s.result || s.status}`)
			}
		}
	}

	if (f.decisions.length || f.memories.length) {
		lines.push(`   Decisions: ${f.decisions.length}  •  Memories: ${f.memories.length}`)
	}

	lines.push(`   ID: ${f.id}  •  Created: ${f.createdAt}`)
	return lines.join("\n")
}

// ─── Judge ────────────────────────────────────────────────────────────────────

const JUDGE_MODEL_ID = "claude-opus-4-7"
const JUDGE_PROVIDER = "kimchi-dev"

async function judgeApiCall(
	systemPrompt: string,
	userMsg: string,
	maxTokens = 200,
): Promise<string | undefined> {
	const registry = judgeModelRegistry
	if (!registry) return undefined

	const model = registry.find(JUDGE_PROVIDER, JUDGE_MODEL_ID) ?? judgeModel
	if (!model) return undefined

	const auth = await registry.getApiKeyAndHeaders(model)
	if (!auth.ok || !auth.apiKey) return undefined

	try {
		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userMsg }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: AbortSignal.timeout(30_000),
				maxTokens,
			},
		)

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim() || undefined
	} catch {
		return undefined
	}
}

// Role 1 — Step verifier: called on non-zero bash exit at complete_step.
interface JudgeVerdict {
	verdict: "pass" | "retry" | "fail"
	reason: string
}

async function judgeStepVerification(
	stepDescription: string,
	verificationCommand: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): Promise<JudgeVerdict> {
	const system = `You are a strict but fair verification judge for a coding agent. A step was marked complete but its verification command exited non-zero. Decide if this is a genuine failure, a transient/flaky issue worth retrying, or actually acceptable.

Respond with EXACTLY one JSON object, no markdown, no explanation:
{"verdict":"pass"|"retry"|"fail","reason":"<one sentence>"}

- pass: output is correct despite non-zero exit (grep returning 1 when no matches is expected, linter warnings only)
- retry: transient failure (network timeout, race condition, file not yet written)
- fail: genuine implementation error that must be fixed before continuing`

	const user = `Step: "${stepDescription}"\nVerification: \`${verificationCommand}\`\nExit: ${exitCode}\nstdout:\n${stdout.slice(0, 1000)}\nstderr:\n${stderr.slice(0, 1000)}`

	const raw = await judgeApiCall(system, user, 120)
	if (!raw) return { verdict: "fail", reason: "Judge unavailable — treating as failure." }
	try {
		const parsed = JSON.parse(raw) as { verdict?: string; reason?: string }
		const verdict = parsed.verdict === "pass" || parsed.verdict === "retry" ? parsed.verdict : "fail"
		return { verdict, reason: parsed.reason ?? raw }
	} catch {
		return { verdict: "fail", reason: raw.slice(0, 200) }
	}
}

// Role 2 — Step grader: called after a step successfully completes (zero exit or judge=pass).
async function judgeGradeStep(
	stepDescription: string,
	summary: string,
	verificationResult?: { exitCode: number; stdout: string; stderr: string },
): Promise<import("../ferment/types.js").JudgeGrade> {
	const system = `You are a code quality judge grading a completed step of a coding task.

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<one short sentence>"}

A = excellent, clean, fully verified
B = good, minor issues
C = adequate but notable gaps
D = barely acceptable, significant issues
F = failed or incomplete`

	const verifyNote = verificationResult
		? `\nVerification exit: ${verificationResult.exitCode}\nstdout: ${verificationResult.stdout.slice(0, 400)}\nstderr: ${verificationResult.stderr.slice(0, 200)}`
		: ""
	const user = `Step: "${stepDescription}"\nSummary: ${summary || "(no summary)"}${verifyNote}`

	const raw = await judgeApiCall(system, user, 120)
	const now = new Date().toISOString()
	if (!raw) return { grade: "B", rationale: "Judge unavailable — assumed good.", gradedAt: now }
	try {
		const parsed = JSON.parse(raw) as { grade?: string; rationale?: string }
		const validGrades = ["A", "B", "C", "D", "F"]
		const grade = validGrades.includes(parsed.grade ?? "") ? (parsed.grade as import("../ferment/types.js").Grade) : "B"
		return { grade, rationale: parsed.rationale ?? raw.slice(0, 150), gradedAt: now }
	} catch {
		return { grade: "B", rationale: raw.slice(0, 150), gradedAt: now }
	}
}

// Role 3 — Phase grader: called at complete_phase.
async function judgeGradePhase(
	phaseName: string,
	phaseGoal: string,
	stepSummaries: string,
	summary: string,
): Promise<import("../ferment/types.js").JudgeGrade> {
	const system = `You are a code quality judge grading a completed phase of a coding task.

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<one short sentence>"}

A = phase goal fully achieved, clean implementation
B = goal mostly achieved, minor gaps
C = partial achievement, notable gaps
D = significant issues or incomplete
F = phase goal not achieved`

	const user = `Phase: "${phaseName}"\nGoal: ${phaseGoal}\nStep summaries:\n${stepSummaries}\nPhase summary: ${summary || "(none)"}`

	const raw = await judgeApiCall(system, user, 150)
	const now = new Date().toISOString()
	if (!raw) return { grade: "B", rationale: "Judge unavailable — assumed good.", gradedAt: now }
	try {
		const parsed = JSON.parse(raw) as { grade?: string; rationale?: string }
		const validGrades = ["A", "B", "C", "D", "F"]
		const grade = validGrades.includes(parsed.grade ?? "") ? (parsed.grade as import("../ferment/types.js").Grade) : "B"
		return { grade, rationale: parsed.rationale ?? raw.slice(0, 150), gradedAt: now }
	} catch {
		return { grade: "B", rationale: raw.slice(0, 150), gradedAt: now }
	}
}

// Role 4 — Plan reviewer: called after scope_ferment to check phases before execution.
interface PlanReview {
	verdict: "approve" | "revise"
	suggestions: string[]
	confidence: number // 0–100
}

async function judgePlan(
	fermentName: string,
	goal: string,
	criteria: string,
	constraints: string,
	phases: string,
): Promise<PlanReview> {
	const system = `You are a senior engineering lead reviewing a project plan before execution begins.

Respond with EXACTLY one JSON object, no markdown:
{"verdict":"approve"|"revise","suggestions":["..."],"confidence":0-100}

- approve: plan is sound, phases cover the goal, steps are concrete and verifiable
- revise: plan has gaps, missing phases, or steps too vague — list specific suggestions
confidence = how confident you are the plan will achieve the goal (0–100)

Be concise. Maximum 3 suggestions if revising.`

	const user = `Project: "${fermentName}"\nGoal: ${goal}\nSuccess criteria: ${criteria}\nConstraints: ${constraints}\n\nProposed phases:\n${phases}`

	const raw = await judgeApiCall(system, user, 300)
	if (!raw) return { verdict: "approve", suggestions: [], confidence: 75 }
	try {
		const parsed = JSON.parse(raw) as { verdict?: string; suggestions?: unknown; confidence?: number }
		const verdict = parsed.verdict === "revise" ? "revise" : "approve"
		const suggestions = Array.isArray(parsed.suggestions)
			? (parsed.suggestions as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
			: []
		const confidence = typeof parsed.confidence === "number" ? Math.min(100, Math.max(0, parsed.confidence)) : 75
		return { verdict, suggestions, confidence }
	} catch {
		return { verdict: "approve", suggestions: [], confidence: 75 }
	}
}

// Ferment-level grade: weighted average of phase grades.
function computeFermentGrade(
	phases: import("../ferment/types.js").Phase[],
): import("../ferment/types.js").JudgeGrade {
	const gradeScore: Record<import("../ferment/types.js").Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 }
	const scoredPhases = phases.filter((p) => p.grade && p.status !== "skipped")
	if (scoredPhases.length === 0) {
		return { grade: "B", rationale: "No graded phases.", gradedAt: new Date().toISOString() }
	}
	const avg = scoredPhases.reduce((sum, p) => sum + gradeScore[p.grade!.grade], 0) / scoredPhases.length
	const failedCount = phases.filter((p) => p.status === "failed").length
	const adjustedAvg = failedCount > 0 ? avg * (1 - failedCount * 0.1) : avg
	const grade: import("../ferment/types.js").Grade =
		adjustedAvg >= 3.5 ? "A" : adjustedAvg >= 2.5 ? "B" : adjustedAvg >= 1.5 ? "C" : adjustedAvg >= 0.5 ? "D" : "F"
	const rationale = `${scoredPhases.length} phase(s) graded, avg ${avg.toFixed(1)}/4${failedCount > 0 ? `, ${failedCount} failed` : ""}.`
	return { grade, rationale, gradedAt: new Date().toISOString() }
}

// ─── Scoping helper ───────────────────────────────────────────────────────────

function buildScopePrompt(fermentId: string, isPlan: boolean, rawIntent?: string): string {
	const f = getStorage().get(fermentId)
	if (!f) return ""
	const action = whatNext(f)
	const msg = isPlan ? stripToolRefs(action.message) : action.message
	if (!rawIntent) return msg
	return `User wants to ferment: "${rawIntent}"\n\n${msg}`
}

/**
 * Deterministic scoping flow: collects all 4 fields via TUI widgets, then
 * fires a single LLM turn carrying the complete answers so scope_ferment
 * can be called without any back-and-forth nudge loop.
 */
async function runScopingFlow(
	f: import("../ferment/types.js").Ferment,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.ui.input) {
		// Headless fallback: let the LLM handle scoping conversationally
		const prompt = buildScopePrompt(f.id, isPlanMode())
		pi.sendMessage(
			{
				customType: "ferment_created_nudge",
				content: [{ type: "text", text: prompt }],
				display: false,
				details: undefined,
			},
			{ triggerTurn: true },
		)
		return
	}

	// Step 1: goal
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 1/4 — goal` })
	const goal = await ctx.ui.input("What does done look like? (goal)", "e.g. 'Users can log in with Google OAuth'")
	if (!goal) return

	// Step 2: success criteria
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 2/4 — success criteria` })
	const criteria = await ctx.ui.input(
		"How will we know we got there? (success criteria)",
		"e.g. 'E2E test passes, no regressions in login flow'",
	)
	if (!criteria) return

	// Step 3: constraints
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 3/4 — constraints` })
	const constraints = await ctx.ui.input(
		"What should we avoid? Any non-negotiables? (comma-separated)",
		"e.g. 'No external auth libs, must work on mobile'",
	)
	if (!constraints) return

	// Step 4: phases — let the LLM propose them given the context so far
	pi.appendEntry("ferment_breadcrumb", { text: `scoping "${f.name}" · 4/4 — proposing phases…` })

	const constraintList = constraints
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean)

	// Fire a single LLM turn with all collected answers. The LLM's job now is
	// only to propose phases+steps and call scope_ferment — no more Q&A.
	const prompt = `Ferment: "${f.name}" (ID: ${f.id})\n\nThe user has already answered the scoping questions:\n- Goal: ${goal}\n- Success criteria: ${criteria}\n- Constraints: ${constraintList.join(", ")}\n\nYour task:\n1. Propose 3–7 ordered phases for this ferment. For each phase, include 3–6 concrete steps.\n2. Show the user the proposed phases and steps.\n3. If they confirm (or say "yes"), immediately call scope_ferment with ferment_id "${f.id}", goal, success_criteria, constraints array, and the phases array including steps.\n\nCRITICAL: Do NOT use any tools (read_file, search_code, bash, etc.) — propose phases based solely on the information already provided above. Do not ask any more questions about goal, criteria, or constraints — those are already captured.`

	pi.sendMessage(
		{
			customType: "ferment_created_nudge",
			content: [{ type: "text", text: prompt }],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool schemas
// ═══════════════════════════════════════════════════════════════════════════════

const CreateFermentParams = Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) })

const ListParams = Type.Object({
	filter: Type.Optional(Type.String({ description: "Optional status filter" })),
})

const ScopeParams = Type.Object({
	ferment_id: Type.String(),
	title: Type.Optional(Type.String({ description: "A short 3-5 word title for this ferment" })),
	goal: Type.String(),
	success_criteria: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	phases: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				goal: Type.String(),
				description: Type.Optional(Type.String()),
				constraints: Type.Optional(Type.Array(Type.String())),
				budget: Type.Optional(Type.String({ description: "e.g. '200k tokens'" })),
				parallel_group: Type.Optional(
					Type.Number({
						description:
							"Phases with the same parallel_group number run concurrently. Omit (or use unique values) for sequential phases. Example: give all research phases parallel_group: 1 to run them simultaneously.",
					}),
				),
				steps: Type.Optional(
					Type.Array(
						Type.Object({
							description: Type.String(),
							verify: Type.Optional(Type.String({ description: "bash command that exits 0 on success" })),
						}),
						{ description: "Initial step breakdown for this phase. Can be refined later with refine_phase." },
					),
				),
			}),
		),
	),
})

const ActivateParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.Optional(
		Type.String({
			description: "Phase ID in format 'phase-N', e.g. 'phase-1'. Use the phase_id returned by scope_ferment.",
		}),
	),
})

const RefineParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String({
		description: "Phase ID in format 'phase-N', e.g. 'phase-1'. Use the phase_id returned by activate_phase.",
	}),
	steps: Type.Array(
		Type.Object({
			description: Type.String(),
			verify: Type.Optional(
				Type.String({ description: "Bash command that exits 0 on success. Run automatically after complete_step." }),
			),
			needs_vision: Type.Optional(
				Type.Boolean({
					description:
						"Set true if this step requires processing images or screenshots. Selects kimi-k2.5 as worker; otherwise minimax-m2.7 is used.",
				}),
			),
			can_run_parallel: Type.Optional(
				Type.Boolean({
					description:
						"Set true if this step is independent and can run concurrently with other parallel steps in the same phase. The planner will start all parallel-safe steps simultaneously as separate subagents.",
				}),
			),
		}),
	),
})

const StepActionParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String({ description: "Phase ID in format 'phase-N', e.g. 'phase-1'." }),
	step_id: Type.String({
		description:
			"Step ID in format 'step-N', e.g. 'step-1'. Use the step_id returned by refine_phase or activate_phase.",
	}),
})

const CompleteStepParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	step_id: Type.String(),
	summary: Type.Optional(Type.String()),
})

const VerifyParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	step_id: Type.String(),
	command: Type.String(),
})

const CompletePhaseParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	summary: Type.String(),
})

const SkipPhaseParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	reason: Type.Optional(Type.String()),
})

const CompleteFermentParams = Type.Object({ ferment_id: Type.String(), final_summary: Type.Optional(Type.String()) })

const DecisionParams = Type.Object({
	ferment_id: Type.String(),
	title: Type.String(),
	description: Type.String(),
	phase_id: Type.Optional(Type.String()),
	step_id: Type.Optional(Type.String()),
})

const MemoryParams = Type.Object({
	ferment_id: Type.String(),
	category: Type.String(),
	content: Type.String(),
	phase_id: Type.Optional(Type.String()),
	step_id: Type.Optional(Type.String()),
})

const ShowParams = Type.Object({ ferment_id: Type.String() })

const SetModeParams = Type.Object({
	ferment_id: Type.String(),
	mode: Type.String({ description: "plan | exec | auto" }),
})

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI) {
	// ─── Session start: rehydrate from prior session ────────────────────────────
	pi.on("session_start", async () => {
		const envId = process.env.KIMCHI_ACTIVE_FERMENT
		if (!envId) return
		const storage = getStorage()
		const existing = storage.get(envId)
		if (existing) {
			setActive(existing)
			appendRefEntry(pi, existing.id)

			// Worktree validation
			const wtCheck = checkWorktree(existing)
			if (wtCheck.severity !== "ok" && wtCheck.message) {
				pi.appendEntry("ferment_worktree_warning", { text: wtCheck.message })
				if (wtCheck.severity === "block") {
					// Don't inject resume nudge — wrong directory
					return
				}
			}

			// Resume nudge → hidden from user, triggers LLM to continue
			const action = whatNext(existing)
			const msg = isPlanMode() ? stripToolRefs(action.message) : action.message
			const scopeProgress = getScopingProgress(existing)
			const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] ${existing.mode} mode · scoping ${scopeProgress.answered}/${scopeProgress.total}`

			pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
			pi.sendMessage(
				{
					customType: "ferment_resume_nudge",
					content: [{ type: "text", text: msg }],
					display: false,
					details: undefined,
				},
				{ triggerTurn: true },
			)
		} else {
			setActive(undefined)
		}
	})

	// ─── Track last human input time ────────────────────────────────────────────
	pi.on("input", async (event) => {
		if (event.source === "interactive") {
			lastHumanInputAt = new Date()
			widgetUpdateFn?.()
		}
	})

	// ─── Planner system prompt injection ────────────────────────────────────────
	// When a ferment is running, tell the session model it is the planner:
	// its job is to manage the state machine and delegate implementation to
	// subagent workers — never to write code itself.
	pi.on("before_agent_start", async (event) => {
		if (!activeFerment || activeFerment.status !== "running") return {}

		const supplement = `\n\n## Ferment Planner Role\n\nYou are the PLANNER for ferment "${activeFerment.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers.\n\n**Rules:**\n- NEVER write, edit, or read files yourself during step execution\n- NEVER implement a step inline — always call start_step then immediately spawn a subagent\n- For each step: call start_step → read the worker_model from the result → spawn a subagent with provider "kimchi-dev" and that model\n- If start_step returns parallel_siblings, call start_step for all of them and spawn their subagents CONCURRENTLY in the same turn\n- After a subagent returns, call complete_step with its summary\n- For phase transitions (activate_phase, complete_phase, complete_ferment): call the tool directly, no subagent needed\n- Worker models: minimax-m2.7 for code/text, kimi-k2.5 for vision tasks\n\n**Parallel phases:**\n- When activate_phase returns parallel_group, all listed phase_ids are active simultaneously\n- Call refine_phase for ALL parallel phases in the same turn, then execute their steps concurrently\n- Complete each parallel phase independently with complete_phase when its steps finish\n- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped\n`

		return { systemPrompt: `${event.systemPrompt}${supplement}` }
	})

	// ─── Block model switching during ferment execution ─────────────────────────
	// model_select has no cancel mechanism — restore the previous model instead.
	// Use restoringModel flag to prevent the pi.setModel call from re-entering.
	pi.on("model_select", async (event, ctx) => {
		if (ctx?.model) { judgeModel = ctx.model; judgeModelRegistry = ctx.modelRegistry }
		if (!activeFerment || activeFerment.status !== "running") return
		if (restoringModel) return // prevent infinite loop from our own setModel call

		// Revert to whatever was active before the switch
		if (event.previousModel) {
			restoringModel = true
			pi.setModel(event.previousModel).catch(() => {}).finally(() => { restoringModel = false })
		}
		ctx.ui.notify(
			`Model switching is locked while ferment "${activeFerment.name}" is running. Finish or abandon the ferment first.`,
			"warning",
		)
	})

	// ─── Yes/no question intercept ──────────────────────────────────────────────
	// In plan mode the LLM asks yes/no questions after each scoping field and
	// before each step ("Ready to execute this step?"). Show a TUI dropdown
	// instead of waiting for free-text input. Fires for draft AND running status
	// in plan mode; never in exec mode (fully autonomous).
	pi.on("turn_end", async (event, ctx) => {
		if (ctx?.model) { judgeModel = ctx.model; judgeModelRegistry = ctx.modelRegistry }
		if (!activeFerment) return
		if (activeFerment.mode === "exec") return
		// Only intercept during scoping (draft) or plan-mode confirmation gates (running)
		if (activeFerment.status !== "draft" && activeFerment.status !== "running") return
		if (!ctx?.ui?.select || !ctx?.ui?.input) return
		if (event.message.role !== "assistant") return

		// Extract text from the assistant message content
		const text = event.message.content
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { type: string; text?: string }) => ("text" in c ? c.text ?? "" : ""))
			.join("")
			.trimEnd()

		if (!text.endsWith("?")) return

		// Don't intercept if the turn also had tool calls (mid-execution text)
		const hasToolCalls = event.message.content.some((c: { type: string }) => c.type === "toolCall")
		if (hasToolCalls) return

		const isDraft = activeFerment.status === "draft"
		const yesLabel = isDraft ? "Yes, continue" : "Yes, proceed"
		const noLabel = isDraft ? "No, stop here" : "No, pause"

		const choice = await ctx.ui.select(text.slice(-200), [
			yesLabel,
			noLabel,
			"Let me say something else",
		])

		if (!choice) return

		let reply: string
		if (choice === "Let me say something else") {
			const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
			if (!custom) return
			reply = custom
		} else if (choice === noLabel) {
			reply = isDraft ? "No, stop here." : "No, pause for now."
		} else {
			reply = "Yes, proceed."
		}

		lastHumanInputAt = new Date()
		widgetUpdateFn?.()
		pi.sendUserMessage(reply)
	})

	// ─── Persistent dashboard widget ────────────────────────────────────────────
	// Refreshed whenever setActive() or input fires. Interval ticker keeps the
	// "last human input" duration live without needing a state change.
	let widgetVisible = false
	let widgetTicker: ReturnType<typeof setInterval> | undefined

	function mountWidget(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext): void {
		if (widgetVisible) return
		widgetVisible = true

		function render(): void {
			if (!activeFerment) {
				ctx.ui.setWidget("ferment-dashboard", undefined)
				return
			}
			ctx.ui.setWidget("ferment-dashboard", buildDashboardWidget(activeFerment), { placement: "aboveEditor" })
		}

		widgetUpdateFn = render
		render()

		// Tick every 30s so the "X min ago" label stays current
		widgetTicker = setInterval(() => {
			if (activeFerment) render()
		}, 30_000)
	}

	function unmountWidget(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext): void {
		if (!widgetVisible) return
		widgetVisible = false
		widgetUpdateFn = undefined
		clearInterval(widgetTicker)
		widgetTicker = undefined
		ctx.ui.setWidget("ferment-dashboard", undefined)
	}

	// ─── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("ferment", {
		description: 'Manage ferments: /ferment list, /ferment add "Name", /ferment one-shot "task", /ferment switch <id>',
		async handler(args, ctx) {
			const raw = args.trim()
			const lo = raw.toLowerCase()
			const storage = getStorage()

			/* ── /ferment  (no args) → interactive prompt ── */
			if (raw === "") {
				if (activeFerment && activeFerment.status === "running") {
					ctx.ui.notify(
						`A ferment is already running: "${activeFerment.name}". Use /progress to check status or /ferment switch to change.`,
					)
					return
				}
				if (!ctx.ui.input) {
					ctx.ui.notify('No UI available. Use /ferment add "Name" instead.')
					return
				}
				const rawIntent = await ctx.ui.input(
					"🍺  What would you like to ferment?",
					"e.g. 'Rewrite login flow' or 'Add OAuth support'",
				)
				if (!rawIntent) return
				try {
					const shortName = await shortenTitle(rawIntent)
					const f = storage.create(shortName, rawIntent)
					setActive(f)
					appendRefEntry(pi, f.id)

					// Visible acknowledgment to user
					pi.appendEntry("ferment_ack", {
						text: `🍺  Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nMode: ${f.mode} · scoping 0/4`,
					})

					await runScopingFlow(f, pi, ctx)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
				}
				return
			}

			/* ── /ferment list ── */
			if (lo === "list") {
				const items = storage.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				if (items.length === 0) {
					ctx.ui.notify("No ferments. Use /ferment to start one.")
					return
				}

				if (!ctx.hasUI) {
					const lines = items.map((f) => {
						const marker = f.id === activeFermentId ? "▶" : "○"
						return `${marker}  ${f.name}  [${f.status}]  ${f.phaseCount} phase(s)  ${f.id.slice(0, 8)}…`
					})
					ctx.ui.notify(lines.join("\n"))
					return
				}

				// ── Step 1: pick a ferment ──
				const listTitle = `${pr_teal("🍺")} ${pr_bold("Ferments")}  ${pr_dim(`(${items.length})`)}\n\n${pr_dim("Select a ferment:")}`
				const listOpts = items.map((f) => {
					const isActive = f.id === activeFermentId
					const bullet = isActive ? pr_teal("▶") : pr_dim("○")
					const statusColor =
						f.status === "running"
							? pr_teal(f.status)
							: f.status === "complete"
								? pr_success(f.status)
								: f.status === "abandoned"
									? pr_orange(f.status)
									: pr_dim(f.status)
					const activeTag = isActive ? `  ${pr_teal("← active")}` : ""
					return `${bullet}  ${f.name}  ${pr_dim("[")}${statusColor}${pr_dim("]")}${activeTag}`
				})
				listOpts.push(pr_dim("Close"))

				const listChoice = await ctx.ui.select(listTitle, listOpts)
				if (!listChoice || listChoice === pr_dim("Close")) return

				const listIdx = listOpts.indexOf(listChoice)
				const selected = listIdx >= 0 && listIdx < items.length ? items[listIdx] : undefined
				if (!selected) return

				// ── Step 2: action submenu for selected ferment ──
				const isActiveSelected = selected.id === activeFermentId
				const subTitle = `${pr_teal("🍺")} ${pr_bold(selected.name)}\n${selected.description && selected.description !== selected.name ? `${pr_dim(selected.description.slice(0, 80))}${selected.description.length > 80 ? pr_dim("…") : ""}\n` : ""}${pr_dim("Status:")} ${selected.status}  ${pr_dim("Phases:")} ${selected.phaseCount}${isActiveSelected ? `  ${pr_teal("← currently active")}` : ""}`

				const actionContinue = isActiveSelected ? "Continue (already active)" : "Continue"
				const subOpts = [actionContinue, "Delete", "Back"]
				const action = await ctx.ui.select(subTitle, subOpts)
				if (!action || action === "Back") return

				if (action === actionContinue) {
					if (!isActiveSelected) {
						const switched = storage.get(selected.id)
						if (switched) {
							setActive(switched)
							ctx.ui.notify(`Switched to "${switched.name}"`)
						}
					}
					return
				}

				if (action === "Delete") {
					storage.delete(selected.id)
					if (activeFermentId === selected.id) setActive(undefined)
					ctx.ui.notify(`Deleted "${selected.name}"`)
					return
				}
				return
			}

			/* ── /ferment mode ── */
			if (lo === "mode" || lo.startsWith("mode ")) {
				const modeArg = lo === "mode" ? "" : lo.slice("mode ".length).trim()
				if (!modeArg) {
					if (!activeFerment) {
						ctx.ui.notify("No active ferment. Use /ferment add or /ferment switch first.")
						return
					}
					const f = activeFerment
					const lines = [
						`Ferment: ${f.name} (${f.id})`,
						`Mode: ${f.mode}`,
						"",
						"plan — Scoping and coordination. Agent asks questions, proposes phases.",
						"exec — Full execution. Agent iterates autonomously.",
						" auto — Normal. User decides when to act.",
						"",
						"Use /ferment mode plan | exec | auto to change.",
					]
					ctx.ui.notify(lines.join("\n"))
					return
				}

				if (!["plan", "exec", "auto"].includes(modeArg)) {
					ctx.ui.notify("Usage: /ferment mode plan | exec | auto")
					return
				}

				if (!activeFerment) {
					ctx.ui.notify("No active ferment.")
					return
				}

				// Block exec/auto mode change if scoping is not complete
				if ((modeArg === "exec" || modeArg === "auto") && activeFerment.status === "draft") {
					const progress = getScopingProgress(activeFerment)
					if (progress.answered < progress.total) {
						ctx.ui.notify(
							`Cannot switch to ${modeArg} mode: scoping is ${progress.answered}/${progress.total} complete. Finish scoping in plan mode first.`,
						)
						return
					}
				}

				const s = getStorage()
				const updated = s.updateMode(activeFerment.id, modeArg as FermentWorkMode)
				if (updated) {
					setActive(updated)
					let hint = ""
					if (modeArg === "exec") {
						hint = "\n\n⚡  exec mode — the agent now has full tool access."
					} else if (modeArg === "plan") {
						hint = "\n\n📝  plan mode — the agent will ask questions and propose structure."
					} else if (modeArg === "auto") {
						hint = "\n\n🔄  auto mode — the agent will guide you through each step."
					}
					ctx.ui.notify(`Mode changed to: ${modeArg}.${hint}`)

					const action = whatNext(updated)
					const nudge = modeArg === "plan" ? stripToolRefs(action.message) : action.message
					if (nudge) {
						pi.appendEntry("ferment_breadcrumb", {
							text: `Mode changed to ${modeArg}: "${updated.name}" [${updated.status}]`,
						})
						pi.sendMessage(
							{
								customType: "ferment_mode_nudge",
								content: [{ type: "text", text: nudge }],
								display: false,
								details: undefined,
							},
							{ triggerTurn: true },
						)
					}
				}
				return
			}

			/* ── /ferment delete ... ── */
			if (lo.startsWith("delete ")) {
				const target = raw
					.slice("delete ".length)
					.trim()
					.replace(/^["']|["']$/g, "")
				if (!target) {
					ctx.ui.notify('Usage: /ferment delete <full-id> or /ferment delete "Name"')
					return
				}
				try {
					const f = storage.resolve(target)
					if (!f) {
						ctx.ui.notify(`No ferment matching "${target}".`)
						return
					}
					storage.delete(f.id)
					if (activeFermentId === f.id) setActive(undefined)
					ctx.ui.notify(`Deleted "${f.name}" (${f.id}).`)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Delete failed.")
				}
				return
			}

			/* ── /ferment switch | use | resume ... ── */
			if (lo.startsWith("switch ") || lo.startsWith("use ") || lo.startsWith("resume ")) {
				const sub = lo.startsWith("switch ") ? "switch" : lo.startsWith("use ") ? "use" : "resume"
				const target = raw
					.trim()
					.slice(sub.length)
					.trim()
					.replace(/^["']|["']$/g, "")
				if (!target) {
					ctx.ui.notify('Usage: /ferment switch <full-id> or /ferment switch "Name"')
					return
				}
				try {
					const f = storage.resolve(target)
					if (!f) {
						ctx.ui.notify(`No ferment matching "${target}".`)
						return
					}

					// Check if --force flag is set (for worktree override)
					const isForce = raw.includes("--force")

					// Worktree check on switch
					const wtCheck = checkWorktree(f)
					if (wtCheck.severity === "block" && !isForce) {
						ctx.ui.notify(`${wtCheck.message}\n\nUse /ferment switch --force "${target}" to override.`)
						return
					}

					setActive(f)
					appendRefEntry(pi, f.id)

					const wtWarning = wtCheck.severity === "warn" ? `\n⚠️  ${wtCheck.message}` : ""
					ctx.ui.notify(`Switched to "${f.name}" (${f.id}) [${f.status}].${wtWarning}`)

					const action = whatNext(f)
					const nudge = isPlanMode() ? stripToolRefs(action.message) : action.message
					if (nudge) {
						const scopeProgress = getScopingProgress(f)
						const breadcrumb = `Switched ferment: "${f.name}" [${f.status}] ${f.mode} mode · scoping ${scopeProgress.answered}/${scopeProgress.total}`
						pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
						pi.sendMessage(
							{
								customType: "ferment_switch_nudge",
								content: [{ type: "text", text: nudge }],
								display: false,
								details: undefined,
							},
							{ triggerTurn: true },
						)
					}
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Switch failed.")
				}
				return
			}

			/* ── /ferment abandon ── */
			if (lo === "abandon" || lo.startsWith("abandon ")) {
				if (!activeFerment) {
					ctx.ui.notify("No active ferment.")
					return
				}
				const reason = raw
					.slice("abandon".length)
					.trim()
					.replace(/^["']|["']$/g, "")
				if (ctx.ui.select) {
					const choice = await ctx.ui.select(`Abandon "${activeFerment.name}"?`, ["Yes, abandon it", "No, keep it"])
					if (!choice || !choice.startsWith("Yes")) {
						ctx.ui.notify("Abandon cancelled.")
						return
					}
				}
				const s = getStorage()
				const r = s.abandonFerment(activeFerment.id, reason || undefined)
				if (r) {
					setActive(r)
					ctx.ui.notify(`Ferment "${r.name}" abandoned.`)
				}
				return
			}

			/* ── /ferment revise <field> ── */
			if (lo.startsWith("revise ")) {
				if (!activeFerment) {
					ctx.ui.notify("No active ferment.")
					return
				}
				const field = lo.slice("revise ".length).trim()
				const s = getStorage()
				const f = activeFerment

				if (field === "goal") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision. Ask the agent to update the goal.")
						return
					}
					const newGoal = await ctx.ui.input("Revise goal:", f.goal ?? "")
					if (newGoal) {
						const r = s.setScopingGoal(f.id, newGoal)
						if (r) {
							setActive(r)
							ctx.ui.notify(`Goal updated: "${newGoal}"`)
						}
					}
					return
				}

				if (field === "criteria") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision.")
						return
					}
					const newCriteria = await ctx.ui.input("Revise success criteria:", f.successCriteria ?? "")
					if (newCriteria) {
						const r = s.setScopingCriteria(f.id, newCriteria)
						if (r) {
							setActive(r)
							ctx.ui.notify("Success criteria updated.")
						}
					}
					return
				}

				if (field === "constraints") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision.")
						return
					}
					const current = (f.constraints ?? []).join(", ")
					const newConstraints = await ctx.ui.input("Revise constraints (comma-separated):", current)
					if (newConstraints !== null && newConstraints !== undefined) {
						const parsed = newConstraints
							.split(",")
							.map((c) => c.trim())
							.filter(Boolean)
						const r = s.setScopingConstraints(f.id, parsed)
						if (r) {
							setActive(r)
							ctx.ui.notify(`Constraints updated: ${parsed.join(", ") || "(none)"}`)
						}
					}
					return
				}

				ctx.ui.notify(
					"Usage: /ferment revise goal | criteria | constraints\n\nTo revise phases, ask the agent to update them.",
				)
				return
			}

			/* ── /ferment one-shot <description> ── */
			if (lo.startsWith("one-shot")) {
				if (activeFerment && activeFerment.status === "running") {
					ctx.ui.notify(
						`A ferment is already running: "${activeFerment.name}". Use /progress to check status.`,
					)
					return
				}
				const intent = raw.slice("one-shot".length).trim().replace(/^["']|["']$/g, "")
				let resolvedIntent = intent
				if (!resolvedIntent && ctx.ui.input) {
					const typed = await ctx.ui.input("🍺  One-shot: what should be done?", "Describe the full task…")
					if (!typed) return
					resolvedIntent = typed
				}
				if (!resolvedIntent) {
					ctx.ui.notify('Usage: /ferment one-shot "description of what to build"')
					return
				}
				try {
					const shortName = await shortenTitle(resolvedIntent)
					const f = storage.create(shortName, resolvedIntent)
					// One-shot always runs in exec mode — no user checkpoints
					storage.updateMode(f.id, "exec")
					const updated = storage.get(f.id) ?? f
					setActive(updated)
					appendRefEntry(pi, updated.id)
					pi.appendEntry("ferment_ack", {
						text: `🍺  One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nMode: exec (fully autonomous)`,
					})
					// Inject a single nudge that carries the full intent and instructs
					// the LLM to scope, plan, and execute without pausing for input.
					const nudge = `You are running a one-shot ferment: "${updated.name}" (ID: ${updated.id}).

User intent: "${resolvedIntent}"

Your task — execute ALL of the following steps WITHOUT pausing to ask the user:
1. Call scope_ferment with:
   - ferment_id: "${updated.id}"
   - goal: derived from the user intent
   - success_criteria: what observable outcome proves the goal
   - constraints: any technical constraints implied by the intent
   - phases: 3–7 ordered phases, each with 3–6 concrete steps and a verify bash command per step
2. For each phase in order: call activate_phase, then refine_phase (if steps not pre-set), then for each step: start_step → (delegate to subagent worker) → complete_step
3. When all phases are done: call complete_ferment

CRITICAL: Do NOT use any tools other than ferment tools to research or explore first. Do NOT ask for confirmation at any point. Execute autonomously until complete_ferment is called.`

					pi.sendMessage(
						{
							customType: "ferment_oneshot_nudge",
							content: [{ type: "text", text: nudge }],
							display: false,
							details: undefined,
						},
						{ triggerTurn: true },
					)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "One-shot create failed.")
				}
				return
			}

			/* ── /ferment add "Name" ── */
			if (activeFerment && activeFerment.status === "running") {
				ctx.ui.notify(
					`A ferment is already running: "${activeFerment.name}". Use /progress to check status or /ferment switch to change.`,
				)
				return
			}
			const rawName = raw.replace(/^["']|["']$/g, "")
			if (!rawName) {
				ctx.ui.notify('Usage: /ferment add "Name"')
				return
			}
			try {
				const shortName = await shortenTitle(rawName)
				const f = storage.create(shortName, rawName)
				setActive(f)
				appendRefEntry(pi, f.id)

				// Visible acknowledgment to user
				pi.appendEntry("ferment_ack", {
					text: `🍺  Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nMode: ${f.mode} · scoping 0/4`,
				})

				await runScopingFlow(f, pi, ctx)
			} catch (err) {
				ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
			}
		},
	})

	pi.registerCommand("auto", {
		description: "Enable auto-mode for the active ferment",
		async handler(_, ctx) {
			autoModeEnabled = true
			ctx.ui.notify("Auto-mode enabled.")
			if (activeFerment) maybeInjectAutoNudge(pi)
		},
	})

	pi.registerCommand("pause", {
		description: "Pause auto-mode for the active ferment",
		async handler(_, ctx) {
			autoModeEnabled = false
			ctx.ui.notify("Auto-mode paused.")
		},
	})

	pi.registerCommand("progress", {
		description: "Ferment overlay: phase/step navigator with grades. Toggle with /progress.",
		async handler(_, ctx) {
			if (!activeFerment) {
				ctx.ui.notify("No active ferment. Start one with /ferment.")
				return
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(formatFermentStatus(activeFerment))
				return
			}

			// Toggle off if widget already visible and we have no dialog open
			if (widgetVisible) {
				unmountWidget(ctx)
				return
			}

			// Hide the persistent widget while the interactive dialog is open —
			// the harness renders it above the select dialog causing duplication.
			ctx.ui.setWidget("ferment-dashboard", undefined)

			// ── Layer 1: phase list ──────────────────────────────────────────────
			let atPhaseList = true
			while (atPhaseList) {
				const f = getStorage().get(activeFerment.id) ?? activeFerment
				const phaseListOpts = buildPhaseListOptions(f)
				// phaseListOpts: [phase entries..., separator, "Abandon ferment"?, "Close"]
				const phaseListPhaseCount = f.phases.length

				const l1choice = await ctx.ui.select(buildPhaseListTitle(f), phaseListOpts)

				if (!l1choice || l1choice === "Close") {
					atPhaseList = false
					continue
				}

				if (l1choice === "Abandon ferment") {
					const confirmed = await ctx.ui.confirm(
						`Abandon "${f.name}"?`,
						"Marks the ferment abandoned. Work done so far is preserved.",
					)
					if (confirmed) {
						const r = getStorage().abandonFerment(f.id)
						if (r) setActive(r)
						atPhaseList = false
					}
					continue
				}

				// Phase selected — map by position
				const l1idx = phaseListOpts.indexOf(l1choice)
				if (l1idx < 0 || l1idx >= phaseListPhaseCount) continue
				const selectedPhaseIndex = f.phases[l1idx].index

				// ── Layer 2: step list for phase ───────────────────────────────
				let atStepList = true
				while (atStepList) {
					const f2 = getStorage().get(f.id) ?? f
					const ph = f2.phases.find((p) => p.index === selectedPhaseIndex)
					if (!ph) { atStepList = false; break }

					const stepOpts = buildPhaseStepOptions(ph)
					// stepOpts: [step entries..., separator, "Phase actions", "Back"]
					const stepCount = ph.steps.length

					const l2choice = await ctx.ui.select(buildPhaseDetailTitle(f2, ph), stepOpts)

					if (!l2choice || l2choice === "Back") { atStepList = false; break }

					if (l2choice === "Phase actions") {
						// ── Layer 4 reached via "Phase actions" shortcut ───────
						let atPhaseActions = true
						while (atPhaseActions) {
							const f3 = getStorage().get(f.id) ?? f
							const ph3 = f3.phases.find((p) => p.index === selectedPhaseIndex)
							if (!ph3) { atPhaseActions = false; break }
							const actionChoice = await ctx.ui.select(buildPhaseDetailTitle(f3, ph3), buildPhaseActionOptions(f3, ph3))
							if (!actionChoice || actionChoice === "Back to steps") { atPhaseActions = false; break }
							await handlePhaseAction(actionChoice, f3, ph3, ctx)
						}
						continue
					}

					// Step selected — map by position
					const l2idx = stepOpts.indexOf(l2choice)
					if (l2idx < 0 || l2idx >= stepCount) continue
					const selectedStepIndex = ph.steps[l2idx].index

					// ── Layer 3: step detail ───────────────────────────────────
					let atStepDetail = true
					while (atStepDetail) {
						const f3 = getStorage().get(f.id) ?? f
						const ph3 = f3.phases.find((p) => p.index === selectedPhaseIndex)
						if (!ph3) { atStepDetail = false; break }
						const st = ph3.steps.find((s) => s.index === selectedStepIndex)
						if (!st) { atStepDetail = false; break }

						const stepActionOpts = buildStepActionOptions(ph3, st)
						const l3choice = await ctx.ui.select(buildStepDetailTitle(ph3, st), stepActionOpts)

						if (!l3choice || l3choice === "Back to phase") { atStepDetail = false; break }
						await handleStepAction(l3choice, f3, ph3, st, ctx)
					}
				}
			}

			// Dialog closed — restore the persistent widget
			mountWidget(ctx)
		},
	})

	// ─── Tools ──────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "create_ferment",
		label: "Create Ferment",
		description: "Create a new ferment at draft status.",
		parameters: CreateFermentParams,
		async execute(_, params) {
			const f = getStorage().create(params.name, params.description)
			setActive(f)
			appendRefEntry(pi, f.id)
			const wt = f.worktree
			const branch = wt.branch ?? "(no git)"
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Created "${f.name}".  Mode: ${f.mode}  •  Branch: ${branch}  •  Path: ${wt.path}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "list_ferments",
		label: "List Ferments",
		description:
			"List all ferments. Filter by status if needed (draft/planned/running/paused/complete/abandoned). The active ferment is marked.",
		parameters: ListParams,
		async execute(_, params) {
			const items = getStorage().list()
			// Normalize filter: "active" is not a status — "running" is the running state
			const filterValue = params.filter === "active" ? "running" : params.filter
			const filtered = filterValue ? items.filter((f) => f.status === filterValue) : items
			if (filtered.length === 0) {
				const msg = filterValue ? `No ferments with status "${filterValue}".` : "No ferments."
				return { details: undefined, content: [{ type: "text", text: msg }] }
			}
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferments:\n${filtered
							.map((f) => {
								const active = f.id === activeFermentId ? " ← active" : ""
								return `- ${f.id} │ ${f.name} [${f.status}] — ${f.phaseCount} phases${active}`
							})
							.join("\n")}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "scope_ferment",
		label: "Scope Ferment",
		description:
			"Save scoping answers and transition ferment from draft to planned. MUST only be called after showing the user a full summary (goal + criteria + constraints + all phases with steps) and receiving explicit confirmation. Do NOT call this while still collecting answers or proposing phases.",
		parameters: ScopeParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f)
				return {
					details: undefined,
					content: [{ type: "text", text: `Ferment not found: ${params.ferment_id}` }],
					isError: true,
				}

			// Cannot re-scope if already past draft
			if (f.status !== "draft") {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Ferment is already ${f.status}. Use update_scope_field to revise individual fields.`,
						},
					],
					isError: true,
				}
			}

			if (params.title) {
				s.rename(f.id, params.title)
			}

			// Set each scoping field atomically
			s.setScopingGoal(f.id, params.goal)

			if (params.success_criteria) {
				s.setScopingCriteria(f.id, params.success_criteria)
			}

			if (params.constraints && params.constraints.length > 0) {
				s.setScopingConstraints(f.id, params.constraints)
			}

			let phases: Phase[] = []
			if (params.phases && params.phases.length > 0) {
				phases = params.phases.map((p, i) => {
					const steps: import("../ferment/types.js").Step[] = (p.steps ?? []).map((st, si) => ({
						id: `step-${si + 1}`,
						index: si + 1,
						description: st.description,
						status: "pending" as const,
						verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
					}))
					return {
						id: `phase-${i + 1}`,
						index: i + 1,
						name: p.name,
						goal: p.goal,
						description: p.description ?? "",
						constraints: p.constraints,
						budget: p.budget,
						parallel: p.parallel_group !== undefined,
						groupIndex: p.parallel_group,
						status: "planned" as const,
						steps,
					}
				})
				s.setScopingPhases(f.id, phases)
			}

			// Transition to planned only after scoping is saved
			s.updateStatus(f.id, "planned")
			const fresh = s.get(f.id)
			if (fresh) setActive(fresh)

			// ── Plan review: judge checks phases before execution starts ─────────
			const f2 = s.get(f.id)
			const phaseList = f2?.phases.map((p) => `  [${p.id}] ${p.index}. ${p.name} — ${p.goal}`).join("\n") ?? "(none)"

			const planReview = await judgePlan(
				f2?.name ?? f.name,
				params.goal,
				params.success_criteria ?? "",
				(params.constraints ?? []).join(", "),
				phaseList,
			)

			// Do NOT call onPhaseCompleted here — ferment just became "planned",
			// not executing. The engine's activate_phase nudge handles the next step.
			maybeInjectAutoNudge(pi)

			const reviewNote =
				planReview.verdict === "approve"
					? `\n\nPlan review: ✓ approved (confidence: ${planReview.confidence}%)`
					: `\n\nPlan review: ⚠ revision suggested (confidence: ${planReview.confidence}%)\n${planReview.suggestions.map((s) => `  • ${s}`).join("\n")}\n\nRevise the phases if needed, then proceed with activate_phase.`

			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${f2?.name ?? f.name}" scoped and ready.\nferment_id: ${f2?.id ?? f.id}\nGoal: ${params.goal}\nPhases:\n${phaseList}${reviewNote}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "update_scope_field",
		label: "Update Scope Field",
		description: "Revise a single scoping field (goal, criteria, constraints) on an already-planned ferment.",
		parameters: Type.Object({
			ferment_id: Type.String(),
			field: Type.String({ description: "goal | criteria | constraints" }),
			value: Type.String({ description: "New value. For constraints, use comma-separated list." }),
		}),
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }

			let updated: Ferment | undefined

			if (params.field === "goal") {
				updated = s.setScopingGoal(f.id, params.value)
			} else if (params.field === "criteria") {
				updated = s.setScopingCriteria(f.id, params.value)
			} else if (params.field === "constraints") {
				const parsed = params.value
					.split(",")
					.map((c) => c.trim())
					.filter(Boolean)
				updated = s.setScopingConstraints(f.id, parsed)
			} else {
				return {
					details: undefined,
					content: [{ type: "text", text: `Unknown field: ${params.field}. Use goal, criteria, or constraints.` }],
					isError: true,
				}
			}

			if (updated) setActive(updated)
			return {
				details: undefined,
				content: [{ type: "text", text: `Field "${params.field}" updated for "${f.name}".` }],
			}
		},
	})

	pi.registerTool({
		name: "activate_phase",
		label: "Activate Phase",
		description: "Start a planned phase.",
		parameters: ActivateParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }

			// Resolve target phase: by id, by name, or fallback to first planned
			let target = params.phase_id ? f.phases.find((p) => p.id === params.phase_id) : undefined
			if (!target && params.phase_id) {
				const name = params.phase_id.toLowerCase()
				target = f.phases.find((p) => p.name.toLowerCase().includes(name))
			}
			if (!target) {
				target = findFirstPlannedPhase(f)
			}
			if (!target)
				return {
					details: undefined,
					content: [{ type: "text", text: "No planned phases to activate." }],
					isError: true,
				}

			// Detect parallel group — activate all siblings at once
			if (target.groupIndex !== undefined) {
				const r = s.activatePhaseGroup(f.id, target.groupIndex)
				if (!r)
					return { details: undefined, content: [{ type: "text", text: "Phase group activation failed." }], isError: true }
				setActive(r)
				s.updateStatus(f.id, "running")
				const groupPhases = r.phases.filter((p) => p.groupIndex === target.groupIndex && p.status === "active")
				const phaseLines = groupPhases
					.map((gp) => {
						const stepList =
							gp.steps.length > 0
								? `\n    Steps:\n${gp.steps.map((st) => `      ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
								: "\n    No steps yet — call refine_phase to populate them."
						return `  ∥ [${gp.id}] ${gp.index}. "${gp.name}"${stepList}`
					})
					.join("\n")
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Parallel group ${target.groupIndex} activated (${groupPhases.length} phases running concurrently).\nferment_id: ${f.id}\nparallel_group: ${target.groupIndex}\nphase_ids: ${groupPhases.map((p) => p.id).join(", ")}\n\n${phaseLines}\n\nRun all parallel phases concurrently: call refine_phase + start_step for each phase simultaneously.`,
						},
					],
				}
			}

			const r = s.activatePhase(f.id, target.id)
			if (!r)
				return { details: undefined, content: [{ type: "text", text: "Phase activation failed." }], isError: true }
			setActive(r)
			s.updateStatus(f.id, "running")
			const activatedPhase = r.phases.find((p) => p.id === target.id)
			const stepList =
				activatedPhase && activatedPhase.steps.length > 0
					? `\nSteps:\n${activatedPhase.steps.map((st) => `  ${st.index}. [${st.id}] ${st.description}`).join("\n")}`
					: "\nNo steps yet — call refine_phase to populate them."
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Phase "${target.name}" activated.\nferment_id: ${f.id}\nphase_id: ${target.id}${stepList}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "refine_phase",
		label: "Refine Phase",
		description: "Add steps to an active phase. Overwrites existing. Use the phase_id returned by activate_phase.",
		parameters: RefineParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			// Resolve phase: exact id → name substring → active phase fallback
			let phase = f.phases.find((p) => p.id === params.phase_id)
			if (!phase) {
				const needle = params.phase_id.toLowerCase()
				phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
			}
			if (!phase) {
				// Last resort: use the active phase if there's exactly one
				const active = f.phases.find((p) => p.status === "active")
				if (active) phase = active
			}
			if (!phase)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Phase not found. Active phases: ${
								f.phases
									.filter((p) => p.status === "active")
									.map((p) => `${p.id} (${p.name})`)
									.join(", ") || "none"
							}`,
						},
					],
					isError: true,
				}
			if (phase.status !== "active")
				return {
					details: undefined,
					content: [{ type: "text", text: `Phase must be active. Current: ${phase.status}` }],
					isError: true,
				}

			const steps: import("../ferment/types.js").Step[] = params.steps.map((st, i) => ({
				id: `step-${i + 1}`,
				index: i + 1,
				description: st.description,
				status: "pending",
				needsVision: st.needs_vision ?? false,
				workerModel: st.needs_vision ? "kimi-k2.5" : "minimax-m2.7",
				canRunParallel: st.can_run_parallel ?? false,
				verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
			}))
			const r = s.refinePhase(f.id, phase.id, steps)
			if (r) setActive(r)
			const stepList = steps.map((st, i) => `  ${i + 1}. [step-${i + 1}] ${st.description}`).join("\n")
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `"${phase.name}" refined with ${steps.length} step(s).\nferment_id: ${f.id}\nphase_id: ${phase.id}\n${stepList}\nCall start_step with step_id to begin.`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "start_step",
		label: "Start Step",
		description:
			"Mark step as running, then immediately spawn a subagent to execute it. Use provider 'kimchi-dev' and the worker_model returned in this tool's result (minimax-m2.7 for code/text, kimi-k2.5 for vision). Pass the step description as the subagent prompt along with any relevant file context. If parallel_siblings are listed in the result, call start_step for each of them too and spawn their subagents concurrently — do not wait for one to finish before starting the next. When all subagents finish, call complete_step for each.",
		parameters: StepActionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const step = resolveStep(phase, params.step_id)
			if (!step)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step not found. Steps: ${phase.steps.map((st) => `[${st.id}] ${st.index}. ${st.description}`).join(", ")}`,
						},
					],
					isError: true,
				}
			// Block concurrent start only when the existing running step is NOT parallel-safe
			// (or the step being started is not parallel-safe either).
			const alreadyRunning = phase.steps.find((st) => st.status === "running" && st.id !== step.id)
			if (alreadyRunning && (!alreadyRunning.canRunParallel || !step.canRunParallel)) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Cannot start step ${step.index} — step ${alreadyRunning.index} ("${alreadyRunning.description}") is already running and is not parallel-safe. Complete or skip it first.`,
						},
					],
					isError: true,
				}
			}
			const r = s.startStep(f.id, phase.id, step.id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step start failed." }], isError: true }
			setActive(r)
			const workerModel = step.workerModel ?? "minimax-m2.7"

			// Find pending parallel siblings (excluding this step) so the planner
			// can start them all concurrently without waiting for this one to finish.
			const parallelSiblings = step.canRunParallel
				? phase.steps
						.filter((st) => st.id !== step.id && st.status === "pending" && st.canRunParallel)
						.map((st) => ({
							step_id: st.id,
							description: st.description,
							worker_model: st.workerModel ?? "minimax-m2.7",
						}))
				: []

			const parallelNote =
				parallelSiblings.length > 0
					? `\nparallel_siblings: ${JSON.stringify(parallelSiblings)}\n\nThese steps are independent — call start_step for each one now and spawn their subagents concurrently. Do not wait for one to finish before starting the next.`
					: ""

			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step.index}: "${step.description}" started.\nphase_id: ${phase.id}\nstep_id: ${step.id}\nworker_model: ${workerModel}\nprovider: kimchi-dev\n\nSpawn a subagent now with provider "kimchi-dev", model "${workerModel}", and a prompt describing exactly what to implement for this step. When it returns, call complete_step with its summary.${parallelNote}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "complete_step",
		label: "Complete Step",
		description:
			"Mark step as done. If the step has a verification command it runs automatically — no need to call verify_step separately.",
		parameters: CompleteStepParams,
		async execute(_, params, signal, onUpdate, ctx) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const step = resolveStep(phase, params.step_id)
			if (!step) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			const r = s.completeStep(f.id, phase.id, step.id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step completion failed." }], isError: true }
			setActive(r)

			if (!step.verification) {
				// Grade step even without verification (summary-based)
				const grade = await judgeGradeStep(step.description, params.summary ?? "")
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done.  Grade: ${grade.grade} — ${grade.rationale}  ${params.summary ?? ""}`,
						},
					],
				}
			}

			// ── Auto-verify: run bash verification command ──
			let exitCode = 0
			let stdout = ""
			let stderr = ""
			// biome-ignore lint/suspicious/noExplicitAny: accessing controller tools
			const controller = (ctx as any)?.controller
			if (controller?.tools?.bash?.execute) {
				try {
					// biome-ignore lint/suspicious/noExplicitAny: tool execution
					const execResult = await (controller.tools.bash.execute as any)(
						"",
						{ command: step.verification.command },
						signal,
						onUpdate,
						ctx,
					)
					stdout = execResult.stdout ?? ""
					stderr = execResult.stderr ?? ""
					exitCode = execResult.exitCode ?? 0
				} catch {
					exitCode = 1
					stderr = "bash execution threw an exception"
				}
			}

			const verifyResult: StepResult = {
				success: exitCode === 0,
				exitCode,
				stdout,
				stderr,
				completedAt: new Date().toISOString(),
			}
			const verified = s.verifyStep(f.id, phase.id, step.id, verifyResult)
			if (verified) setActive(verified)

			if (exitCode === 0) {
				// ── Grade the step (clean pass) ──────────────────────────────────
				const grade = await judgeGradeStep(step.description, params.summary ?? "", {
					exitCode,
					stdout,
					stderr,
				})
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done and verified ✓  Grade: ${grade.grade} — ${grade.rationale}`,
						},
					],
				}
			}

			// ── Judge: ask Opus whether this is a real failure or flaky/retry ──
			const judgeVerdict = await judgeStepVerification(
				step.description,
				step.verification.command,
				stdout,
				stderr,
				exitCode,
			)

			if (judgeVerdict.verdict === "pass") {
				// Judge says non-zero exit is acceptable — grade it
				const grade = await judgeGradeStep(step.description, params.summary ?? "", { exitCode, stdout, stderr })
				const graded = s.setStepGrade(f.id, phase.id, step.id, grade)
				if (graded) setActive(graded)
				onStepCompleted(pi)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index}: "${step.description}" done ✓  Judge: ${judgeVerdict.reason}  Grade: ${grade.grade}`,
						},
					],
				}
			}

			if (judgeVerdict.verdict === "retry") {
				const failed = s.failStep(
					f.id,
					phase.id,
					step.id,
					`Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
				)
				if (failed) setActive(failed)
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step ${step.index} verification failed — retry suggested.\nExit: ${exitCode}\nJudge: ${judgeVerdict.reason}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
						},
					],
					isError: true,
				}
			}

			// verdict === "fail"
			const failed = s.failStep(
				f.id,
				phase.id,
				step.id,
				`Verification failed (exit ${exitCode}): ${judgeVerdict.reason}`,
			)
			if (failed) setActive(failed)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step.index} failed verification.\nExit: ${exitCode}\nJudge: ${judgeVerdict.reason}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
					},
				],
				isError: true,
			}
		},
	})

	pi.registerTool({
		name: "verify_step",
		label: "Verify Step",
		description: "Run verification command and record result.",
		parameters: VerifyParams,
		async execute(_, params, signal, onUpdate, ctx) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const step = resolveStep(phase, params.step_id)
			if (!step) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }

			let exitCode = 0
			let stdout = ""
			let stderr = ""

			// biome-ignore lint/suspicious/noExplicitAny: accessing controller tools
			const controller = (ctx as any).controller
			if (controller?.tools?.bash?.execute) {
				try {
					// biome-ignore lint/suspicious/noExplicitAny: tool execution
					const execResult = await (controller.tools.bash.execute as any)(
						"",
						{ command: params.command },
						signal,
						onUpdate,
						ctx,
					)
					stdout = execResult.stdout ?? ""
					stderr = execResult.stderr ?? ""
					exitCode = execResult.exitCode ?? 0
				} catch {
					exitCode = 1
				}
			} else {
				stdout = params.command
			}

			const result: StepResult = {
				success: exitCode === 0,
				exitCode,
				stdout,
				stderr,
				completedAt: new Date().toISOString(),
			}

			const r = s.verifyStep(f.id, phase.id, step.id, result)
			if (r) setActive(r)
			onStepCompleted(pi)

			if (result.success)
				return { details: undefined, content: [{ type: "text", text: `✓ "${step.description}" verified.` }] }
			return {
				details: undefined,
				content: [{ type: "text", text: `✗ "${step.description}" failed (exit ${exitCode}).` }],
				isError: true,
			}
		},
	})

	pi.registerTool({
		name: "skip_step",
		label: "Skip Step",
		description: "Skip a step.",
		parameters: StepActionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const step = resolveStep(phase, params.step_id)
			if (!step) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			const r = s.skipStep(f.id, phase.id, step.id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			setActive(r)
			onStepCompleted(pi)
			return { details: undefined, content: [{ type: "text", text: "Step skipped." }] }
		},
	})

	pi.registerTool({
		name: "complete_phase",
		label: "Complete Phase",
		description: "Mark phase as completed. Judge grades the phase based on step results.",
		parameters: CompletePhaseParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }

			const r = s.completePhase(f.id, phase.id, params.summary)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Phase completion failed." }], isError: true }
			setActive(r)

			// ── Grade the phase ──────────────────────────────────────────────────
			const stepSummaries = phase.steps
				.map((st) => `  ${st.index}. ${st.description} [${st.status}]${st.grade ? ` Grade:${st.grade.grade}` : ""}`)
				.join("\n")
			const phaseGrade = await judgeGradePhase(phase.name, phase.goal, stepSummaries, params.summary)
			const graded = s.setPhaseGrade(f.id, phase.id, phaseGrade)
			if (graded) setActive(graded)

			onPhaseCompleted(pi)
			const fresh = s.get(f.id) ?? r
			const next = fresh.phases.find((p) => p.status === "planned")
			const gradeNote = `  Grade: ${phaseGrade.grade} — ${phaseGrade.rationale}`

			if (next) {
				if (isPlanMode()) {
					return {
						details: undefined,
						content: [
							{
								type: "text",
								text: `Phase done.${gradeNote}\nNext: Phase ${next.index}: "${next.name}" (${next.goal}). Activate it?`,
							},
						],
					}
				}
				return {
					details: undefined,
					content: [{ type: "text", text: `Phase done.${gradeNote}\nNext: "${next.name}".` }],
				}
			}
			return {
				details: undefined,
				content: [{ type: "text", text: `Phase done.${gradeNote}\nAll phases terminal. Use complete_ferment.` }],
			}
		},
	})

	pi.registerTool({
		name: "skip_phase",
		label: "Skip Phase",
		description: "Skip a phase.",
		parameters: SkipPhaseParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const r = s.skipPhase(f.id, params.phase_id, params.reason)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			setActive(r)
			return { details: undefined, content: [{ type: "text", text: "Phase skipped." }] }
		},
	})

	pi.registerTool({
		name: "complete_ferment",
		label: "Complete Ferment",
		description: "Mark ferment as complete. All phases must be terminal (completed, skipped, or failed). Judge computes overall grade.",
		parameters: CompleteFermentParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const nonTerminal = f.phases.some((p) => p.status === "planned" || p.status === "active")
			if (nonTerminal) {
				const blocking = f.phases.filter((p) => p.status === "planned" || p.status === "active")
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Cannot complete: ${blocking.length} phase(s) still active or planned: ${blocking.map((p) => `"${p.name}"`).join(", ")}`,
						},
					],
					isError: true,
				}
			}

			s.updateStatus(f.id, "complete")

			// ── Compute overall ferment grade from phase grades ──────────────────
			const fresh = s.get(f.id) ?? f
			const fermentGrade = computeFermentGrade(fresh.phases)
			const graded = s.setFermentGrade(fresh.id, fermentGrade)
			if (graded) setActive(graded)

			const failedPhases = fresh.phases.filter((p) => p.status === "failed").length
			const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
			const phaseGradeSummary = fresh.phases
				.filter((p) => p.grade)
				.map((p) => `  ${p.index}. ${p.name}: ${p.grade!.grade}`)
				.join("\n")
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${fresh.name}" complete${failedNote}.\n\nOverall Grade: ${fermentGrade.grade} — ${fermentGrade.rationale}\n\nPhase grades:\n${phaseGradeSummary || "  (none graded)"}\n\n${params.final_summary ?? ""}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "fail_step",
		label: "Fail Step",
		description: "Mark a step as failed with an error message.",
		parameters: Type.Object({
			ferment_id: Type.String(),
			phase_id: Type.String(),
			step_id: Type.String(),
			error: Type.Optional(Type.String({ description: "Error message or reason for failure" })),
		}),
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const step = resolveStep(phase, params.step_id)
			if (!step) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			const r = s.failStep(f.id, phase.id, step.id, params.error)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step fail failed." }], isError: true }
			setActive(r)
			onStepCompleted(pi)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step.index}: "${step.description}" marked as failed. Use skip_step to skip it, or retry the work and call start_step again.`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "fail_phase",
		label: "Fail Phase",
		description: "Mark a phase as failed with a reason.",
		parameters: Type.Object({
			ferment_id: Type.String(),
			phase_id: Type.String(),
			reason: Type.String({ description: "Why the phase failed" }),
		}),
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = resolvePhase(f, params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			const r = s.failPhase(f.id, phase.id, params.reason)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Phase fail failed." }], isError: true }
			setActive(r)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Phase marked as failed: ${params.reason}. Options: skip_phase to skip it, activate_phase to retry, or /ferment abandon.`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "add_decision",
		label: "Add Decision",
		description: "Record a decision.",
		parameters: DecisionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.addDecision(params.ferment_id, params.title, params.description, params.phase_id, params.step_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			setActive(f)
			return {
				details: undefined,
				content: [{ type: "text", text: `Decision: ${f.decisions[f.decisions.length - 1].id} — ${params.title}` }],
			}
		},
	})

	pi.registerTool({
		name: "add_memory",
		label: "Add Memory",
		description: "Record a memory.",
		parameters: MemoryParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.addMemory(
				params.ferment_id,
				params.category as MemoryCategory,
				params.content,
				params.phase_id,
				params.step_id,
			)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			setActive(f)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Memory: ${f.memories[f.memories.length - 1].id} [${params.category}]: ${params.content}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "set_ferment_mode",
		label: "Set Ferment Mode",
		description: "Change the work mode of a ferment.",
		parameters: SetModeParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			if (!["plan", "exec", "auto"].includes(params.mode)) {
				return {
					details: undefined,
					content: [{ type: "text", text: `Invalid mode: ${params.mode}. Use plan, exec, or auto.` }],
					isError: true,
				}
			}
			const updated = s.updateMode(f.id, params.mode as FermentWorkMode)
			if (updated) setActive(updated)
			return { details: undefined, content: [{ type: "text", text: `Mode set to ${params.mode} for "${f.name}".` }] }
		},
	})
}
