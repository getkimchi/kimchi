import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { clearFermentCache } from "../../ferment/store.js"
import { deriveDraftFermentTitle } from "../../ferment/title.js"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { deferExtensionAction } from "../deferred-action.js"
import { maybeTriggerFermentCompaction } from "./auto-compaction.js"
import { formatDuration } from "./colors.js"
import { extractContextualOptions, extractTrailingQuestion } from "./contextual-options.js"
import { decideContinuation } from "./continuation.js"
import { emitFermentCreated } from "./domain-events-emitter.js"
import { FERMENT_EVENTS, type FermentStalledPayload } from "./domain-events.js"
import { autoInitFromEnv, ensureGitRepo } from "./git-init.js"
import {
	appendRefEntry,
	maybeInjectFermentStopNudge,
	maybeInjectReactiveContinuationNudge,
	maybeInjectScopingProgressNudge,
	onFermentToolCallSeen,
	resetReactiveContinuationNudgeCount,
} from "./nudge.js"
import { buildOneshotNudge } from "./oneshot.js"
import { editPhaseProposal } from "./phase-editor.js"
import { promptEditor, promptSelect } from "./prompt-ui.js"
import { loadFermentSilently, resumeFerment } from "./resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { clearActiveFermentId, getActiveFermentId } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import {
	applyFermentRuntimeToolProfile,
	applyFermentToolProfile,
	setActiveFermentAndApplyProfile,
} from "./tool-scope.js"

type AssistantContentPart = { type: string; text?: string; name?: string }
type TurnEndContext = Partial<Pick<ExtensionContext, "ui">>

