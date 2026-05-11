/**
 * Ferment extension entry point.
 *
 * Wires together:
 * - Event handlers (session_start, session_shutdown, input, before_agent_start,
 *   model_select, turn_end)
 * - Slash commands (/ferment, /auto, /pause, /progress)
 * - All ferment tools (registered via tools/ submodules)
 *
 * Public exports re-export from ./state.ts for cli.ts and components/footer.ts.
 */

import { writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction, findFirstPlannedPhase, getScopingProgress, whatNext } from "../../ferment/engine.js"
import { evaluatePhaseFeedback, renderSelfImprovementSection } from "../../ferment/self-improve.js"
import { shortenTitle } from "../../ferment/shorten-title.js"
import { computeStats, serializeStats } from "../../ferment/stats.js"
import { FermentError, clearFermentCache } from "../../ferment/store.js"
import type { Ferment, FermentWorkMode, Step } from "../../ferment/types.js"
import { pr_bold, pr_dim, pr_orange, pr_success, pr_teal } from "./colors.js"
import { parseFermentCommand } from "./command-parser.js"
import { extractContextualOptions, extractTrailingQuestion } from "./contextual-options.js"
import { formatDecisionsAndMemories, formatFermentStatus, formatScopingContext, stripToolRefs } from "./format.js"
import { isPlanMode } from "./modes.js"
import { appendRefEntry, maybeInjectAutoNudge } from "./nudge.js"
import { maybeRunOnboarding } from "./onboarding.js"
import {
	buildPhaseActionOptions,
	buildPhaseDetailTitle,
	buildPhaseListOptions,
	buildPhaseListTitle,
	buildPhaseStepOptions,
	buildStepActionOptions,
	buildStepDetailTitle,
	handlePhaseAction,
	handleStepAction,
} from "./progress-overlay.js"
import { clearAllPendingScopes, clearPendingScope, getPendingScope, runScopingFlow } from "./scoping.js"
import {
	captureJudgeContext,
	clearAllScopingGates,
	clearAllStepStarts,
	clearFermentState,
	getActive,
	getActiveId,
	getCorrectiveStep,
	getStorage,
	isRestoringModel,
	isScopingInteractive,
	markHumanInput,
	markScopingConfirmed,
	markScopingInteractive,
	setActive,
	setAutoModeEnabled,
	setRestoringModel,
} from "./state.js"
import { applyAndPersist } from "./tool-helpers.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"
import { checkWorktree } from "./worktree.js"

// ─── Public exports for cli.ts and components/footer.ts ──────────────────────
// Keep the existing signatures so external imports don't break.

export function getActiveFerment() {
	return getActive()
}

/** 1-based phase index or undefined */
export function getCurrentPhaseIndex(): number | undefined {
	const f = getActive()
	if (!f || !f.activePhaseId) return undefined
	const idx = f.phases.findIndex((p) => p.id === f.activePhaseId)
	return idx >= 0 ? idx + 1 : undefined
}

/** Active phase name or undefined */
export function getCurrentPhaseName(): string | undefined {
	const f = getActive()
	if (!f || !f.activePhaseId) return undefined
	return f.phases.find((p) => p.id === f.activePhaseId)?.name
}

/** For CLI --ferment resume */
export function getActiveFermentIdForResume(): string | undefined {
	return getActiveId()
}

/** Backward compat for any code using these names */
export function getCurrentBatchIndex(): number | undefined {
	return getCurrentPhaseIndex()
}
export function getCurrentBatchName(): string | undefined {
	return getCurrentPhaseName()
}
export function getCurrentRecipe(): Step[] {
	const f = getActive()
	return f?.phases.find((p) => p.id === f.activePhaseId)?.steps ?? []
}

type AssistantContentPart = { type: string; text?: string; name?: string }

function hasToolCall(content: AssistantContentPart[], toolName: string): boolean {
	return content.some((c) => c.type === "toolCall" && c.name === toolName)
}

function extractPromptTextAfterLastToolCall(content: AssistantContentPart[]): string {
	const lastToolCall = content.findLastIndex((c) => c.type === "toolCall")
	return content
		.slice(lastToolCall + 1)
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trimEnd()
}

// ─── Planner system prompt supplement ─────────────────────────────────────────

