/**
 * Ferment Extension v4
 *
 * State-driven execution: the JSON plan IS the state.
 * Interactive breakdown: the LLM guides the user through
 * a conversational flow for creating and managing ferments.
 */

import { execSync } from "node:child_process"
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { ORANGE_FG, RST_FG, SUCCESS_FG, TEAL_FG, WARNING_FG } from "../ansi.js"
import { findFirstPlannedPhase, getScopingProgress, whatNext } from "../ferment/engine.js"
import { shortenTitle } from "../ferment/shorten-title.js"
import { FermentError, FermentStorage } from "../ferment/store.js"
import type { Ferment, FermentWorkMode, MemoryCategory, Phase, Step, StepResult } from "../ferment/types.js"

// ─── Module state ─────────────────────────────────────────────────────────────

let activeFermentId: string | undefined
let activeFerment: Ferment | undefined
let autoModeEnabled = true

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

// ─── Progress rendering ───────────────────────────────────────────────────────

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RST_ALL = "\x1b[0m"

function pr_teal(s: string): string {
	return `${TEAL_FG}${s}${RST_FG}`
}
function pr_orange(s: string): string {
	return `${ORANGE_FG}${s}${RST_FG}`
}
function pr_success(s: string): string {
	return `${SUCCESS_FG}${s}${RST_FG}`
}
function pr_warn(s: string): string {
	return `${WARNING_FG}${s}${RST_FG}`
}
function pr_dim(s: string): string {
	return `${DIM}${s}${RST_ALL}`
}
function pr_bold(s: string): string {
	return `${BOLD}${s}${RST_ALL}`
}

function stepBullet(status: Step["status"]): string {
	switch (status) {
		case "done":
		case "verified":
			return pr_success("  ✓")
		case "running":
			return pr_teal("  ▶")
		case "failed":
			return pr_orange("  ✗")
		case "skipped":
			return pr_dim("  ⊘")
		default:
			return pr_dim("  ○")
	}
}

function phaseBullet(p: Phase, isActive: boolean): string {
	if (isActive || p.status === "active") return pr_teal("▶")
	switch (p.status) {
		case "completed":
			return pr_success("✓")
		case "failed":
			return pr_orange("✗")
		case "skipped":
			return pr_dim("⊘")
		default:
			return pr_dim("○")
	}
}

function phaseStatusTag(p: Phase): string {
	switch (p.status) {
		case "completed":
			return pr_success("done")
		case "failed":
			return pr_orange("failed")
		case "skipped":
			return pr_dim("skipped")
		case "active":
			return pr_teal("active")
		default:
			return pr_dim("planned")
	}
}

