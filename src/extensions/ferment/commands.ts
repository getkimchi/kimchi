import { writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { computeStats, serializeStats } from "../../ferment/stats.js"
import { FermentError } from "../../ferment/store.js"
import { successCriteriaToAnswer } from "../../ferment/success-criteria.js"
import { deriveDraftFermentTitle } from "../../ferment/title.js"
import { requestSharedFooterRender } from "../shared-footer.js"
import { pr_bold, pr_dim, pr_orange, pr_success, pr_teal } from "./colors.js"
import { type FermentCommand, parseFermentCommand } from "./command-parser.js"
import { decideContinuation } from "./continuation.js"
import { emitFermentCreated } from "./domain-events-emitter.js"
import { formatFermentStatus } from "./format.js"
import { autoInitFromEnv, ensureGitRepo } from "./git-init.js"
import { appendRefEntry, resetReactiveContinuationNudgeCount } from "./nudge.js"
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
import { promptEditor } from "./prompt-ui.js"
import { resumeFerment } from "./resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { runScopingFlow, sendFermentRequestMessage } from "./scoping.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { applyFermentRuntimeToolProfile, setActiveFermentAndApplyProfile } from "./tool-scope.js"
import type { FermentUiContext } from "./ui.js"
import { checkWorktree } from "./worktree.js"

function sendBreadcrumb(
	pi: ExtensionAPI,
	text: string,
	variant: "step" | "answer" | "ack" | "warning" = "step",
	customType:
		| "ferment_breadcrumb"
		| "ferment_ack"
		| "ferment_worktree_warning"
		| "ferment_oneshot_failed" = "ferment_breadcrumb",
): void {
	void pi.sendMessage(
		{
			customType,
			content: [{ type: "text", text }],
			display: true,
			details: { text, variant },
		},
		{ triggerTurn: false },
	)
}

function sendLifecycleCommandBreadcrumb(
	pi: ExtensionAPI,
	command: "pause" | "resume" | "exit",
	active: ReturnType<FermentRuntime["getActive"]>,
): void {
	const target = active ? `"${active.name}" [${active.status}]` : "no active ferment"
	sendBreadcrumb(pi, `Command /ferment ${command} requested for ${target}.`, "step")
}

function refreshActiveFermentForLifecycleCommand(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
): ReturnType<FermentRuntime["getActive"]> {
	const active = runtime.getActive()
	if (!active) return undefined
	const fresh = runtime.getStorage().get(active.id)
	if (!fresh) {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return undefined
	}
	if (fresh.status !== active.status || fresh.updatedAt !== active.updatedAt) {
		setActiveFermentAndApplyProfile(pi, runtime, fresh)
	}
	return fresh
}

export type FermentCliCommand = FermentCommand

interface FermentArgumentCompletion {
	value: string
	label: string
	description?: string
}

const FERMENT_SUBCOMMAND_COMPLETIONS: FermentArgumentCompletion[] = [
	{ value: "new ", label: "new", description: "Create a ferment" },
	{ value: "manual", label: "manual", description: "Ask before moving to the next phase" },
	{ value: "auto", label: "auto", description: "Continue until done or blocked" },
	{ value: "progress", label: "progress", description: "Open phase/step progress" },
	{ value: "pause", label: "pause", description: "Pause the active ferment lifecycle" },
	{ value: "resume", label: "resume", description: "Resume the active ferment lifecycle" },
	{ value: "exit", label: "exit", description: "Exit Ferment mode" },
	{ value: "list", label: "list", description: "List ferments" },
	{ value: "switch ", label: "switch", description: "Switch active ferment by id or name" },
	{ value: "delete ", label: "delete", description: "Delete a ferment" },
	{ value: "export", label: "export", description: "Export active ferment stats" },
	{ value: "revise ", label: "revise", description: "Revise goal, criteria, or constraints" },
	{ value: "abandon", label: "abandon", description: "Abandon the active ferment" },
	{ value: "one-shot ", label: "one-shot", description: "Create and auto-execute a single task ferment" },
]

const FERMENT_COMMAND_USAGE =
	'Unknown /ferment command. Use /ferment, /ferment new "Name", /ferment progress, /ferment list, /ferment switch <id-or-name>, /ferment pause, /ferment resume, or /ferment exit.'

const FERMENT_REVISE_COMPLETIONS: FermentArgumentCompletion[] = [
	{ value: "revise goal", label: "goal", description: "Revise the ferment goal" },
	{ value: "revise criteria", label: "criteria", description: "Revise success criteria" },
	{ value: "revise constraints", label: "constraints", description: "Revise constraints" },
]

function quoteFermentTarget(name: string, id: string): string {
	if (name.includes('"')) return id
	return `"${name}"`
}

function matchCompletionPrefix(items: FermentArgumentCompletion[], prefix: string): FermentArgumentCompletion[] | null {
	const needle = prefix.toLowerCase()
	const matches = items.filter(
		(item) => item.value.toLowerCase().startsWith(needle) || item.label.toLowerCase().startsWith(needle),
	)
	return matches.length > 0 ? matches : null
}

function fermentTargetCompletions(
	runtime: FermentRuntime,
	verb: "switch" | "delete",
	prefix: string,
): FermentArgumentCompletion[] | null {
	const targetPrefix = prefix
		.slice(verb.length)
		.trim()
		.replace(/^["']|["']$/g, "")
		.toLowerCase()
	const matches = runtime
		.getStorage()
		.list()
		.filter((f) => {
			if (!targetPrefix) return true
			return f.name.toLowerCase().includes(targetPrefix) || f.id.toLowerCase().startsWith(targetPrefix)
		})
		.slice(0, 20)
		.map((f) => ({
			value: `${verb} ${quoteFermentTarget(f.name, f.id)}`,
			label: f.name,
			description: `${f.status} · ${f.id.slice(0, 8)}`,
		}))

	return matches.length > 0 ? matches : null
}

export function getFermentArgumentCompletions(
	prefix: string,
	runtime: FermentRuntime = defaultFermentRuntime,
): FermentArgumentCompletion[] | null {
	const trimmedStart = prefix.trimStart()
	const lower = trimmedStart.toLowerCase()

	for (const verb of ["switch", "delete"] as const) {
		if (lower === verb || lower.startsWith(`${verb} `)) {
			return fermentTargetCompletions(runtime, verb, trimmedStart)
		}
	}

	if (lower === "revise" || lower.startsWith("revise ")) {
		return matchCompletionPrefix(FERMENT_REVISE_COMPLETIONS, trimmedStart)
	}

	return matchCompletionPrefix(FERMENT_SUBCOMMAND_COMPLETIONS, trimmedStart)
}

export interface FermentCommandDeps {
	raw: string
	pi: ExtensionAPI
	ctx: FermentUiContext & ExtensionCommandContext
	runtime: FermentRuntime
}

export interface FermentCommandResult {
	handled: true
}

export interface StartInteractiveFermentDeps {
	pi: ExtensionAPI
	ctx: FermentUiContext
	runtime?: FermentRuntime
}

async function waitForHeadlessCommandTurn(ctx: FermentUiContext & ExtensionCommandContext): Promise<void> {
	if (ctx.hasUI) return
	await ctx.waitForIdle()
}

export async function startInteractiveFerment({
	pi,
	ctx,
	runtime = defaultFermentRuntime,
}: StartInteractiveFermentDeps): Promise<void> {
	const active = runtime.getActive()
	if (active && active.status === "running") {
		ctx.ui.notify(
			`A ferment is already running: "${active.name}". Use /ferment progress to check status or /ferment switch to change.`,
		)
		return
	}
	if (!ctx.ui.editor && !ctx.ui.input) {
		ctx.ui.notify('No UI available. Use /ferment new "Name" instead.')
		return
	}

	const rawIntent = await promptEditor(ctx, "🍺  What would you like to ferment?", {
		placeholder: "e.g. 'Rewrite login flow' or 'Add OAuth support'",
	})
	if (!rawIntent) return

	// Echo the typed intent into the transcript before the host starts working.
	// /ferment new "X" with an inline title skips this; the title was visible in
	// the slash command itself.
	sendFermentRequestMessage(pi, rawIntent)
	await startFermentForIntent({ pi, ctx, runtime, rawIntent })
}

/**
 * Create a draft ferment and run the interactive scoping flow with a
 * pre-supplied intent. Returns `undefined` when another ferment is already
 * running and the call is refused.
 */
export async function startFermentForIntent({
	pi,
	ctx,
	runtime = defaultFermentRuntime,
	rawIntent,
	title,
}: {
	pi: ExtensionAPI
	ctx: FermentUiContext
	runtime?: FermentRuntime
	rawIntent: string
	title?: string
}): Promise<{ name: string } | undefined> {
	const active = runtime.getActive()
	if (active && active.status === "running") {
		ctx.ui.notify(
			`A ferment is already running: "${active.name}". Use /ferment progress to check status or /ferment switch to change.`,
		)
		return undefined
	}
	const storage = runtime.getStorage()
	ctx.ui.setStatus?.("ferment-scoping", "🫧  Fermenting · creating…")
	try {
		// Mirror the /ferment new path: prompt the user about git init if needed.
		// ui.confirm being available means the user can decline; ferment proceeds
		// either way with whatever branch/commit info is present.
		await ensureGitRepo({ ui: ctx.ui })
		const shortName = deriveDraftFermentTitle(title ?? rawIntent)
		const f = storage.create(shortName, rawIntent)
		setActiveFermentAndApplyProfile(pi, runtime, f)
		emitFermentCreated(pi.events, f)
		appendRefEntry(pi, f.id)

		sendBreadcrumb(
			pi,
			`Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nPolicy: ${runtime.getContinuationPolicy()}`,
			"ack",
			"ferment_ack",
		)

		await runScopingFlow(f, pi, ctx, runtime, rawIntent)
		return { name: f.name }
	} catch (err) {
		ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
		return undefined
	} finally {
		ctx.ui.setStatus?.("ferment-scoping", undefined)
	}
}

function setManualContinuationPolicy(pi: ExtensionAPI, ctx: FermentUiContext, runtime: FermentRuntime): void {
	runtime.setContinuationPolicy("manual")
	const active = runtime.getActive()
	if (!active) {
		ctx.ui.notify("Continuation policy set to manual. (No active ferment.)")
		applyFermentRuntimeToolProfile(pi, runtime)
		return
	}
	if (active.status === "paused") {
		ctx.ui.notify(`Continuation policy set to manual. "${active.name}" is paused; run /ferment resume to resume.`)
		applyFermentRuntimeToolProfile(pi, runtime)
		return
	}

	ctx.ui.notify(`Continuation policy set to manual for "${active.name}".`)
	applyFermentRuntimeToolProfile(pi, runtime)
	recordManualBoundaryBreadcrumb(pi, active, runtime)
}

function recordManualBoundaryBreadcrumb(
	pi: ExtensionAPI,
	active: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	runtime: FermentRuntime,
): void {
	const decision = decideContinuation(active, runtime.getContinuationPolicy())
	if (decision.type !== "wait_manual_boundary") return
	sendBreadcrumb(pi, `Manual policy waiting at phase boundary for "${active.name}".`, "step")
}

function setAutomatedContinuationPolicy(pi: ExtensionAPI, ctx: FermentUiContext, runtime: FermentRuntime): void {
	runtime.setContinuationPolicy("automated")
	const active = runtime.getActive()
	if (!active) {
		ctx.ui.notify("Continuation policy set to automated. (No active ferment.)")
		applyFermentRuntimeToolProfile(pi, runtime)
		return
	}

	if (active.status === "paused") {
		ctx.ui.notify(`Continuation policy set to automated. "${active.name}" is paused; run /ferment resume to resume.`)
		applyFermentRuntimeToolProfile(pi, runtime)
		return
	}

	ctx.ui.notify(`Continuation policy set to automated for "${active.name}".`)
	applyFermentRuntimeToolProfile(pi, runtime)
}

async function confirmManualPhaseBoundaryForCommand(
	pi: ExtensionAPI,
	ctx: FermentUiContext,
	runtime: FermentRuntime,
	active: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
): Promise<boolean> {
	const decision = decideContinuation(active, runtime.getContinuationPolicy())
	if (decision.type !== "wait_manual_boundary") return false
	recordManualBoundaryBreadcrumb(pi, active, runtime)

	const nextPhase = active.phases.find((phase) => phase.id === decision.action.phaseId)
	const nextPhaseName = nextPhase?.name ?? decision.action.phaseId

	if (ctx.hasUI && ctx.ui.select) {
		const choice = await ctx.ui.select(`Continue "${active.name}" to "${nextPhaseName}"?`, [
			"Continue to next phase",
			"Pause here",
		])

		if (choice === "Continue to next phase") {
			scheduleFermentWakeUp(pi, runtime, {
				allowManualPhaseBoundary: true,
				fermentId: active.id,
				tag: "Manual boundary wake-up",
			})
			return true
		}

		if (choice === "Pause here") {
			const outcome = createApplyAndPersist(runtime)(active.id, { type: "pause" })
			if (!outcome.ok) {
				ctx.ui.notify(`Failed to pause: ${outcome.error.message}`)
				return true
			}
			setActiveFermentAndApplyProfile(pi, runtime, outcome.ferment)
			runtime.clearPendingPlanReview(active.id)
			ctx.ui.notify(`Paused "${outcome.ferment.name}". Type /ferment resume to resume.`)
			return true
		}
	}

	ctx.ui.notify(
		`"${active.name}" is waiting before "${nextPhaseName}". Choose Continue from /ferment list to continue now, or run /ferment auto to make future phase boundaries automatic.`,
	)
	return true
}

async function openFermentProgress(pi: ExtensionAPI, ctx: FermentUiContext, runtime: FermentRuntime): Promise<void> {
	const applyAndPersist = createApplyAndPersist(runtime)
	const active = runtime.getActive()
	if (!active) {
		ctx.ui.notify("No active ferment. Start one with /ferment.")
		return
	}

	if (!ctx.hasUI || !ctx.ui.select || !ctx.ui.confirm) {
		ctx.ui.notify(formatFermentStatus(active, runtime.getContinuationPolicy()))
		return
	}
	const select = ctx.ui.select.bind(ctx.ui)
	const confirm = ctx.ui.confirm.bind(ctx.ui)

	let atPhaseList = true
	while (atPhaseList) {
		const f = runtime.getStorage().get(active.id) ?? active
		const phaseListOpts = buildPhaseListOptions(f)
		const phaseListPhaseCount = f.phases.length

		const l1choice = await select(buildPhaseListTitle(f, runtime), phaseListOpts)

		if (!l1choice || l1choice === "Close") {
			atPhaseList = false
			continue
		}

		if (l1choice === "Abandon ferment") {
			const confirmed = await confirm(
				`Abandon "${f.name}"?`,
				"Marks the ferment abandoned. Work done so far is preserved.",
			)
			if (confirmed) {
				const outcome = applyAndPersist(f.id, { type: "abandon" })
				if (outcome.ok) setActiveFermentAndApplyProfile(pi, runtime, undefined)
				runtime.clearFermentState(f.id)
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

			const l2choice = await select(buildPhaseDetailTitle(f2, ph), stepOpts)

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
					const actionChoice = await select(buildPhaseDetailTitle(f3, ph3), buildPhaseActionOptions(f3, ph3))
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
				const l3choice = await select(buildStepDetailTitle(ph3, st), stepActionOpts)

				if (!l3choice || l3choice === "Back to phase") {
					atStepDetail = false
					break
				}
				await handleStepAction(l3choice, f3, ph3, st, ctx, runtime)
			}
		}
	}
}

function exitFermentMode(
	pi: ExtensionAPI,
	ctx: FermentUiContext & Pick<ExtensionCommandContext, "abort">,
	runtime: FermentRuntime,
): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	const active = refreshActiveFermentForLifecycleCommand(pi, runtime)
	sendLifecycleCommandBreadcrumb(pi, "exit", active)
	if (!active) {
		ctx.ui.notify("No active ferment to exit.")
		return
	}

	let statusLabel = active.status
	if (active.status === "running" || active.status === "planned") {
		const outcome = applyAndPersist(active.id, { type: "pause" })
		if (!outcome.ok) {
			const message = `Failed to exit "${active.name}": ${outcome.error.message}`
			sendBreadcrumb(pi, message, "warning")
			ctx.ui.notify(message)
			return
		}
		statusLabel = "paused"
	}

	runtime.clearPendingPlanReview(active.id)
	runtime.clearPendingScope(active.id)
	runtime.consumeScopingGate(active.id)
	resetReactiveContinuationNudgeCount(active.id)
	setActiveFermentAndApplyProfile(pi, runtime, undefined)
	const detail = formatExitDetail(statusLabel)
	const message = `Exited Ferment mode for "${active.name}". ${detail}`
	sendBreadcrumb(pi, message, "ack", "ferment_ack")
	ctx.ui.notify(message)
	requestSharedFooterRender()
	ctx.abort()
}

function formatExitDetail(status: string): string {
	if (status === "paused") return "It is paused and can be selected later from /ferment list or /ferment switch."
	if (status === "complete" || status === "abandoned")
		return `It remains ${status} and is still available from /ferment list.`
	return `It remains ${status} and can be selected later from /ferment list or /ferment switch.`
}

export class FermentCommandController {
	async execute(command: FermentCliCommand, deps: FermentCommandDeps): Promise<FermentCommandResult> {
		const { pi, ctx, runtime } = deps
		const applyAndPersist = createApplyAndPersist(runtime)
		const storage = runtime.getStorage()

		if (command.type === "interactive") {
			await startInteractiveFerment({ pi, ctx, runtime })
			return { handled: true }
		}

		if (command.type === "unknown") {
			ctx.ui.notify(FERMENT_COMMAND_USAGE)
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
				resumeFerment(pi, selected.id, ctx, runtime, { allowManualPhaseBoundary: true })
				ctx.ui.notify(`Continuing "${selected.name}"`)
				return { handled: true }
			}

			if (action === "Delete") {
				storage.delete(selected.id)
				runtime.clearFermentState(selected.id)
				if (runtime.getActiveId() === selected.id) setActiveFermentAndApplyProfile(pi, runtime, undefined)
				ctx.ui.notify(`Deleted "${selected.name}"`)
				return { handled: true }
			}
			return { handled: true }
		}

		if (command.type === "manual-policy") {
			setManualContinuationPolicy(pi, ctx, runtime)
			return { handled: true }
		}

		if (command.type === "auto-policy") {
			setAutomatedContinuationPolicy(pi, ctx, runtime)
			return { handled: true }
		}

		if (command.type === "progress") {
			await openFermentProgress(pi, ctx, runtime)
			return { handled: true }
		}

		if (command.type === "exit") {
			exitFermentMode(pi, ctx, runtime)
			return { handled: true }
		}

		if (command.type === "pause-lifecycle") {
			const active = refreshActiveFermentForLifecycleCommand(pi, runtime)
			sendLifecycleCommandBreadcrumb(pi, "pause", active)
			if (!active) {
				ctx.ui.notify("No active ferment to pause.")
				return { handled: true }
			}

			if (active.status !== "running" && active.status !== "planned" && active.status !== "paused") {
				ctx.ui.notify(`Ferment is "${active.status}" — nothing to pause.`)
				return { handled: true }
			}

			if (active.status === "paused") {
				const message = `"${active.name}" is already paused. Type /ferment resume to resume.`
				sendBreadcrumb(pi, message, "ack")
				ctx.ui.notify(message)
				applyFermentRuntimeToolProfile(pi, runtime)
				return { handled: true }
			}

			const outcome = applyAndPersist(active.id, { type: "pause" })
			if (!outcome.ok) {
				const message = `Failed to pause: ${outcome.error.message}`
				sendBreadcrumb(pi, message, "warning")
				ctx.ui.notify(message)
				return { handled: true }
			}

			setActiveFermentAndApplyProfile(pi, runtime, outcome.ferment)
			runtime.clearPendingPlanReview(active.id)
			const message = `Paused "${outcome.ferment.name}". Type /ferment resume to resume.`
			sendBreadcrumb(pi, message, "ack")
			ctx.ui.notify(message)
			ctx.abort()
			return { handled: true }
		}

		if (command.type === "resume-lifecycle") {
			const active = refreshActiveFermentForLifecycleCommand(pi, runtime)
			sendLifecycleCommandBreadcrumb(pi, "resume", active)
			if (!active) {
				ctx.ui.notify("No active ferment to resume.")
				return { handled: true }
			}

			if (active.status !== "paused") {
				const canContinue = active.status === "running" || active.status === "planned"
				const message = canContinue
					? `"${active.name}" is ${active.status}; continuing from current state.`
					: `"${active.name}" is ${active.status}; nothing to resume.`
				sendBreadcrumb(pi, message, "ack")
				ctx.ui.notify(message)
				applyFermentRuntimeToolProfile(pi, runtime)
				if (canContinue) {
					scheduleFermentWakeUp(pi, runtime, { fermentId: active.id, tag: "Resume wake-up" })
				}
				return { handled: true }
			}

			const outcome = applyAndPersist(active.id, { type: "resume" })
			if (!outcome.ok) {
				const message = `Failed to resume: ${outcome.error.message}`
				sendBreadcrumb(pi, message, "warning")
				ctx.ui.notify(message)
				return { handled: true }
			}

			setActiveFermentAndApplyProfile(pi, runtime, outcome.ferment)
			const message = `Resumed "${outcome.ferment.name}". Continuation policy: ${runtime.getContinuationPolicy()}.`
			sendBreadcrumb(pi, message, "ack")
			ctx.ui.notify(message)
			if (await confirmManualPhaseBoundaryForCommand(pi, ctx, runtime, outcome.ferment)) {
				return { handled: true }
			}
			scheduleFermentWakeUp(pi, runtime, { fermentId: outcome.ferment.id, tag: "Resume wake-up" })
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
				if (runtime.getActiveId() === f.id) {
					setActiveFermentAndApplyProfile(pi, runtime, undefined)
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
				const previousActiveId = runtime.getActiveId()
				if (previousActiveId && previousActiveId !== f.id) runtime.clearPendingPlanReview(previousActiveId)
				sendBreadcrumb(pi, `Switched to "${f.name}" [${f.status}]${wtWarning}`, "ack", "ferment_ack")
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
				setActiveFermentAndApplyProfile(pi, runtime, undefined)
				runtime.clearFermentState(abandonedId)
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
				if (!ctx.ui.editor && !ctx.ui.input) {
					ctx.ui.notify("No UI available for interactive revision. Ask the agent to update the goal.")
					return { handled: true }
				}
				const newGoal = await promptEditor(ctx, "Revise goal:", { prefill: active.goal ?? "" })
				if (newGoal) {
					const out = applyAndPersist(active.id, { type: "update_scope_field", field: "goal", value: newGoal })
					if (out.ok) {
						setActiveFermentAndApplyProfile(pi, runtime, out.ferment)
						ctx.ui.notify(`Goal updated: "${newGoal}"`)
					} else {
						ctx.ui.notify(`Could not update goal: ${out.error.message}`)
					}
				}
				return { handled: true }
			}

			if (field === "criteria") {
				if (!ctx.ui.editor && !ctx.ui.input) {
					ctx.ui.notify("No UI available for interactive revision.")
					return { handled: true }
				}
				const newCriteria = await promptEditor(ctx, "Revise success criteria:", {
					prefill: successCriteriaToAnswer(active.successCriteria) ?? "",
				})
				if (newCriteria) {
					const out = applyAndPersist(active.id, {
						type: "update_scope_field",
						field: "criteria",
						value: newCriteria,
					})
					if (out.ok) {
						setActiveFermentAndApplyProfile(pi, runtime, out.ferment)
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
						setActiveFermentAndApplyProfile(pi, runtime, out.ferment)
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
				ctx.ui.notify(`A ferment is already running: "${active.name}". Use /ferment progress to check status.`)
				return { handled: true }
			}
			const intent = command.intent
			let resolvedIntent = intent
			if (!resolvedIntent) {
				if (!ctx.hasUI || (!ctx.ui.editor && !ctx.ui.input)) {
					ctx.ui.notify('Usage: /ferment one-shot "description of what to build"')
					return { handled: true }
				}
				const typed = await promptEditor(ctx, "🍺  One-shot: what should be done?", {
					placeholder: "Describe the full task…",
				})
				if (!typed) return { handled: true }
				resolvedIntent = typed
			}
			ctx.ui.setStatus?.("ferment-scoping", "🫧  Fermenting · creating…")
			try {
				// One-shot is non-interactive by definition — only auto-init when the
				// user opted in via flag or env var. Otherwise skip silently.
				await ensureGitRepo({
					ui: ctx.ui,
					autoInit: pi.getFlag?.("init-git") === true || autoInitFromEnv(),
				})
				runtime.setContinuationPolicy("automated")
				const shortName = deriveDraftFermentTitle(resolvedIntent)
				const f = storage.create(shortName, resolvedIntent)
				const updated = f
				setActiveFermentAndApplyProfile(pi, runtime, updated)
				emitFermentCreated(pi.events, updated)
				appendRefEntry(pi, updated.id)
				sendBreadcrumb(
					pi,
					`One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nPolicy: automated`,
					"ack",
					"ferment_ack",
				)
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
				await waitForHeadlessCommandTurn(ctx)
			} catch (err) {
				ctx.ui.notify(err instanceof FermentError ? err.message : "One-shot create failed.")
			} finally {
				ctx.ui.setStatus?.("ferment-scoping", undefined)
			}
			return { handled: true }
		}

		const active = runtime.getActive()
		if (active && active.status === "running") {
			ctx.ui.notify(
				`A ferment is already running: "${active.name}". Use /ferment progress to check status or /ferment switch to change.`,
			)
			return { handled: true }
		}
		if (command.type !== "new") {
			ctx.ui.notify(FERMENT_COMMAND_USAGE)
			return { handled: true }
		}
		let rawName = command.title
		let scopingIntent: string | undefined = rawName || undefined
		if (!rawName) {
			if (!ctx.hasUI || (!ctx.ui.editor && !ctx.ui.input)) {
				ctx.ui.notify('Usage: /ferment new "Name"')
				return { handled: true }
			}
			const typed = await promptEditor(ctx, "🍺  What would you like to ferment?", {
				placeholder: "e.g. 'Rewrite login flow' or 'Add OAuth support'",
			})
			if (!typed) return { handled: true }
			rawName = typed
			scopingIntent = typed
			sendFermentRequestMessage(pi, typed)
		}
		ctx.ui.setStatus?.("ferment-scoping", "🫧  Fermenting · creating…")
		try {
			// Interactive path: ui.confirm is available, so ensureGitRepo will ask.
			// User can decline; ferment still proceeds with no branch/commit info.
			await ensureGitRepo({ ui: ctx.ui })
			const shortName = deriveDraftFermentTitle(rawName)
			const f = storage.create(shortName, rawName)
			setActiveFermentAndApplyProfile(pi, runtime, f)
			emitFermentCreated(pi.events, f)
			appendRefEntry(pi, f.id)

			sendBreadcrumb(
				pi,
				`Started ferment: "${f.name}"\nBranch: ${f.worktree.branch ?? "n/a"}  Path: ${f.worktree.path}\nPolicy: ${runtime.getContinuationPolicy()}`,
				"ack",
				"ferment_ack",
			)

			await runScopingFlow(f, pi, ctx, runtime, scopingIntent)
			await waitForHeadlessCommandTurn(ctx)
		} catch (err) {
			ctx.ui.notify(err instanceof FermentError ? err.message : "Create failed.")
		} finally {
			ctx.ui.setStatus?.("ferment-scoping", undefined)
		}
		return { handled: true }
	}
}

export function registerFermentCommands(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const fermentCommandController = new FermentCommandController()

	pi.registerCommand("ferment", {
		description: 'Manage ferments: /ferment list, /ferment new "Name", /ferment one-shot "task", /ferment switch <id>',
		getArgumentCompletions: (prefix) => getFermentArgumentCompletions(prefix, runtime),
		async handler(args, ctx) {
			const raw = args.trim()
			const command = parseFermentCommand(args)
			await fermentCommandController.execute(command, { raw, pi, ctx, runtime })
		},
	})
}
