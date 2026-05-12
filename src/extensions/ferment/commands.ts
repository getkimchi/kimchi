import { writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction, getScopingProgress } from "../../ferment/engine.js"
import { shortenTitle } from "../../ferment/shorten-title.js"
import { computeStats, serializeStats } from "../../ferment/stats.js"
import { FermentError } from "../../ferment/store.js"
import type { FermentWorkMode } from "../../ferment/types.js"
import { pr_bold, pr_dim, pr_orange, pr_success, pr_teal } from "./colors.js"
import { type FermentCommand, parseFermentCommand } from "./command-parser.js"
import { formatFermentStatus } from "./format.js"
import { appendRefEntry, maybeInjectAutoNudge } from "./nudge.js"
import { maybeRunOnboarding } from "./onboarding.js"
import { buildOneshotNudge } from "./oneshot.js"
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
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { runScopingFlow } from "./scoping.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { setActiveFerment, syncFermentToolScope } from "./tool-scope.js"
import type { FermentUiContext } from "./ui.js"
import { checkWorktree } from "./worktree.js"

export type FermentCliCommand = FermentCommand

export interface FermentCommandDeps {
	raw: string
	pi: ExtensionAPI
	ctx: FermentUiContext & ExtensionCommandContext
	runtime: FermentRuntime
}

export interface FermentCommandResult {
	handled: true
}

