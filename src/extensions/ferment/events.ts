import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { clearFermentCache } from "../../ferment/store.js"
import { deriveDraftFermentTitle } from "../../ferment/title.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { formatDuration } from "./colors.js"
import { extractContextualOptions, extractTrailingQuestion } from "./contextual-options.js"
import { decideContinuation } from "./continuation.js"
import { autoInitFromEnv, ensureGitRepo } from "./git-init.js"
import { appendRefEntry, maybeInjectReactiveContinuationNudge, resetReactiveContinuationNudgeCount } from "./nudge.js"
import { buildOneshotNudge } from "./oneshot.js"
import { editPhaseProposal } from "./phase-editor.js"
import { promptEditor, promptSelect } from "./prompt-ui.js"
import { loadFermentSilently, resumeFerment } from "./resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { isRestoringModel, setRestoringModel } from "./state.js"
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
		// On a fresh start with no KIMCHI_ACTIVE_FERMENT, any ferment in
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
			applyFermentToolProfile(pi, "worker")
			return
		}
		runtime.setContinuationPolicy(ctx?.hasUI ? "manual" : "automated")
		runtime.clearAllStepStarts()
		runtime.clearAllScopingGates()
		runtime.clearAllPendingScopes()
		runtime.clearAllPendingPlanReviews()
		clearFermentCache()

		const envId = process.env.KIMCHI_ACTIVE_FERMENT
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
			Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")

			if (ctx?.hasUI && ctx.ui?.select) {
				// F27: ask user before auto-resuming so the planner doesn't
				// hijack the session before they're ready.
				const storage = runtime.getStorage()
				const ferment = storage.get(envId)
				if (!ferment) {
					setActiveFermentAndApplyProfile(pi, runtime, undefined)
					return
				}
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
					resumeFerment(pi, envId, ctx, runtime)
				} else {
					loadFermentSilently(pi, envId, runtime)
				}
			} else {
				resumeFerment(pi, envId, ctx, runtime)
			}
		} else if (pi.getFlag("ferment-oneshot") === true) {
			pendingOneshot = true
			runtime.setActive(undefined)
			applyFermentToolProfile(pi, "oneshot-planner")
		} else {
			pendingOneshot = false
			setActiveFermentAndApplyProfile(pi, runtime, undefined)
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
			applyFermentToolProfile(pi, "worker")
			return {}
		}
		if (pi.getFlag("ferment-oneshot") === true) {
			applyFermentToolProfile(pi, "oneshot-planner")
			return {}
		}
		applyFermentRuntimeToolProfile(pi, runtime)
		return {}
	})

	pi.on("model_select", async (event, ctx) => {
		runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		const f = runtime.getActive()
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

	pi.on("turn_end", async (event, ctx) => {
		if (isAgentWorker()) return
		runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		if (event.message.role !== "assistant") return
		const content = getAssistantContentParts(event.message.content)
		const activeId = runtime.getActiveId()
		const toolCallSeen = hasAnyToolCall(content)
		if (toolCallSeen && activeId) resetReactiveContinuationNudgeCount(activeId)

		const f = runtime.getActive()
		if (!f) return
		const userInputHandled = await maybeRunUserInputDropdown(pi, ctx, content, f, runtime)
		if (userInputHandled) return
		if (!toolCallSeen) maybeInjectReactiveContinuationNudge(pi, runtime)
	})
}