function buildPlannerSupplement(): string {
	const f = getActive()
	if (!f) return ""
	const dm = formatDecisionsAndMemories(f)
	const dmSection = dm ? `\n\n${dm}` : ""
	const sc = formatScopingContext(f)
	const scSection = sc ? `\n\n${sc}` : ""

	// Self-improvement feedback: inject previous phase's grade if available
	const selfImprovementSection = buildSelfImprovementSection(f)

	return `\n\n## Ferment Planner Role\n\nYou are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers.\n\n**State machine:**\n- The ferment engine's determineNextAction() determines the next action from state\n- Read it via the engine, then execute that action directly\n- For start_step: call the tool, read worker_model from the result, spawn a subagent with provider "kimchi-dev"\n- If start_step returns parallel_siblings, call start_step for all of them and spawn their subagents CONCURRENTLY\n- After a subagent returns, call complete_step with its summary\n- For phase transitions (activate_phase, complete_phase, complete_ferment): call the tool directly, no subagent needed\n- Worker models: minimax-m2.7 for code/text, kimi-k2.5 for vision tasks\n\n**Rules:**\n- NEVER write, edit, or read files yourself during step execution\n- NEVER implement a step inline — always delegate to a subagent worker\n- If the current action is complete_step: this is a SUGGESTION — the LLM decides when the step is done based on subagent results\n\n**Parallel phases:**\n- When activate_phase returns parallel_group, all listed phase_ids are active simultaneously\n- Call refine_phase for ALL parallel phases in the same turn, then execute their steps concurrently\n- Complete each parallel phase independently with complete_phase when its steps finish\n- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped\n\n**Knowledge capture:**\n- Call add_decision after any architectural or design choice that affects future phases\n- Call add_memory for reusable patterns, gotchas, or conventions discovered during execution${scSection}${dmSection}${selfImprovementSection}\n`
}

/**
 * Build self-improvement feedback section for the planner based on previous phase grade.
 *
 * Pulls the corrective step (if any) from the in-memory cache populated by
 * complete_phase. The cache may be empty either because the previous grade was
 * not D/F or because the judge call hasn't completed yet — both fine, the
 * suggestion is best-effort.
 */