export class FermentCommandController {
	async execute(command: FermentCliCommand, deps: FermentCommandDeps): Promise<FermentCommandResult> {
		const { raw, pi, ctx, runtime } = deps
		const applyAndPersist = createApplyAndPersist(runtime)
		const storage = runtime.getStorage()

		if (command.type === "interactive") {
			const active = runtime.getActive()
			if (active && active.status === "running") {
				ctx.ui.notify(
					`A ferment is already running: "${active.name}". Use /progress to check status or /ferment switch to change.`,
				)
				return { handled: true }
			}
			if (!ctx.ui.input) {
				ctx.ui.notify('No UI available. Use /ferment add "Name" instead.')
				return { handled: true }
			}

			await maybeRunOnboarding(ctx)

			const rawIntent = await ctx.ui.input(
				"🍺  What would you like to ferment?",
				"e.g. 'Rewrite login flow' or 'Add OAuth support'",
			)
			if (!rawIntent) return { handled: true }
			try {
				const shortName = await shortenTitle(rawIntent)
				const f = storage.create(shortName, rawIntent)
				setActiveFerment(pi, runtime, f)
				appendRefEntry(pi, f.id)

				pi.appendEntry("ferment_ack", {
					text: `🍺  Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nMode: ${f.mode} · scoping 0/4`,
				})

				await runScopingFlow(f, pi, ctx, runtime)
			} catch (err) {
				ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
			}
			return { handled: true }
		}

		if (command.type === "list") {
			const items = storage.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			if (items.length === 0) {
				ctx.ui.notify("No ferments. Use /ferment to start one.")
				return { handled: true }
			}

			const activeId = runtime.getActiveId()
			if (!ctx.hasUI) {
				const lines = items.map((f) => {
					const marker = f.id === activeId ? "▶" : "○"
					return `${marker}  ${f.name}  [${f.status}]  ${f.phaseCount} phase(s)  ${f.id.slice(0, 8)}…`
				})
				ctx.ui.notify(lines.join("\n"))
				return { handled: true }
			}

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
			if (!listChoice || listChoice === pr_dim("Close")) return { handled: true }

			const listIdx = listOpts.indexOf(listChoice)
			const selected = listIdx >= 0 && listIdx < items.length ? items[listIdx] : undefined
			if (!selected) return { handled: true }

			const isActiveSelected = selected.id === activeId
			const subTitle = `${pr_teal("🍺")} ${pr_bold(selected.name)}\n${selected.description && selected.description !== selected.name ? `${pr_dim(selected.description.slice(0, 80))}${selected.description.length > 80 ? pr_dim("…") : ""}\n` : ""}${pr_dim("Status:")} ${selected.status}  ${pr_dim("Phases:")} ${selected.phaseCount}${isActiveSelected ? `  ${pr_teal("← currently active")}` : ""}`

			const actionContinue = isActiveSelected ? "Continue (already active)" : "Continue"
			const subOpts = [actionContinue, "Delete", "Back"]
			const action = await ctx.ui.select(subTitle, subOpts)
			if (!action || action === "Back") return { handled: true }

			if (action === actionContinue) {
				if (!isActiveSelected) {
					resumeFerment(pi, selected.id, ctx, runtime)
					ctx.ui.notify(`Resumed "${selected.name}"`)
				}
				return { handled: true }
			}

			if (action === "Delete") {
				storage.delete(selected.id)
				runtime.clearFermentState(selected.id)
				runtime.clearPendingScope(selected.id)
				if (runtime.getActiveId() === selected.id) setActiveFerment(pi, runtime, undefined)
				ctx.ui.notify(`Deleted "${selected.name}"`)
				return { handled: true }
			}
			return { handled: true }
		}

		if (command.type === "mode") {
			const modeArg = command.mode ?? ""
			const active = runtime.getActive()
			if (!modeArg) {
				if (!active) {
					ctx.ui.notify("No active ferment. Use /ferment add or /ferment switch first.")
					return { handled: true }
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
				return { handled: true }
			}

			if (!["plan", "exec", "auto"].includes(modeArg)) {
				ctx.ui.notify("Usage: /ferment mode plan | exec | auto")
				return { handled: true }
			}

			if (!active) {
				ctx.ui.notify("No active ferment.")
				return { handled: true }
			}

			if ((modeArg === "exec" || modeArg === "auto") && active.status === "draft") {
				const progress = getScopingProgress(active)
				if (progress.answered < progress.total) {
					ctx.ui.notify(
						`Cannot switch to ${modeArg} mode: scoping is ${progress.answered}/${progress.total} complete. Finish scoping in plan mode first.`,
					)
					return { handled: true }
				}
			}

			const out = applyAndPersist(active.id, { type: "set_mode", mode: modeArg as FermentWorkMode })
			const updated = out.ok ? out.ferment : undefined
			if (updated) {
				setActiveFerment(pi, runtime, updated)
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
			return { handled: true }
		}

		if (command.type === "delete") {
			const target = command.target
			if (!target) {
				ctx.ui.notify('Usage: /ferment delete <full-id> or /ferment delete "Name"')
				return { handled: true }
			}
			try {
				const f = storage.resolve(target)
				if (!f) {
					ctx.ui.notify(`No ferment matching "${target}".`)
					return { handled: true }
				}
				storage.delete(f.id)
				runtime.clearFermentState(f.id)
				runtime.clearPendingScope(f.id)
				if (runtime.getActiveId() === f.id) {
					setActiveFerment(pi, runtime, undefined)
				}
				ctx.ui.notify(`Deleted "${f.name}" (${f.id}).`)
			} catch (err) {
				ctx.ui.notify(err instanceof FermentError ? err.message : "Delete failed.")
			}
			return { handled: true }
		}

		if (command.type === "switch") {
			const target = command.target
			if (!target) {
				ctx.ui.notify('Usage: /ferment switch <full-id> or /ferment switch "Name"')
				return { handled: true }
			}
			try {
				const f = storage.resolve(target)
				if (!f) {
					ctx.ui.notify(`No ferment matching "${target}".`)
					return { handled: true }
				}

				const wtCheck = checkWorktree(f)
				if (wtCheck.severity === "block" && !command.force) {
					ctx.ui.notify(`${wtCheck.message}\n\nUse /ferment switch --force "${target}" to override.`)
					return { handled: true }
				}

				const wtWarning = wtCheck.severity === "warn" ? `\n⚠️  ${wtCheck.message}` : ""
				ctx.ui.notify(`Switched to "${f.name}" (${f.id}) [${f.status}].${wtWarning}`)
				resumeFerment(pi, f.id, ctx, runtime)
			} catch (err) {
				ctx.ui.notify(err instanceof FermentError ? err.message : "Switch failed.")
			}
			return { handled: true }
		}

		if (command.type === "abandon") {
			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("No active ferment.")
				return { handled: true }
			}
			const reason = command.reason ?? ""
			if (ctx.ui.select) {
				const choice = await ctx.ui.select(`Abandon "${active.name}"?`, ["Yes, abandon it", "No, keep it"])
				if (!choice || !choice.startsWith("Yes")) {
					ctx.ui.notify("Abandon cancelled.")
					return { handled: true }
				}
			}
			const abandonedId = active.id
			const out = applyAndPersist(abandonedId, { type: "abandon", reason: reason || undefined })
			if (out.ok) {
				setActiveFerment(pi, runtime, undefined)
				runtime.clearFermentState(abandonedId)
				runtime.clearPendingScope(abandonedId)
				ctx.ui.notify(`Ferment "${out.ferment.name}" abandoned.`)
			}
			return { handled: true }
		}

		if (command.type === "revise") {
			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("No active ferment.")
				return { handled: true }
			}
			const field = command.field

			if (field === "goal") {
				if (!ctx.ui.input) {
					ctx.ui.notify("No UI available for interactive revision. Ask the agent to update the goal.")
					return { handled: true }
				}
				const newGoal = await ctx.ui.input("Revise goal:", active.goal ?? "")
				if (newGoal) {
					const out = applyAndPersist(active.id, { type: "update_scope_field", field: "goal", value: newGoal })
					if (out.ok) {
						setActiveFerment(pi, runtime, out.ferment)
						ctx.ui.notify(`Goal updated: "${newGoal}"`)
					} else {
						ctx.ui.notify(`Could not update goal: ${out.error.message}`)
					}
				}
				return { handled: true }
			}

			if (field === "criteria") {
				if (!ctx.ui.input) {
					ctx.ui.notify("No UI available for interactive revision.")
					return { handled: true }
				}
				const newCriteria = await ctx.ui.input("Revise success criteria:", active.successCriteria ?? "")
				if (newCriteria) {
					const out = applyAndPersist(active.id, {
						type: "update_scope_field",
						field: "criteria",
						value: newCriteria,
					})
					if (out.ok) {
						setActiveFerment(pi, runtime, out.ferment)
						ctx.ui.notify("Success criteria updated.")
					} else {
						ctx.ui.notify(`Could not update criteria: ${out.error.message}`)
					}
				}
				return { handled: true }
			}

			if (field === "constraints") {
				if (!ctx.ui.input) {
					ctx.ui.notify("No UI available for interactive revision.")
					return { handled: true }
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
						setActiveFerment(pi, runtime, out.ferment)
						ctx.ui.notify(`Constraints updated: ${parsed.join(", ") || "(none)"}`)
					} else {
						ctx.ui.notify(`Could not update constraints: ${out.error.message}`)
					}
				}
				return { handled: true }
			}

			ctx.ui.notify(
				"Usage: /ferment revise goal | criteria | constraints\n\nTo revise phases, ask the agent to update them.",
			)
			return { handled: true }
		}