// The content shown in the title area of the select dialog (the rich body)
function buildOverviewTitle(f: Ferment): string {
	const terminalCount = f.phases.filter(
		(p) => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	).length
	const total = f.phases.length

	// Progress bar
	const barLen = 24
	const filled = total > 0 ? Math.round((terminalCount / total) * barLen) : 0
	const bar = `${SUCCESS_FG}${"█".repeat(filled)}${RST_FG}${DIM}${"░".repeat(barLen - filled)}${RST_ALL}`
	const pct = total > 0 ? Math.round((terminalCount / total) * 100) : 0

	// Header
	const modeTag = f.mode === "exec" ? pr_orange(f.mode) : f.mode === "plan" ? pr_warn(f.mode) : pr_teal(f.mode)
	const statusTag = f.status === "running" ? pr_teal(f.status) : pr_dim(f.status)
	const scopeProgress = getScopingProgress(f)
	const scopeTag = f.status === "draft" ? `  ${pr_dim(`scoping ${scopeProgress.answered}/4`)}` : ""

	const branch = f.worktree.branch ? pr_teal(f.worktree.branch) : pr_dim("no branch")
	const commit = f.worktree.commit ? pr_dim(` @${f.worktree.commit.slice(0, 7)}`) : ""

	const lines: string[] = [
		`${pr_teal("🍺")} ${pr_bold(f.name)}  ${pr_dim("[")}${statusTag}${pr_dim("]")}  ${modeTag} mode${scopeTag}`,
		`${bar}  ${pr_teal(`${pct}%`)}  ${pr_dim(`${terminalCount}/${total} phases complete`)}`,
		`${pr_dim("branch:")} ${branch}${commit}`,
	]

	if (f.goal) lines.push(`${pr_dim("goal:")}   ${f.goal}`)

	lines.push("")

	// Phase list
	for (const p of f.phases) {
		const isActive = p.id === f.activePhaseId
		const bullet = phaseBullet(p, isActive)
		const nameText = isActive ? pr_teal(p.name) : p.status === "completed" ? pr_dim(p.name) : p.name
		const tag = phaseStatusTag(p)

		const stepsDone = p.steps.filter(
			(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
		).length
		const stepsTotal = p.steps.length
		const stepsTag = stepsTotal > 0 ? `  ${pr_dim(`${stepsDone}/${stepsTotal}`)}` : ""
		const activeTag = isActive ? `  ${pr_teal("← working here")}` : ""

		lines.push(`  ${bullet}  Phase ${p.index}  ${nameText}  ${tag}${stepsTag}${activeTag}`)
		lines.push(`       ${pr_dim(p.goal)}`)

		// For active phase: show its steps inline
		if ((isActive || p.status === "active") && p.steps.length > 0) {
			for (const s of p.steps) {
				const sBullet = stepBullet(s.status)
				const sText =
					s.status === "running"
						? pr_teal(s.description)
						: s.status === "failed"
							? pr_orange(s.description)
							: s.status === "done" || s.status === "verified"
								? pr_dim(s.description)
								: s.description
				lines.push(`    ${sBullet}  ${sText}`)
			}
		}
	}

	if (f.decisions.length > 0 || f.memories.length > 0) {
		lines.push("")
		lines.push(pr_dim(`  ${f.decisions.length} decision(s)  ·  ${f.memories.length} memory(-ies)`))
	}

	return lines.join("\n")
}

// The content shown in the title area when drilling into a phase
function buildPhaseTitle(f: Ferment, p: Phase): string {
	const isActive = p.id === f.activePhaseId
	const bullet = phaseBullet(p, isActive)
	const tag = phaseStatusTag(p)

	const stepsDone = p.steps.filter(
		(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
	).length
	const stepsTag = p.steps.length > 0 ? `  ${pr_dim(`${stepsDone}/${p.steps.length} steps done`)}` : ""

	const lines: string[] = [
		`${pr_dim(`Phase ${p.index} of ${f.phases.length}`)}  —  ${pr_bold(f.name)}`,
		`"`,
		`  ${bullet}  ${pr_bold(p.name)}  ${tag}${stepsTag}`,
		`     ${pr_dim(p.goal)}`,
	]

	if (p.constraints && p.constraints.length > 0) {
		lines.push(`     ${pr_dim("constraints:")} ${pr_dim(p.constraints.join(", "))}`)
	}

	if (p.steps.length > 0) {
		lines.push("")
		for (const s of p.steps) {
			const sBullet = stepBullet(s.status)
			const sText =
				s.status === "running"
					? pr_teal(s.description)
					: s.status === "failed"
						? pr_orange(s.description)
						: s.status === "done" || s.status === "verified"
							? pr_dim(s.description)
							: s.description
			const verifyHint = s.verification ? `  ${pr_dim(`· verify: ${truncateLabel(s.verification.command, 50)}`)}` : ""
			lines.push(`  ${sBullet}  ${sText}${verifyHint}`)
		}
	} else if (p.status === "active" || isActive) {
		lines.push("")
		lines.push(`  ${pr_dim("No steps yet — ask the agent to refine this phase.")}`)
	}

	if (p.summary) {
		lines.push("")
		lines.push(`  ${pr_dim("↳")} ${pr_dim(p.summary)}`)
	}

	return lines.join("\n")
}

// Overview menu options — clean, action-focused labels
function buildOverviewOptions(f: Ferment): string[] {
	const opts: string[] = []

	for (const p of f.phases) {
		const isActive = p.id === f.activePhaseId
		const marker = isActive
			? "▶"
			: p.status === "completed"
				? "✓"
				: p.status === "failed"
					? "✗"
					: p.status === "skipped"
						? "⊘"
						: "○"
		opts.push(`${marker}  Phase ${p.index}: ${p.name}`)
	}

	opts.push("──────────────────────────────")

	if (f.status === "running" || f.status === "planned") {
		opts.push("Jump to active phase")
	}
	if (f.status !== "complete" && f.status !== "abandoned") {
		opts.push("Abandon ferment")
	}
	opts.push("Close")

	return opts
}

// Phase drill-down options — context-sensitive actions
function buildPhaseOptions(f: Ferment, p: Phase): string[] {
	const opts: string[] = []
	const isActive = p.id === f.activePhaseId

	if (p.status === "planned" && !isActive) opts.push("Activate phase")
	if ((p.status === "active" || isActive) && p.steps.length === 0) opts.push("Ask agent to refine into steps")

	if (p.status === "active" || isActive) {
		const next = p.steps.find((s) => s.status === "pending" || s.status === "running" || s.status === "failed")
		if (next?.status === "failed") {
			opts.push(`Retry step ${next.index}`)
			opts.push(`Skip step ${next.index}`)
		} else if (next) {
			opts.push(`Start step ${next.index}`)
		}

		const allDone =
			p.steps.length > 0 &&
			p.steps.every(
				(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
			)
		if (allDone) opts.push("Mark phase complete")
		opts.push("Mark phase failed")
		opts.push("Skip phase")
	}

	if (p.status === "failed") {
		opts.push("Re-activate phase")
		opts.push("Skip phase")
	}

	opts.push("──────────────────────────────")
	opts.push("Back to overview")

	return opts
}

function truncateLabel(s: string, max = 40): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

async function handlePhaseOption(
	choice: string | undefined,
	f: Ferment,
	p: Phase,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!choice || choice === "Back to overview" || choice.startsWith("──")) return

	const s = getStorage()

	switch (choice) {
		case "Activate phase": {
			const r = s.activatePhase(f.id, p.id)
			if (r) {
				s.updateStatus(f.id, "running")
				setActive(r)
			}
			ctx.ui.notify(`Phase "${p.name}" activated.`)
			break
		}
		case "Ask agent to refine into steps":
			ctx.ui.notify(`Tell the agent: "Refine phase ${p.index} '${p.name}' — break it into concrete steps."`)
			break
		case "Mark phase complete": {
			const r = s.completePhase(f.id, p.id, "Completed via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" marked complete.`)
			break
		}
		case "Skip phase": {
			const r = s.skipPhase(f.id, p.id, "Skipped via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" skipped.`)
			break
		}
		case "Re-activate phase": {
			const r = s.activatePhase(f.id, p.id)
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" re-activated.`)
			break
		}
		case "Mark phase failed": {
			const reason = ctx.ui.input ? await ctx.ui.input("Reason for failure:", "") : ""
			const r = s.failPhase(f.id, p.id, reason || "Failed via /progress")
			if (r) setActive(r)
			ctx.ui.notify(`Phase "${p.name}" marked as failed.`)
			break
		}
		default: {
			// "Start step N", "Retry step N", "Skip step N"
			const startM = choice.match(/^Start step (\d+)$/)
			const retryM = choice.match(/^Retry step (\d+)$/)
			const skipM = choice.match(/^Skip step (\d+)$/)
			const m = startM ?? retryM ?? skipM
			if (m) {
				const stepIdx = Number.parseInt(m[1], 10)
				const step = p.steps.find((st) => st.index === stepIdx)
				if (step) {
					if (skipM) {
						const r = s.skipStep(f.id, p.id, step.id)
						if (r) setActive(r)
						ctx.ui.notify(`Step ${step.index} skipped.`)
					} else {
						const r = s.startStep(f.id, p.id, step.id)
						if (r) setActive(r)
						ctx.ui.notify(`Step ${step.index}: "${step.description}" — tell the agent to execute it.`)
					}
				}
			}
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

// ─── Scoping helper ───────────────────────────────────────────────────────────

function buildScopePrompt(fermentId: string, isPlan: boolean, rawIntent?: string): string {
	const f = getStorage().get(fermentId)
	if (!f) return ""
	const action = whatNext(f)
	const msg = isPlan ? stripToolRefs(action.message) : action.message
	if (!rawIntent) return msg
	return `User wants to ferment: "${rawIntent}"\n\n${msg}`
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
			}),
		),
	),
})

