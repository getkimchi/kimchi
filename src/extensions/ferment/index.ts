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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction, findFirstPlannedPhase, getScopingProgress, whatNext } from "../../ferment/engine.js"
import { shortenTitle } from "../../ferment/shorten-title.js"
import { computeStats, serializeStats } from "../../ferment/stats.js"
import { FermentError } from "../../ferment/store.js"
import type { FermentWorkMode, Step } from "../../ferment/types.js"
import { pr_bold, pr_dim, pr_orange, pr_success, pr_teal } from "./colors.js"
import { parseFermentCommand } from "./command-parser.js"
import { registerFermentEvents } from "./events.js"
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
import { resumeFerment } from "./resume.js"
import { clearPendingScope, runScopingFlow } from "./scoping.js"
import {
	clearFermentState,
	getActive,
	getActiveId,
	getStorage,
	isScopingInteractive,
	setActive,
	setAutoModeEnabled,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════════

export default function fermentExtension(pi: ExtensionAPI) {
	registerFermentEvents(pi)

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
						resumeFerment(pi, selected.id, ctx)
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
					resumeFerment(pi, f.id, ctx)
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