function buildSelfImprovementSection(ferment: Ferment): string {
	const completedPhases = ferment.phases.filter((p) => p.status === "completed" && p.grade)
	if (completedPhases.length === 0) return ""

	const lastGradedPhase = completedPhases[completedPhases.length - 1]
	if (!lastGradedPhase.grade) return ""

	const grade = lastGradedPhase.grade
	const feedback = evaluatePhaseFeedback(grade)
	const correctiveStep = getCorrectiveStep(ferment.id, lastGradedPhase.id)
	return renderSelfImprovementSection(grade, feedback, correctiveStep)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI) {
	// ─── Resume helper ───────────────────────────────────────────────────────
	// Shared by session_start (env-var path) and the /ferment Continue picker.
	// Flips paused→running, validates worktree, re-arms the scoping gate for
	// drafts, and fires an imperative resume nudge so the planner picks up
	// the work without acknowledging. Does NOT mount the dashboard widget —
	// that only appears when the user explicitly runs /progress.
	function resumeFerment(fermentId: string, ctx: ExtensionContext): void {
		const storage = getStorage()
		let existing = storage.get(fermentId)
		if (!existing) {
			setActive(undefined)
			return
		}

		// Session_shutdown sets running ferments to "paused" — flip back to
		// "running" on resume so the engine produces a real next-action nudge.
		if (existing.status === "paused") {
			const out = applyAndPersist(existing.id, { type: "resume" })
			if (out.ok) existing = out.ferment
		}

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

		// Re-arm scoping gate on resume: if the ferment is still in draft and the
		// session has a TUI, the user must confirm again before scope_ferment is
		// allowed. Without this, the gate is silently bypassed on resume.
		if (existing.status === "draft" && ctx?.hasUI) {
			markScopingInteractive(existing.id)
		}

		// Resume nudge → hidden from user, triggers LLM to continue.
		// Wrap the engine's next-action message in an imperative resume preamble
		// so the model knows this isn't a status report — it's a directive to
		// pick up where the previous session left off, NOW, without acknowledging.
		const action = determineNextAction(existing)
		const baseMsg = `${action.kind}: ${action.reason}`
		const scopeProgress = getScopingProgress(existing)
		const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] ${existing.mode} mode · scoping ${scopeProgress.answered}/${scopeProgress.total}`

		const imperative =
			existing.status === "running"
				? `RESUMING ferment "${existing.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n${baseMsg}`
				: baseMsg

		pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
		void pi.sendMessage(
			{
				customType: "ferment_resume_nudge",
				content: [{ type: "text", text: imperative }],
				display: false,
				details: undefined,
			},
			{ triggerTurn: true },
		)
	}

	// ─── Session start: rehydrate from prior session ──────────────────────────
	// Skip entirely in subagent processes — KIMCHI_ACTIVE_FERMENT leaks into the
	// child env but the subagent has its own prompt and must not inject a resume
	// nudge (which would race with the agent startup and cause "already processing").
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.KIMCHI_SUBAGENT === "1") return
		clearAllStepStarts()
		clearAllScopingGates()
		clearAllPendingScopes()
		// Clear in-memory ferment cache — fresh session reads from disk once,
		// then serves subsequent reads from cache until next mutation.
		clearFermentCache()

		// Resume only via the explicit env var KIMCHI_ACTIVE_FERMENT — set when a
		// ferment is started in the current process tree (e.g. inherited by a
		// subagent child). We deliberately do NOT auto-resume from session entries
		// or storage scans: opening kimchi gives a clean session, and the user
		// picks a ferment to continue via /ferment or /ferment switch.
		const envId = process.env.KIMCHI_ACTIVE_FERMENT
		if (envId) {
			resumeFerment(envId, ctx)
		} else {
			setActive(undefined)
		}
	})

	// ─── Session shutdown: mark any running ferment as paused ─────────────────
	// Prevents ferments from being stuck in "running" after the user exits or
	// interrupts the harness. Subagents exit naturally and should not touch state.
	pi.on("session_shutdown", async () => {
		if (process.env.KIMCHI_SUBAGENT === "1") return
		const f = getActive()
		if (!f) return
		if (f.status === "running" || f.status === "planned") {
			applyAndPersist(f.id, { type: "pause" })
		}
	})

	// ─── Track last human input time ──────────────────────────────────────────
	pi.on("input", async (event) => {
		if (event.source === "interactive") {
			markHumanInput()
		}
	})

	// ─── Planner system prompt injection ──────────────────────────────────────
	// When a ferment is running, tell the session model it is the planner:
	// its job is to manage the state machine and delegate implementation to
	// subagent workers — never to write code itself.
	// When the ferment is paused, inject a clear stop directive instead. The
	// state machine refuses ferment tool calls in this state regardless, but
	// telling the planner up front avoids a turn full of failed attempts.
	pi.on("before_agent_start", async (event) => {
		const f = getActive()
		if (!f) return {}
		if (f.status === "paused") {
			const pausedSupplement = `\n\n## Ferment Paused\n\nFerment "${f.name}" is paused by the user. Do NOT call any ferment tools (activate_phase, start_step, complete_step, etc.) — they will be rejected. Acknowledge any pending question briefly and wait for the user to resume with /auto.`
			return { systemPrompt: `${event.systemPrompt}${pausedSupplement}` }
		}
		if (f.status !== "running") return {}
		const supplement = buildPlannerSupplement()
		return { systemPrompt: `${event.systemPrompt}${supplement}` }
	})

	// ─── Block model switching during ferment execution ───────────────────────
	// model_select has no cancel mechanism — restore the previous model instead.
	// `restoringModel` flag prevents the pi.setModel call from re-entering.
	pi.on("model_select", async (event, ctx) => {
		captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		const f = getActive()
		if (!f || f.status !== "running") return
		if (isRestoringModel()) return

		if (event.previousModel) {
			setRestoringModel(true)
			pi.setModel(event.previousModel)
				.catch(() => {})
				.finally(() => {
					setRestoringModel(false)
				})
		}
		ctx.ui.notify(
			`Model switching is locked while ferment "${f.name}" is running. Finish or abandon the ferment first.`,
			"warning",
		)
	})

	// ─── Yes/no question intercept ────────────────────────────────────────────
	// In plan mode the LLM asks yes/no questions after each scoping field and
	// before each step. Show a TUI dropdown instead of waiting for free-text
	// input. Fires for draft AND running status in plan mode; never in exec.
	pi.on("turn_end", async (event, ctx) => {
		captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		const f = getActive()
		if (!f) return
		if (f.mode === "exec") return
		// Only intercept during scoping (draft) or plan-mode confirmation gates (running)
		if (f.status !== "draft" && f.status !== "running") return
		if (!ctx?.ui?.select || !ctx?.ui?.input) return
		if (event.message.role !== "assistant") return

		// Only inspect text after the final tool call. Text before or between tool
		// calls can be mid-execution narration; trailing text is the user-facing
		// prompt that needs the dropdown.
		if (hasToolCall(event.message.content, "propose_phases")) return
		const text = extractPromptTextAfterLastToolCall(event.message.content)
		if (!text) return

		const isDraft = f.status === "draft"
		const yesLabel = isDraft ? "Yes, this looks right" : "Yes, proceed"
		const noLabel = isDraft ? "No, revise" : "No, pause"

		// Extract just the final question rather than dumping the last 200 chars
		// of the message. The full text is already rendered above the dialog —
		// the dialog title should be the question itself, nothing more.
		const title = extractTrailingQuestion(text)
		const contextualOptions = extractContextualOptions(text)
		if (!text.endsWith("?") && !contextualOptions) return
		const options = contextualOptions
			? [...contextualOptions, "Let me say something else"]
			: [yesLabel, noLabel, "Let me say something else"]
		const choice = await ctx.ui.select(title, options)
		if (!choice) return

		let reply: string

		if (choice === "Let me say something else") {
			const custom = ctx.ui.input ? await ctx.ui.input("Your message:", "") : undefined
			if (!custom) return
			reply = custom
		} else if (choice === noLabel) {
			reply = isDraft ? "No — please revise." : "No, pause for now."
		} else if (contextualOptions?.includes(choice)) {
			// User selected a contextual option — pass it through verbatim
			reply = choice
		} else if (isDraft && choice === yesLabel) {
			// User confirmed during scoping. If the LLM stashed a structured
			// proposal via propose_phases, apply it deterministically here —
			// no further LLM round-trip needed. The user confirmed what they
			// read on screen; we save EXACTLY that, not whatever the LLM might
			// re-imagine in a follow-up turn.
			const pending = getPendingScope(f.id)
			if (pending?.phases && pending.phases.length > 0) {
				markScopingConfirmed(f.id) // unlock the scope_ferment gate (still required by the gate)
				const outcome = applyAndPersist(f.id, {
					type: "scope",
					title: f.name,
					goal: pending.goal,
					successCriteria: pending.successCriteria,
					constraints: pending.constraints,
					phases: pending.phases,
				})
				if (!outcome.ok) {
					ctx.ui.notify(`Failed to save plan: ${outcome.error.message}`)
					reply = `Plan save failed: ${outcome.error.message}. Investigate the ferment state and try again.`
				} else {
					clearPendingScope(f.id)
					ctx.ui.notify(`Plan saved for "${outcome.ferment.name}". ${outcome.ferment.phases.length} phase(s) ready.`)
					reply = `Plan saved by user confirmation — ${outcome.ferment.phases.length} phase(s) now in "planned" status. You can proceed with activate_phase when the user is ready, or wait for further instructions.`
				}
			} else {
				// No pending phases — LLM forgot to call propose_phases, or this
				// turn's "?" wasn't actually the scoping confirmation. Ask the LLM
				// to retry via the tool so the user's confirmation has something to save.
				reply =
					"User confirmed the plan but you never called propose_phases — there's nothing structured for the host to save. Call propose_phases now with the same plan you just showed, then end with 'Does this plan look right?' so the user can confirm again."
			}
		} else {
			reply = "Yes, proceed."
		}

		markHumanInput()
		// Queue as followUp — the previous turn (which produced the "?" question)
		// may still be finalizing when this fires, and a bare sendUserMessage
		// would error with "Agent is already processing".
		void pi.sendUserMessage(reply, { deliverAs: "followUp" })
	})

	// ─── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("ferment", {
		description: 'Manage ferments: /ferment list, /ferment add "Name", /ferment one-shot "task", /ferment switch <id>',
		async handler(args, ctx) {
			const raw = args.trim()
			const command = parseFermentCommand(args)
			const storage = getStorage()

			/* ── /ferment  (no args) → interactive prompt ── */
			if (command.type === "interactive") {
				const active = getActive()
				if (active && active.status === "running") {
					ctx.ui.notify(
						`A ferment is already running: "${active.name}". Use /progress to check status or /ferment switch to change.`,
					)
					return
				}
				if (!ctx.ui.input) {
					ctx.ui.notify('No UI available. Use /ferment add "Name" instead.')
					return
				}

				// First-run onboarding: shown only once per user (flag persisted at
				// ~/.config/kimchi/onboarding.json). No-op for returning users.
				await maybeRunOnboarding(ctx)

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
			if (command.type === "list") {
				const items = storage.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				if (items.length === 0) {
					ctx.ui.notify("No ferments. Use /ferment to start one.")
					return
				}

				const activeId = getActiveId()
				if (!ctx.hasUI) {
					const lines = items.map((f) => {
						const marker = f.id === activeId ? "▶" : "○"
						return `${marker}  ${f.name}  [${f.status}]  ${f.phaseCount} phase(s)  ${f.id.slice(0, 8)}…`
					})
					ctx.ui.notify(lines.join("\n"))
					return
				}

				// ── Step 1: pick a ferment ──
				const listTitle = `${pr_teal("🍺")} ${pr_bold("Ferments")}  ${pr_dim(`(${items.length})`)}\n\n${pr_dim("Select a ferment:")}`
				const listOpts = items.map((f) => {
					const isActive = f.id === activeId
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
				const isActiveSelected = selected.id === activeId
				const subTitle = `${pr_teal("🍺")} ${pr_bold(selected.name)}\n${selected.description && selected.description !== selected.name ? `${pr_dim(selected.description.slice(0, 80))}${selected.description.length > 80 ? pr_dim("…") : ""}\n` : ""}${pr_dim("Status:")} ${selected.status}  ${pr_dim("Phases:")} ${selected.phaseCount}${isActiveSelected ? `  ${pr_teal("← currently active")}` : ""}`

				const actionContinue = isActiveSelected ? "Continue (already active)" : "Continue"
				const subOpts = [actionContinue, "Delete", "Back"]
				const action = await ctx.ui.select(subTitle, subOpts)
				if (!action || action === "Back") return

				if (action === actionContinue) {
					if (!isActiveSelected) {
						// Full resume: flips paused→running, mounts widget, fires imperative nudge.
						resumeFerment(selected.id, ctx)
						ctx.ui.notify(`Resumed "${selected.name}"`)
					}
					return
				}

				if (action === "Delete") {
					storage.delete(selected.id)
					clearFermentState(selected.id)
					clearPendingScope(selected.id)
					if (getActiveId() === selected.id) setActive(undefined)
					ctx.ui.notify(`Deleted "${selected.name}"`)
					return
				}
				return
			}

			/* ── /ferment mode ── */
			if (command.type === "mode") {
				const modeArg = command.mode ?? ""
				const active = getActive()
				if (!modeArg) {
					if (!active) {
						ctx.ui.notify("No active ferment. Use /ferment add or /ferment switch first.")
						return
					}
					const lines = [
						`Ferment: ${active.name} (${active.id})`,
						`Mode: ${active.mode}`,
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

				if (!active) {
					ctx.ui.notify("No active ferment.")
					return
				}

				// Block exec/auto mode change if scoping is not complete
				if ((modeArg === "exec" || modeArg === "auto") && active.status === "draft") {
					const progress = getScopingProgress(active)
					if (progress.answered < progress.total) {
						ctx.ui.notify(
							`Cannot switch to ${modeArg} mode: scoping is ${progress.answered}/${progress.total} complete. Finish scoping in plan mode first.`,
						)
						return
					}
				}

				const out = applyAndPersist(active.id, { type: "set_mode", mode: modeArg as FermentWorkMode })
				const updated = out.ok ? out.ferment : undefined
				if (updated) {
					setActive(updated)
					let hint = ""
					if (modeArg === "exec") hint = "\n\n⚡  exec mode — the agent now has full tool access."
					else if (modeArg === "plan") hint = "\n\n📝  plan mode — the agent will ask questions and propose structure."
					else if (modeArg === "auto") hint = "\n\n🔄  auto mode — the agent will guide you through each step."
					ctx.ui.notify(`Mode changed to: ${modeArg}.${hint}`)

					const action = determineNextAction(updated)
					const nudge = `${action.kind}: ${action.reason}`
					if (nudge) {
						pi.appendEntry("ferment_breadcrumb", {
							text: `Mode changed to ${modeArg}: "${updated.name}" [${updated.status}]`,
						})
						void pi.sendMessage(
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
			if (command.type === "delete") {
				const target = command.target
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
					clearFermentState(f.id)
					clearPendingScope(f.id)
					if (getActiveId() === f.id) setActive(undefined)
					ctx.ui.notify(`Deleted "${f.name}" (${f.id}).`)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Delete failed.")
				}
				return
			}

			/* ── /ferment switch | use | resume ... ── */
			if (command.type === "switch") {
				const target = command.target
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

					const wtCheck = checkWorktree(f)
					if (wtCheck.severity === "block" && !command.force) {
						ctx.ui.notify(`${wtCheck.message}\n\nUse /ferment switch --force "${target}" to override.`)
						return
					}

					const wtWarning = wtCheck.severity === "warn" ? `\n⚠️  ${wtCheck.message}` : ""
					ctx.ui.notify(`Switched to "${f.name}" (${f.id}) [${f.status}].${wtWarning}`)
					// Full resume: flips paused→running, mounts widget, fires imperative nudge.
					resumeFerment(f.id, ctx)
				} catch (err) {
					ctx.ui.notify(err instanceof FermentError ? err.message : "Switch failed.")
				}
				return
			}

			/* ── /ferment abandon ── */
			if (command.type === "abandon") {
				const active = getActive()
				if (!active) {
					ctx.ui.notify("No active ferment.")
					return
				}
				const reason = command.reason ?? ""
				if (ctx.ui.select) {
					const choice = await ctx.ui.select(`Abandon "${active.name}"?`, ["Yes, abandon it", "No, keep it"])
					if (!choice || !choice.startsWith("Yes")) {
						ctx.ui.notify("Abandon cancelled.")
						return
					}
				}
				const abandonedId = active.id
				const out = applyAndPersist(abandonedId, { type: "abandon", reason: reason || undefined })
				if (out.ok) {
					setActive(undefined)
					clearFermentState(abandonedId)
					clearPendingScope(abandonedId)
					ctx.ui.notify(`Ferment "${out.ferment.name}" abandoned.`)
				}
				return
			}

			/* ── /ferment revise <field> ── */
			if (command.type === "revise") {
				const active = getActive()
				if (!active) {
					ctx.ui.notify("No active ferment.")
					return
				}
				const field = command.field

				if (field === "goal") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision. Ask the agent to update the goal.")
						return
					}
					const newGoal = await ctx.ui.input("Revise goal:", active.goal ?? "")
					if (newGoal) {
						const out = applyAndPersist(active.id, { type: "update_scope_field", field: "goal", value: newGoal })
						if (out.ok) {
							setActive(out.ferment)
							ctx.ui.notify(`Goal updated: "${newGoal}"`)
						} else {
							ctx.ui.notify(`Could not update goal: ${out.error.message}`)
						}
					}
					return
				}

				if (field === "criteria") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision.")
						return
					}
					const newCriteria = await ctx.ui.input("Revise success criteria:", active.successCriteria ?? "")
					if (newCriteria) {
						const out = applyAndPersist(active.id, {
							type: "update_scope_field",
							field: "criteria",
							value: newCriteria,
						})
						if (out.ok) {
							setActive(out.ferment)
							ctx.ui.notify("Success criteria updated.")
						} else {
							ctx.ui.notify(`Could not update criteria: ${out.error.message}`)
						}
					}
					return
				}

				if (field === "constraints") {
					if (!ctx.ui.input) {
						ctx.ui.notify("No UI available for interactive revision.")
						return
					}
					const current = (active.constraints ?? []).join(", ")
					const newConstraints = await ctx.ui.input("Revise constraints (comma-separated):", current)
					if (newConstraints !== null && newConstraints !== undefined) {
						const parsed = newConstraints
							.split(",")
							.map((c) => c.trim())
							.filter(Boolean)
						const out = applyAndPersist(active.id, {
							type: "update_scope_field",
							field: "constraints",
							value: parsed.join(","),
						})
						if (out.ok) {
							setActive(out.ferment)
							ctx.ui.notify(`Constraints updated: ${parsed.join(", ") || "(none)"}`)
						} else {
							ctx.ui.notify(`Could not update constraints: ${out.error.message}`)
						}
					}
					return
				}

				ctx.ui.notify(
					"Usage: /ferment revise goal | criteria | constraints\n\nTo revise phases, ask the agent to update them.",
				)
				return
			}

			/* ── /ferment export ── */
			if (command.type === "export") {
				const active = getActive()
				if (!active) {
					ctx.ui.notify("No active ferment.")
					return
				}
				const stats = computeStats(active)
				const exportData = serializeStats(stats)
				const fileName = `ferment-export-${active.id.slice(0, 8)}-${Date.now()}.json`
				writeFileSync(fileName, exportData)
				ctx.ui.notify(`Exported ferment stats to ${fileName}`)
				return
			}

			/* ── /ferment one-shot <description> ── */
			if (command.type === "one-shot") {
				const active = getActive()
				if (active && active.status === "running") {
					ctx.ui.notify(`A ferment is already running: "${active.name}". Use /progress to check status.`)
					return
				}
				const intent = command.intent
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
					const modeOut = applyAndPersist(f.id, { type: "set_mode", mode: "exec" })
					const updated = modeOut.ok ? modeOut.ferment : f
					setActive(updated)
					appendRefEntry(pi, updated.id)
					pi.appendEntry("ferment_ack", {
						text: `🍺  One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nMode: exec (fully autonomous)`,
					})
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

					void pi.sendMessage(
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
			const active = getActive()
			if (active && active.status === "running") {
				ctx.ui.notify(
					`A ferment is already running: "${active.name}". Use /progress to check status or /ferment switch to change.`,
				)
				return
			}
			const rawName = command.type === "add" ? command.title : raw
			if (!rawName) {
				ctx.ui.notify('Usage: /ferment add "Name"')
				return
			}
			try {
				const shortName = await shortenTitle(rawName)
				const f = storage.create(shortName, rawName)
				setActive(f)
				appendRefEntry(pi, f.id)

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
		description: "Resume — flip a paused ferment back to running and re-engage the planner.",
		async handler(_, ctx) {
			setAutoModeEnabled(true)
			const active = getActive()
			if (!active) {
				ctx.ui.notify("Auto-mode enabled. (No active ferment.)")
				return
			}
			// If the ferment is paused, transition via the state machine.
			if (active.status === "paused") {
				const outcome = applyAndPersist(active.id, { type: "resume" })
				if (!outcome.ok) {
					ctx.ui.notify(`Cannot resume: ${outcome.error.message}`)
					return
				}
			}

			// State-machine-first resume: if the engine's next action is a state
			// transition the host can perform without LLM judgment (start_step,
			// activate_phase), apply it directly. The planner is then nudged with
			// a much narrower ask: "the step is running, spawn a subagent" rather
			// than "decide what to do next". This removes the failure mode where
			// the planner stalls on a "Ready to execute?" question that the
			// engine's plan-mode prose suggests.
			const fresh = getActive() ?? active
			const action = determineNextAction(fresh)
			let preflightSummary = ""

			if (action.kind === "start_step") {
				const activePhase = fresh.phases.find((p) => p.id === fresh.activePhaseId)
				if (activePhase) {
					const stepOutcome = applyAndPersist(fresh.id, {
						type: "start_step",
						phaseId: activePhase.id,
						stepId: action.stepId,
					})
					if (stepOutcome.ok) {
						const startedStep = stepOutcome.ferment.phases
							.find((p) => p.id === activePhase.id)
							?.steps.find((s) => s.id === action.stepId)
						preflightSummary = startedStep
							? `Step ${startedStep.index} "${startedStep.description}" advanced to running by host on /auto.`
							: ""
					}
					// On failure (e.g. step already running, stuck-loop guard),
					// just skip preflight and let maybeInjectAutoNudge nudge anyway.
				}
			} else if (action.kind === "activate_phase") {
				const phaseOutcome = applyAndPersist(fresh.id, {
					type: "activate_phase",
					phaseId: action.phaseId,
				})
				if (phaseOutcome.ok) {
					const activated = phaseOutcome.ferment.phases.find((p) => p.id === action.phaseId)
					preflightSummary = activated ? `Phase ${activated.index} "${activated.name}" activated by host on /auto.` : ""
				}
			}

			if (preflightSummary) {
				pi.appendEntry("ferment_breadcrumb", { text: `Resume preflight: ${preflightSummary}` })
			}

			ctx.ui.notify(`Resumed "${active.name}".`)
			// force: true — bypass the routine-step filter so the planner gets a
			// kick regardless of the next-action kind. Without this, resuming
			// onto an in-flight `start_step` action would silently emit no nudge.
			maybeInjectAutoNudge(pi, { force: true })
		},
	})

	pi.registerCommand("pause", {
		description:
			"Pause the active ferment — flips status to 'paused'; the state machine then refuses every ferment tool call until /auto.",
		async handler(_, ctx) {
			setAutoModeEnabled(false)

			const active = getActive()
			if (!active) {
				ctx.ui.notify("No active ferment to pause.")
				return
			}

			// Pause is a state machine transition. Once status flips to 'paused',
			// applyAndPersist refuses every command except resume/abandon — so
			// any in-flight or queued tool call from the planner will fail with
			// a clear FERMENT_PAUSED error. No prompt-based steering needed.
			if (active.status === "running" || active.status === "planned") {
				const outcome = applyAndPersist(active.id, { type: "pause" })
				if (!outcome.ok) {
					ctx.ui.notify(`Cannot pause: ${outcome.error.message}`)
					return
				}
			} else if (active.status !== "paused") {
				ctx.ui.notify(`Ferment is "${active.status}" — nothing to pause.`)
				return
			}

			ctx.ui.notify(`Ferment "${active.name}" paused. Type /auto to resume.`)
		},
	})

	pi.registerCommand("progress", {
		description: "Ferment overlay: phase/step navigator with grades.",
		async handler(_, ctx) {
			const active = getActive()
			if (!active) {
				ctx.ui.notify("No active ferment. Start one with /ferment.")
				return
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(formatFermentStatus(active))
				return
			}

			// ── Layer 1: phase list ──────────────────────────────────────────────
			let atPhaseList = true
			while (atPhaseList) {
				const f = getStorage().get(active.id) ?? active
				const phaseListOpts = buildPhaseListOptions(f)
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
						const outcome = applyAndPersist(f.id, { type: "abandon" })
						if (outcome.ok) setActive(undefined)
						clearFermentState(f.id)
						clearPendingScope(f.id)
						atPhaseList = false
					}
					continue
				}

				const l1idx = phaseListOpts.indexOf(l1choice)
				if (l1idx < 0 || l1idx >= phaseListPhaseCount) continue
				const selectedPhaseIndex = f.phases[l1idx].index

				// ── Layer 2: step list for phase ───────────────────────────────
				let atStepList = true
				while (atStepList) {
					const f2 = getStorage().get(f.id) ?? f
					const ph = f2.phases.find((p) => p.index === selectedPhaseIndex)
					if (!ph) {
						atStepList = false
						break
					}

					const stepOpts = buildPhaseStepOptions(ph)
					const stepCount = ph.steps.length

					const l2choice = await ctx.ui.select(buildPhaseDetailTitle(f2, ph), stepOpts)

					if (!l2choice || l2choice === "Back") {
						atStepList = false
						break
					}

					if (l2choice === "Phase actions") {
						let atPhaseActions = true
						while (atPhaseActions) {
							const f3 = getStorage().get(f.id) ?? f
							const ph3 = f3.phases.find((p) => p.index === selectedPhaseIndex)
							if (!ph3) {
								atPhaseActions = false
								break
							}
							const actionChoice = await ctx.ui.select(buildPhaseDetailTitle(f3, ph3), buildPhaseActionOptions(f3, ph3))
							if (!actionChoice || actionChoice === "Back to steps") {
								atPhaseActions = false
								break
							}
							await handlePhaseAction(actionChoice, f3, ph3, ctx)
						}
						continue
					}

					const l2idx = stepOpts.indexOf(l2choice)
					if (l2idx < 0 || l2idx >= stepCount) continue
					const selectedStepIndex = ph.steps[l2idx].index

					// ── Layer 3: step detail ───────────────────────────────────
					let atStepDetail = true
					while (atStepDetail) {
						const f3 = getStorage().get(f.id) ?? f
						const ph3 = f3.phases.find((p) => p.index === selectedPhaseIndex)
						if (!ph3) {
							atStepDetail = false
							break
						}
						const st = ph3.steps.find((s) => s.index === selectedStepIndex)
						if (!st) {
							atStepDetail = false
							break
						}

						const stepActionOpts = buildStepActionOptions(ph3, st)
						const l3choice = await ctx.ui.select(buildStepDetailTitle(ph3, st), stepActionOpts)

						if (!l3choice || l3choice === "Back to phase") {
							atStepDetail = false
							break
						}
						await handleStepAction(l3choice, f3, ph3, st, ctx)
					}
				}
			}

			// Dialog closed — nothing to unmount; we never mounted in this flow.
			// Widget stays hidden until the next /progress invocation.
		},
	})

	// ─── Tool registrations ───────────────────────────────────────────────────
	registerLifecycleTools(pi)
	registerPhaseTools(pi)
	registerStepTools(pi)
	registerKnowledgeTools(pi)
}

// Suppress "isScopingInteractive imported but unused" — kept for future tooling.
void isScopingInteractive