		if (command.type === "export") {
			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("No active ferment.")
				return { handled: true }
			}
			const stats = computeStats(active)
			const exportData = serializeStats(stats)
			const fileName = `ferment-export-${active.id.slice(0, 8)}-${Date.now()}.json`
			try {
				writeFileSync(fileName, exportData)
				ctx.ui.notify(`Exported ferment stats to ${fileName}`)
			} catch (err) {
				ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
			}
			return { handled: true }
		}

		if (command.type === "one-shot") {
			const active = runtime.getActive()
			if (active && active.status === "running") {
				ctx.ui.notify(`A ferment is already running: "${active.name}". Use /progress to check status.`)
				return { handled: true }
			}
			const intent = command.intent
			let resolvedIntent = intent
			if (!resolvedIntent && ctx.ui.input) {
				const typed = await ctx.ui.input("🍺  One-shot: what should be done?", "Describe the full task…")
				if (!typed) return { handled: true }
				resolvedIntent = typed
			}
			if (!resolvedIntent) {
				ctx.ui.notify('Usage: /ferment one-shot "description of what to build"')
				return { handled: true }
			}
			try {
				const shortName = await shortenTitle(resolvedIntent)
				const f = storage.create(shortName, resolvedIntent)
				const modeOut = applyAndPersist(f.id, { type: "set_mode", mode: "exec" })
				const updated = modeOut.ok ? modeOut.ferment : f
				setActiveFerment(pi, runtime, updated)
				appendRefEntry(pi, updated.id)
				pi.appendEntry("ferment_ack", {
					text: `🍺  One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nMode: exec (fully autonomous)`,
				})
				const nudge = buildOneshotNudge(updated, resolvedIntent)

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
			return { handled: true }
		}

		const active = runtime.getActive()
		if (active && active.status === "running") {
			ctx.ui.notify(
				`A ferment is already running: "${active.name}". Use /progress to check status or /ferment switch to change.`,
			)
			return { handled: true }
		}
		const rawName = command.type === "add" ? command.title : raw
		if (!rawName) {
			ctx.ui.notify('Usage: /ferment add "Name"')
			return { handled: true }
		}
		try {
			const shortName = await shortenTitle(rawName)
			const f = storage.create(shortName, rawName)
			setActiveFerment(pi, runtime, f)
			appendRefEntry(pi, f.id)

			pi.appendEntry("ferment_ack", {
				text: `🍺  Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nMode: ${f.mode} · scoping 0/4`,
			})

			await runScopingFlow(f, pi, ctx, runtime)
		} catch (err) {
			ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
		}
		return { handled: true }
	}
}