function isAssistantContentPart(value: unknown): value is AssistantContentPart {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

function getAssistantContentParts(content: unknown): AssistantContentPart[] {
	return Array.isArray(content) ? content.filter(isAssistantContentPart) : []
}

function hasToolCall(content: AssistantContentPart[], toolName: string): boolean {
	return content.some((c) => c.type === "toolCall" && c.name === toolName)
}

function hasAnyToolCall(content: AssistantContentPart[]): boolean {
	return content.some((c) => c.type === "toolCall")
}

function getToolCallNames(content: AssistantContentPart[]): string[] {
	return content.filter((c) => c.type === "toolCall" && c.name).map((c) => c.name as string)
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

interface UserInputPrompt {
	text: string
	title: string
	options: string[]
	isDraft: boolean
	contextualOptions: string[] | undefined
	yesLabel: string
	noLabel: string
}

function findUserInputPrompt(
	content: AssistantContentPart[],
	f: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
): UserInputPrompt | undefined {
	if (f.status !== "draft" && f.status !== "planned" && f.status !== "running") return undefined
	if (hasToolCall(content, "propose_ferment_scoping")) return undefined
	const text = extractPromptTextAfterLastToolCall(content)
	if (!text) return undefined

	const title = extractTrailingQuestion(text)
	const contextualOptions = extractContextualOptions(text)
	if (!text.endsWith("?") && !contextualOptions) return undefined

	const isDraft = f.status === "draft"
	const yesLabel = isDraft ? "Yes, this looks right" : "Yes, proceed"
	const noLabel = isDraft ? "No, revise" : "No, pause"
	const options = contextualOptions
		? [...contextualOptions, "Let me say something else"]
		: [yesLabel, noLabel, "Let me say something else"]

	return { text, title, options, isDraft, contextualOptions, yesLabel, noLabel }
}

async function maybeRunManualBoundaryDropdown(
	pi: ExtensionAPI,
	ctx: TurnEndContext | undefined,
	prompt: UserInputPrompt,
	f: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	runtime: FermentRuntime,
): Promise<boolean> {
	const decision = decideContinuation(f, runtime.getContinuationPolicy())
	if (decision.type !== "wait_manual_boundary") return false
	if (!ctx?.ui?.select) return true

	const nextPhase = f.phases.find((phase) => phase.id === decision.action.phaseId)
	const nextPhaseName = nextPhase?.name ?? decision.action.phaseId
	const choice = await promptSelect(ctx, prompt.title || `Continue to "${nextPhaseName}"?`, [
		"Continue to next phase",
		"Pause here",
	])
	if (!choice) return true

	if (choice === "Continue to next phase") {
		scheduleFermentWakeUp(pi, runtime, {
			allowManualPhaseBoundary: true,
			deliverAsFollowUp: true,
			fermentId: f.id,
			tag: "Manual boundary wake-up",
		})
		return true
	}

	if (choice === "Pause here") {
		const outcome = createApplyAndPersist(runtime)(f.id, { type: "pause" })
		if (!outcome.ok) {
			ctx.ui.notify?.(`Failed to pause: ${outcome.error.message}`)
			return true
		}
		setActiveFermentAndApplyProfile(pi, runtime, outcome.ferment)
		ctx.ui.notify?.(`Paused "${outcome.ferment.name}". Type /ferment resume to resume.`)
		return true
	}
	return true
}

/**
 * Build the `FermentStalledPayload` for telemetry emission. Shared by
 * the crash-recovery and user-decline stall paths so the two sites
 * stay in sync as the payload evolves.
 */
function buildStalledPayload(ferment: Ferment, now: number): FermentStalledPayload {
	const completedPhases = ferment.phases.filter((p) => p.status === "completed").length
	const totalPhases = ferment.phases.length
	const phaseCompletionRatio = totalPhases > 0 ? completedPhases / totalPhases : 0
	const lastActiveMs = ferment.lastActiveAt ? Date.parse(ferment.lastActiveAt) : Number.NaN
	const idleDurationMs = Number.isFinite(lastActiveMs) ? now - lastActiveMs : 0
	return {
		fermentId: ferment.id,
		name: ferment.name,
		lifecycleStage: ferment.status,
		idleDurationMs,
		completedPhases,
		totalPhases,
		phaseCompletionRatio,
	}
}

async function maybeRunUserInputDropdown(
	pi: ExtensionAPI,
	ctx: TurnEndContext | undefined,
	content: AssistantContentPart[],
	f: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	runtime: FermentRuntime,
): Promise<boolean> {
	const prompt = findUserInputPrompt(content, f)
	if (!prompt) return false
	const boundaryHandled = await maybeRunManualBoundaryDropdown(pi, ctx, prompt, f, runtime)
	if (boundaryHandled) return true
	if (!ctx?.ui?.select || (!ctx.ui.editor && !ctx.ui.input)) return true

	const choice = await promptSelect(ctx, prompt.title, prompt.options)
	if (!choice) return true

	let reply: string

	if (choice === "Let me say something else") {
		const custom = await promptEditor(ctx, "Your message:")
		if (!custom) return true
		reply = custom
	} else if (choice === prompt.noLabel) {
		reply = prompt.isDraft ? "No — please revise." : "No, pause for now."
	} else if (prompt.contextualOptions?.includes(choice)) {
		reply = choice
	} else if (prompt.isDraft && choice === prompt.yesLabel) {
		// Open the phase editor so the user can rename/reorder/delete/add
		// before we persist. The pending phases are the LLM's proposal.
		const pending = runtime.getPendingScope(f.id)
		const startingPhases = pending?.phases
		let edited = startingPhases
		if (startingPhases && startingPhases.length > 0 && ctx) {
			let result: typeof startingPhases | undefined
			try {
				result = await editPhaseProposal(ctx, startingPhases, runtime)
			} catch (err) {
				runtime.markHumanInput()
				const msg = err instanceof Error ? err.message : String(err)
				ctx.ui?.notify?.(`Phase editor failed: ${msg} — plan not saved.`)
				void pi.sendUserMessage(
					"Phase editor errored before the user could confirm. Ask the user to retry confirmation explicitly.",
					{ deliverAs: "followUp" },
				)
				return true
			}
			if (!result) {
				runtime.markHumanInput()
				void pi.sendUserMessage("User chose to keep editing the phases — revise the plan in your next response.", {
					deliverAs: "followUp",
				})
				return true
			}
			edited = result
		}
		const outcome = confirmPendingScope(runtime, f.id, edited, "turn_end", pi)
		if (outcome.ok) {
			ctx.ui.notify?.(
				`Plan saved for "${outcome.outcome.ferment.name}". ${outcome.outcome.ferment.phases.length} phase(s) ready.`,
			)
			reply = `Plan saved by user confirmation — ${outcome.outcome.ferment.phases.length} phase(s) now in "planned" status. You can proceed with activate_ferment_phase when the user is ready, or wait for further instructions.`
		} else if (outcome.error.code !== "MISSING_PENDING_PHASES" && outcome.error.code !== "MISSING_PENDING_SCOPE") {
			ctx.ui.notify?.(`Failed to save plan: ${outcome.error.message}`)
			reply = `Plan save failed: ${outcome.error.message}. Investigate the ferment state and try again.`
		} else {
			reply =
				"User confirmed the plan but you never called propose_ferment_scoping — there's nothing structured for the host to save. Call propose_ferment_scoping now with the same plan you just showed; propose_ferment_scoping will handle confirmation via its own dropdown — do not append a trailing question."
		}
	} else {
		reply = "Yes, proceed."
	}

	runtime.markHumanInput()
	void pi.sendUserMessage(reply, { deliverAs: "followUp" })
	return true
}

export function registerFermentEvents(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	let pendingOneshot = false
	pi.registerFlag("ferment-oneshot", {
		type: "boolean",
		description: "Bootstrap the initial prompt as an automated one-shot ferment.",
	})
	pi.registerFlag("init-git", {
		type: "boolean",
		description: "When the ferment cwd is not a git repo, run `git init` instead of skipping.",
	})

	function recoverStuckFerments(): void {
		// On a fresh start with no active ferment marker, any ferment in
		// "running" or "planned" must be stale — the previous process died
		// without graceful shutdown. Pause them so their orphaned steps are
		// reset to "pending" by handlePause and the engineer can restart them.
		const applyAndPersist = createApplyAndPersist(runtime)
		for (const f of runtime.getStorage().list()) {
			if (f.status === "running" || f.status === "planned") {
				try {
					const outcome = applyAndPersist(f.id, { type: "pause" })
					if (!outcome.ok) {
						// eslint-disable-next-line no-console
						console.error("RECOVER FAILED for", f.id, outcome.error)
					} else {
						// Emit stalled telemetry for crash-recovered ferments.
						// Load the full Ferment to access phases and lastActiveAt.
						const full = runtime.getStorage().get(f.id)
						if (full) {
							pi.events.emit(FERMENT_EVENTS.STALLED, buildStalledPayload(full, runtime.now().getTime()))
						}
					}
				} catch (err) {
					// eslint-disable-next-line no-console
					console.error("RECOVER EXCEPTION for", f.id, err)
				}
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isAgentWorker()) {
			return
		}
		runtime.setContinuationPolicy(ctx?.hasUI ? "manual" : "automated")
		runtime.clearAllStepStarts()
		runtime.clearAllScopingGates()
		runtime.clearAllPendingScopes()
		runtime.clearAllPendingPlanReviews()
		runtime.clearAllPendingCompactions()
		clearFermentCache()

		const envId = getActiveFermentId()
		if (!envId) {
			try {
				recoverStuckFerments()
			} catch {
				// Best-effort recovery. If storage is unavailable during startup,
				// we can't pause anything — the next clean start will retry.
			}
		}

		if (envId) {
			pendingOneshot = false
			clearActiveFermentId()

			const storage = runtime.getStorage()
			const ferment = storage.get(envId)
			if (!ferment || ferment.status === "complete" || ferment.status === "abandoned") {
				runtime.setActive(undefined)
				return
			}

			if (ctx?.hasUI && ctx.ui?.select) {
				// F27: ask user before auto-resuming so the planner doesn't
				// hijack the session before they're ready.
				const activePhase = ferment.phases.find((p) => p.id === ferment.activePhaseId)
				const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
				const phaseInfo = activePhase ? ` — Phase ${activePhase.index}/${ferment.phases.length}` : ""
				const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length ?? 0}` : ""
				const parsed = ferment.updatedAt ? Date.parse(ferment.updatedAt) : Number.NaN
				const updatedMs = Number.isFinite(parsed) ? parsed : runtime.now().getTime()
				const ago = formatDuration(runtime.now().getTime() - updatedMs)
				const banner = `🍺  Active ferment "${ferment.name}"${phaseInfo}${stepInfo} · ${ago}. Resume?`
				const choice = await ctx.ui.select(banner, ["Resume", "Leave paused"])
				runtime.markHumanInput()
				if (choice === "Resume") {
					deferExtensionAction(() => resumeFerment(pi, envId, ctx, runtime))
				} else {
					// User explicitly declined to resume — emit stalled telemetry.
					pi.events.emit(FERMENT_EVENTS.STALLED, buildStalledPayload(ferment, runtime.now().getTime()))
					deferExtensionAction(() => {
						loadFermentSilently(pi, envId, runtime)
					})
				}
			} else {
				deferExtensionAction(() => resumeFerment(pi, envId, ctx, runtime))
			}
		} else if (pi.getFlag("ferment-oneshot") === true) {
			pendingOneshot = true
			runtime.setActive(undefined)
		} else {
			pendingOneshot = false
			runtime.setActive(undefined)
		}
	})

	pi.on("session_shutdown", async () => {
		if (isAgentWorker()) return
		runtime.clearAllPendingPlanReviews()
		const f = runtime.getActive()
		if (!f) return
		if (f.status === "running" || f.status === "planned") {
			try {
				applyAndPersist(f.id, { type: "pause" })
			} catch {
				// If persistence fails during shutdown, we can't fix it here.
				// The startup scanner will recover the stale state on next launch.
			}
		}
	})

	pi.on("input", async (event) => {
		if (event.source === "interactive") {
			runtime.markHumanInput()
		}

		if (!pendingOneshot) return
		pendingOneshot = false

		const intent = event.text.trim()
		if (!intent) return

		try {
			// Bootstrap path: no UI available yet, so only auto-init when the user
			// opted in via --init-git or KIMCHI_AUTO_GIT_INIT=1.
			runtime.setContinuationPolicy("automated")
			await ensureGitRepo({
				autoInit: pi.getFlag?.("init-git") === true || autoInitFromEnv(),
			})
			const storage = runtime.getStorage()
			const shortName = deriveDraftFermentTitle(intent)
			const f = storage.create(shortName, intent)
			const updated = f
			runtime.setActive(updated)
			emitFermentCreated(pi.events, updated)
			appendRefEntry(pi, updated.id)
			const ackText = `One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nPolicy: automated`
			void pi.sendMessage(
				{
					customType: "ferment_ack",
					content: [{ type: "text", text: ackText }],
					display: true,
					details: { text: ackText, variant: "ack" },
				},
				{ triggerTurn: false },
			)
			return { action: "transform" as const, text: buildOneshotNudge(updated, intent), images: event.images }
		} catch (err) {
			const failText = `One-shot ferment bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
			void pi.sendMessage(
				{
					customType: "ferment_oneshot_failed",
					content: [{ type: "text", text: failText }],
					display: true,
					details: { text: failText, variant: "warning" },
				},
				{ triggerTurn: false },
			)
			return
		}
	})

	pi.on("before_agent_start", async () => {
		// pi-mono snapshots the active tool list when an agent run starts. Apply
		// only run-static profiles here; lifecycle tools remain visible for the
		// whole active planner run and invalid transitions are rejected by tools.
		if (isAgentWorker()) {
			// Subagent workers get their toolset from the agents manager at session
			// init (agent-runner.ts setActiveToolsByName). Do NOT call setActiveTools
			// here — the worker profile used to call setActiveTools([]) which would
			// strip all tools from the subagent on the first turn.
			return {}
		}
		// Only apply a ferment profile when a ferment is active. In normal chat
		// mode (no active ferment) leave the toolset untouched so the user gets
		// the full tool set. The idle profile (discovery-only) is applied by
		// command handlers when entering/exiting ferment mode, not here.
		if (!runtime.getActive()) {
			return {}
		}
		// One-shot and interactive flows share the unified profile model: derive
		// the profile from the active ferment's lifecycle state (planning vs.
		// implementation). Both modes drive off the same runtime.
		applyFermentRuntimeToolProfile(pi, runtime)
		return {}
	})

	pi.on("model_select", (event, ctx) => {
		runtime.captureJudgeContext(event.model, ctx?.modelRegistry)
	})

	pi.on("turn_end", async (event, ctx) => {
		if (isAgentWorker()) return
		runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		if (event.message.role !== "assistant") return
		const content = getAssistantContentParts(event.message.content)
		const activeId = runtime.getActiveId()
		const toolCallSeen = hasAnyToolCall(content)
		const stopReason = (event.message as { stopReason?: string }).stopReason
		if (toolCallSeen && activeId) {
			resetReactiveContinuationNudgeCount(activeId)
			// A normal tool-use turn means the model is still progressing, so reset
			// the stop-nudge budget. A tool-use turn that ended with "stop" is exactly
			// what the stop-nudge counter is tracking, so do not reset it here.
			if (stopReason !== "stop") {
				onFermentToolCallSeen(activeId)
			}
		}

		const f = runtime.getActive()
		if (!f) return

		// During draft scoping, detect when the model is stuck exploring
		// without progressing through the scoping steps.
		if (f.status === "draft" && runtime.isScopingInteractive(f.id) && toolCallSeen) {
			const toolNames = getToolCallNames(content)
			const nudged = maybeInjectScopingProgressNudge(pi, f.id, toolNames)
			if (nudged) return
		}

		const userInputHandled = await maybeRunUserInputDropdown(pi, ctx, content, f, runtime)
		if (userInputHandled) return
		if (!toolCallSeen) {
			maybeInjectReactiveContinuationNudge(pi, runtime)
		} else if (stopReason === "stop") {
			// The model made tool calls this turn but ended with stopReason "stop"
			// while the ferment still requires action (e.g. completed a step then
			// wrote a summary and quit without advancing the lifecycle). Nudge it
			// to call the next ferment tool rather than leaving the run stalled.
			maybeInjectFermentStopNudge(pi, runtime)
		}

		// Trigger compaction after any turn that completed a step or phase.
		// Fires between turns in automated-continuation mode, so the next
		// phase starts with a fresh compacted session.
		maybeTriggerFermentCompaction(pi, ctx, runtime)
	})
}