const ActivateParams = Type.Object({ ferment_id: Type.String(), phase_id: Type.Optional(Type.String()) })

const RefineParams = Type.Object({
	ferment_id: Type.String(),
	phase_id: Type.String(),
	steps: Type.Array(Type.Object({ description: Type.String(), verify: Type.Optional(Type.String()) })),
})

const StepActionParams = Type.Object({ ferment_id: Type.String(), phase_id: Type.String(), step_id: Type.String() })

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

	// ─── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("ferment", {
		description: 'Manage ferments: /ferment list, /ferment add "Name", /ferment switch <id>, /ferment delete <id>',
		async handler(args, ctx) {
			const raw = args.trim()
			const lo = raw.toLowerCase()
			const storage = getStorage()

			/* ── /ferment  (no args) → interactive prompt ── */
			if (raw === "") {
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

					// Hidden nudge for LLM — includes raw intent for context-aware scoping
					const prompt = buildScopePrompt(f.id, isPlanMode(), rawIntent)
					pi.sendMessage(
						{
							customType: "ferment_created_nudge",
							content: [{ type: "text", text: prompt }],
							display: false,
							details: undefined,
						},
						{ triggerTurn: true },
					)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
				}
				return
			}

			/* ── /ferment list ── */
			if (lo === "list") {
				const items = storage.list()
				if (items.length === 0) {
					ctx.ui.notify('No ferments. Use /ferment add "Name".')
					return
				}
				const lines = [
					"Ferments (ID | Name | Status | Phases):",
					"─".repeat(70),
					...items.map((f) => {
						const arrow = f.id === activeFermentId ? "▸ " : "  "
						return `${arrow}${f.id} │ ${f.name} │ ${f.status} │ ${f.phaseCount}`
					}),
					"",
					`Active ferment: ${activeFermentId ? `"${activeFerment?.name}" (${activeFermentId})` : "none"}`,
					"",
					"Commands:",
					"  /ferment switch <full-id>  — activate by full ID",
					'  /ferment switch "Name"     — activate by name',
					"  /ferment delete <full-id>  — delete by full ID",
					'  /ferment delete "Name"     — delete by name',
				]
				ctx.ui.notify(lines.join("\n"))
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

			/* ── /ferment add "Name" ── */
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

				const prompt = buildScopePrompt(f.id, isPlanMode(), rawName)
				pi.sendMessage(
					{
						customType: "ferment_created_nudge",
						content: [{ type: "text", text: prompt }],
						display: false,
						details: undefined,
					},
					{ triggerTurn: true },
				)
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

	pi.registerCommand("status", {
		description: "Show active ferment status",
		async handler(_, ctx) {
			if (!activeFerment) {
				ctx.ui.notify("No active ferment.")
				return
			}
			ctx.ui.notify(formatFermentStatus(activeFerment))
		},
	})

	pi.registerCommand("progress", {
		description: "Interactive progress view for the active ferment",
		async handler(_, ctx) {
			if (!activeFerment) {
				ctx.ui.notify("No active ferment. Start one with /ferment.")
				return
			}

			// ACP / headless fallback
			if (!ctx.hasUI) {
				ctx.ui.notify(formatFermentStatus(activeFerment))
				return
			}

			let open = true
			while (open) {
				// Re-read each loop iteration so actions immediately reflect
				const f = getStorage().get(activeFerment.id) ?? activeFerment
				const choice = await ctx.ui.select(buildOverviewTitle(f), buildOverviewOptions(f))

				if (!choice || choice === "Close" || choice.startsWith("──")) {
					open = false
					continue
				}

				if (choice === "Jump to active phase") {
					const active = f.phases.find((p) => p.id === f.activePhaseId)
					if (!active) {
						ctx.ui.notify("No active phase right now.")
						continue
					}
					const f2 = getStorage().get(f.id) ?? f
					const phaseChoice = await ctx.ui.select(buildPhaseTitle(f2, active), buildPhaseOptions(f2, active))
					if (phaseChoice !== "Back to overview" && !phaseChoice?.startsWith("──")) {
						const f3 = getStorage().get(f.id) ?? f
						await handlePhaseOption(phaseChoice, f3, active, ctx)
					}
					continue
				}

				if (choice === "Abandon ferment") {
					const confirm = await ctx.ui.select(
						`Abandon "${f.name}"?\n\nThis marks the ferment as abandoned. Work done so far is preserved.`,
						["Yes, abandon it", "No, keep going"],
					)
					if (confirm === "Yes, abandon it") {
						const r = getStorage().abandonFerment(f.id)
						if (r) setActive(r)
						ctx.ui.notify(`Ferment "${f.name}" abandoned.`)
						open = false
					}
					continue
				}

				// A phase bullet was selected — "▶  Phase N: Name" or "○  Phase N: Name"
				const phaseM = choice.match(/Phase (\d+):/)
				if (phaseM) {
					const idx = Number.parseInt(phaseM[1], 10)
					const f2 = getStorage().get(f.id) ?? f
					const phase = f2.phases.find((p) => p.index === idx)
					if (!phase) continue

					let inPhase = true
					while (inPhase) {
						const f3 = getStorage().get(f.id) ?? f
						const ph = f3.phases.find((p) => p.index === idx) ?? phase
						const phaseChoice = await ctx.ui.select(buildPhaseTitle(f3, ph), buildPhaseOptions(f3, ph))
						if (!phaseChoice || phaseChoice === "Back to overview" || phaseChoice.startsWith("──")) {
							inPhase = false
						} else {
							await handlePhaseOption(phaseChoice, f3, ph, ctx)
						}
					}
				}
			}
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
		description: "List all ferments.",
		parameters: ListParams,
		async execute(_, params) {
			const items = getStorage().list()
			const filtered = params.filter ? items.filter((f) => f.status === params.filter) : items
			if (filtered.length === 0) return { details: undefined, content: [{ type: "text", text: "No ferments." }] }
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferments:\n${filtered.map((f) => `- ${f.id} │ ${f.name} [${f.status}] — ${f.phaseCount} phases`).join("\n")}`,
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "scope_ferment",
		label: "Scope Ferment",
		description:
			"Save collected scoping answers for a ferment. Call only after user has reviewed and confirmed all answers. Transitions ferment to planned status.",
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
				phases = params.phases.map((p, i) => ({
					id: `phase-${i + 1}`,
					index: i + 1,
					name: p.name,
					goal: p.goal,
					description: p.description ?? "",
					constraints: p.constraints,
					budget: p.budget,
					status: "planned" as const,
					steps: [],
				}))
				s.setScopingPhases(f.id, phases)
			}

			// Transition to planned only after scoping is saved
			s.updateStatus(f.id, "planned")
			const fresh = s.get(f.id)
			if (fresh) setActive(fresh)

			onPhaseCompleted(pi)
			const f2 = s.get(f.id)
			const modeText = isExecMode()
				? "Auto-activating first phase..."
				: "Call activate_phase to start, or use /ferment mode exec for autonomous execution."
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${f2?.name ?? f.name}" scoped and ready.\nGoal: ${params.goal}\nPhases: ${f2?.phases.map((p) => `"${p.name}"`).join(", ") ?? "(none)"}\n${modeText}`,
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

			const r = s.activatePhase(f.id, target.id)
			if (!r)
				return { details: undefined, content: [{ type: "text", text: "Phase activation failed." }], isError: true }
			setActive(r)
			s.updateStatus(f.id, "running")
			return {
				details: undefined,
				content: [{ type: "text", text: `Phase "${target.name}" activated.` }],
			}
		},
	})

	pi.registerTool({
		name: "refine_phase",
		label: "Refine Phase",
		description: "Add steps to an active phase. Overwrites existing.",
		parameters: RefineParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const phase = f.phases.find((p) => p.id === params.phase_id)
			if (!phase) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
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
				verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
			}))
			const r = s.refinePhase(f.id, params.phase_id, steps)
			if (r) setActive(r)
			return {
				details: undefined,
				content: [{ type: "text", text: `"${phase.name}" has ${steps.length} step(s). Start with start_step.` }],
			}
		},
	})

	pi.registerTool({
		name: "start_step",
		label: "Start Step",
		description: "Mark step as running.",
		parameters: StepActionParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const r = s.startStep(f.id, params.phase_id, params.step_id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			setActive(r)
			const step = findStep(r, params.phase_id, params.step_id)
			return {
				details: undefined,
				content: [{ type: "text", text: `Step ${step?.index}: "${step?.description}" started.` }],
			}
		},
	})

	pi.registerTool({
		name: "complete_step",
		label: "Complete Step",
		description: "Mark step as done.",
		parameters: CompleteStepParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const r = s.completeStep(f.id, params.phase_id, params.step_id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			setActive(r)

			const step = findStep(r, params.phase_id, params.step_id)
			if (step?.verification) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `Step done. Verification: \`${step.verification.command}\`. Use verify_step or wait for auto-mode.`,
						},
					],
				}
			}
			onStepCompleted(pi)
			return {
				details: undefined,
				content: [{ type: "text", text: `Step ${step?.index}: "${step?.description}" done. ${params.summary ?? ""}` }],
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
			const step = findStep(f, params.phase_id, params.step_id)
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

			const r = s.verifyStep(f.id, params.phase_id, params.step_id, result)
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
			const r = s.skipStep(f.id, params.phase_id, params.step_id)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			setActive(r)
			onStepCompleted(pi)
			return { details: undefined, content: [{ type: "text", text: "Step skipped." }] }
		},
	})

	pi.registerTool({
		name: "complete_phase",
		label: "Complete Phase",
		description: "Mark phase as completed.",
		parameters: CompletePhaseParams,
		async execute(_, params) {
			const s = getStorage()
			const f = s.get(params.ferment_id)
			if (!f) return { details: undefined, content: [{ type: "text", text: "Ferment not found." }], isError: true }
			const r = s.completePhase(f.id, params.phase_id, params.summary)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
			setActive(r)
			onPhaseCompleted(pi)
			const next = r.phases.find((p) => p.status === "planned")
			if (next) {
				if (isPlanMode()) {
					return {
						details: undefined,
						content: [
							{
								type: "text",
								text: `Phase done. Next: Phase ${next.index}: "${next.name}" (${next.goal}). Activate it?`,
							},
						],
					}
				}
				return { details: undefined, content: [{ type: "text", text: `Phase done. Next up: "${next.name}".` }] }
			}
			return {
				details: undefined,
				content: [{ type: "text", text: "Phase done. All phases terminal. Use complete_ferment." }],
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
		description: "Mark ferment as complete. All phases must be terminal (completed, skipped, or failed).",
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
			const r = s.get(f.id)
			if (r) setActive(r)
			const failedPhases = f.phases.filter((p) => p.status === "failed").length
			const failedNote = failedPhases > 0 ? ` (${failedPhases} phase(s) failed)` : ""
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Ferment "${f.name}" complete${failedNote}. ${params.final_summary ?? ""}`,
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
			const r = s.failStep(f.id, params.phase_id, params.step_id, params.error)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Step not found." }], isError: true }
			setActive(r)
			onStepCompleted(pi)
			const step = findStep(r, params.phase_id, params.step_id)
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `Step ${step?.index}: "${step?.description}" marked as failed. Use skip_step to skip it, or retry the work and call start_step again.`,
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
			const r = s.failPhase(f.id, params.phase_id, params.reason)
			if (!r) return { details: undefined, content: [{ type: "text", text: "Phase not found." }], isError: true }
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