export function registerFermentCommands(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const fermentCommandController = new FermentCommandController()

	pi.registerCommand("ferment", {
		description: 'Manage ferments: /ferment list, /ferment add "Name", /ferment one-shot "task", /ferment switch <id>',
		async handler(args, ctx) {
			const raw = args.trim()
			const command = parseFermentCommand(args)
			await fermentCommandController.execute(command, { raw, pi, ctx, runtime })
		},
	})

	pi.registerCommand("auto", {
		description: "Resume — flip a paused ferment back to running and re-engage the planner.",
		async handler(_, ctx) {
			runtime.setAutoModeEnabled(true)
			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("Auto-mode enabled. (No active ferment.)")
				syncFermentToolScope(pi, undefined)
				return
			}
			syncFermentToolScope(pi, active)
			if (active.status === "paused") {
				const outcome = applyAndPersist(active.id, { type: "resume" })
				if (!outcome.ok) {
					ctx.ui.notify(`Cannot resume: ${outcome.error.message}`)
					return
				}
				setActiveFerment(pi, runtime, outcome.ferment)
			}

			const fresh = runtime.getActive() ?? active
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
			maybeInjectAutoNudge(pi, { force: true }, runtime)
		},
	})

	pi.registerCommand("pause", {
		description:
			"Pause the active ferment — flips status to 'paused'; the state machine then refuses every ferment tool call until /auto.",
		async handler(_, ctx) {
			runtime.setAutoModeEnabled(false)

			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("No active ferment to pause.")
				return
			}

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
			syncFermentToolScope(pi, runtime.getActive())
		},
	})

	pi.registerCommand("progress", {
		description: "Ferment overlay: phase/step navigator with grades.",
		async handler(_, ctx) {
			const active = runtime.getActive()
			if (!active) {
				ctx.ui.notify("No active ferment. Start one with /ferment.")
				return
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(formatFermentStatus(active))
				return
			}

			let atPhaseList = true
			while (atPhaseList) {
				const f = runtime.getStorage().get(active.id) ?? active
				const phaseListOpts = buildPhaseListOptions(f)
				const phaseListPhaseCount = f.phases.length

				const l1choice = await ctx.ui.select(buildPhaseListTitle(f, runtime), phaseListOpts)

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
						if (outcome.ok) setActiveFerment(pi, runtime, undefined)
						runtime.clearFermentState(f.id)
						runtime.clearPendingScope(f.id)
						atPhaseList = false
					}
					continue
				}

				const l1idx = phaseListOpts.indexOf(l1choice)
				if (l1idx < 0 || l1idx >= phaseListPhaseCount) continue
				const selectedPhaseIndex = f.phases[l1idx].index

				let atStepList = true
				while (atStepList) {
					const f2 = runtime.getStorage().get(f.id) ?? f
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
							const f3 = runtime.getStorage().get(f.id) ?? f
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
							await handlePhaseAction(actionChoice, f3, ph3, ctx, runtime)
						}
						continue
					}

					const l2idx = stepOpts.indexOf(l2choice)
					if (l2idx < 0 || l2idx >= stepCount) continue
					const selectedStepIndex = ph.steps[l2idx].index

					let atStepDetail = true
					while (atStepDetail) {
						const f3 = runtime.getStorage().get(f.id) ?? f
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
						await handleStepAction(l3choice, f3, ph3, st, ctx, runtime)
					}
				}
			}
		},
	})
}
