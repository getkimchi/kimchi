import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { shortenTitle } from "../../ferment/shorten-title.js"
import { clearFermentCache } from "../../ferment/store.js"
import { extractContextualOptions, extractTrailingQuestion } from "./contextual-options.js"
import { autoInitFromEnv, ensureGitRepo } from "./git-init.js"
import { appendRefEntry, maybeInjectReactiveAutoNudge, resetReactiveAutoNudgeCount } from "./nudge.js"
import { buildOneshotNudge } from "./oneshot.js"
import { promptInput, promptSelect } from "./prompt-ui.js"
import { resumeFerment } from "./resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { isRestoringModel, setRestoringModel } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import {
	applyFermentRuntimeToolProfile,
	applyFermentToolProfile,
	setActiveFermentAndApplyProfile,
	setActiveFermentState,
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

async function maybeRunPlanModeDropdown(
	pi: ExtensionAPI,
	ctx: TurnEndContext | undefined,
	content: AssistantContentPart[],
	f: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	runtime: FermentRuntime,
): Promise<void> {
	if (!ctx?.ui?.select) return

	if (f.status !== "draft" && f.status !== "running") return
	if (!ctx.ui.input) return

	if (hasToolCall(content, "propose_ferment_scoping")) return
	const text = extractPromptTextAfterLastToolCall(content)
	if (!text) return

	const isDraft = f.status === "draft"
	const yesLabel = isDraft ? "Yes, this looks right" : "Yes, proceed"
	const noLabel = isDraft ? "No, revise" : "No, pause"

	const title = extractTrailingQuestion(text)
	const contextualOptions = extractContextualOptions(text)
	if (!text.endsWith("?") && !contextualOptions) return
	const options = contextualOptions
		? [...contextualOptions, "Let me say something else"]
		: [yesLabel, noLabel, "Let me say something else"]
	const choice = await promptSelect(ctx, title, options)
	if (!choice) return

	let reply: string

	if (choice === "Let me say something else") {
		const custom = await promptInput(ctx, "Your message:", "")
		if (!custom) return
		reply = custom
	} else if (choice === noLabel) {
		reply = isDraft ? "No — please revise." : "No, pause for now."
	} else if (contextualOptions?.includes(choice)) {
		reply = choice
	} else if (isDraft && choice === yesLabel) {
		const outcome = confirmPendingScope(runtime, f.id, undefined, "turn_end", f.name, pi)
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
}

export function registerFermentEvents(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	let pendingOneshot = false
	pi.registerFlag("ferment-oneshot", {
		type: "boolean",
		description: "Bootstrap the initial prompt as a one-shot exec-mode ferment.",
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
		if (process.env.KIMCHI_SUBAGENT === "1") {
			applyFermentToolProfile(pi, "worker")
			return
		}
		runtime.clearAllStepStarts()
		runtime.clearAllScopingGates()
		runtime.clearAllPendingScopes()
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
			resumeFerment(pi, envId, ctx, runtime)
			Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
		} else if (pi.getFlag("ferment-oneshot") === true) {
			pendingOneshot = true
			setActiveFermentState(runtime, undefined)
			applyFermentToolProfile(pi, "oneshot-planner")
		} else {
			pendingOneshot = false
			setActiveFermentAndApplyProfile(pi, runtime, undefined)
		}
	})

	pi.on("session_shutdown", async () => {
		if (process.env.KIMCHI_SUBAGENT === "1") return
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
			await ensureGitRepo({
				autoInit: pi.getFlag?.("init-git") === true || autoInitFromEnv(),
			})
			const storage = runtime.getStorage()
			let shortName: string
			try {
				shortName = await shortenTitle(intent)
			} catch {
				shortName = intent.length > 60 ? `${intent.slice(0, 57).trimEnd()}...` : intent
			}
			const f = storage.create(shortName, intent)
			const modeOut = applyAndPersist(f.id, { type: "set_mode", mode: "exec" })
			const updated = modeOut.ok ? modeOut.ferment : f
			setActiveFermentState(runtime, updated)
			appendRefEntry(pi, updated.id)
			pi.appendEntry("ferment_ack", {
				text: `🍺  One-shot ferment: "${updated.name}"\nBranch: ${updated.worktree.branch ?? "n/a"}\nMode: exec (fully autonomous)`,
			})
			return { action: "transform" as const, text: buildOneshotNudge(updated, intent), images: event.images }
		} catch (err) {
			pi.appendEntry("ferment_oneshot_failed", {
				text: `One-shot ferment bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
			})
			return
		}
	})

	pi.on("before_agent_start", async () => {
		// pi-mono snapshots the active tool list when an agent run starts. Apply
		// only run-static profiles here; lifecycle tools remain visible for the
		// whole active planner run and invalid transitions are rejected by tools.
		if (process.env.KIMCHI_SUBAGENT === "1") {
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
		if (process.env.KIMCHI_SUBAGENT === "1") return
		runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		if (event.message.role !== "assistant") return
		const content = getAssistantContentParts(event.message.content)
		const activeId = runtime.getActiveId()
		const toolCallSeen = hasAnyToolCall(content)
		if (toolCallSeen && activeId) resetReactiveAutoNudgeCount(activeId)

		const f = runtime.getActive()
		if (!f) return
		if (f.mode === "exec") {
			if (!toolCallSeen) maybeInjectReactiveAutoNudge(pi, runtime)
			return
		}
		await maybeRunPlanModeDropdown(pi, ctx, content, f, runtime)
	})
}
