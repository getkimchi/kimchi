import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { shortenTitle } from "../../ferment/shorten-title.js"
import { clearFermentCache } from "../../ferment/store.js"
import { extractContextualOptions, extractTrailingQuestion } from "./contextual-options.js"
import { appendRefEntry } from "./nudge.js"
import { buildOneshotNudge } from "./oneshot.js"
import { buildPlannerSupplement } from "./planner-supplement.js"
import { resumeFerment } from "./resume.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { isRestoringModel, setRestoringModel } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { disableFermentTools, setActiveFerment } from "./tool-scope.js"

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

export function registerFermentEvents(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const applyAndPersist = createApplyAndPersist(runtime)
	let pendingOneshot = false
	pi.registerFlag("ferment-oneshot", {
		type: "boolean",
		description: "Bootstrap the initial prompt as a one-shot exec-mode ferment.",
	})

	pi.on("session_start", async (_event, ctx) => {
		disableFermentTools(pi)
		if (process.env.KIMCHI_SUBAGENT === "1") return
		runtime.clearAllStepStarts()
		runtime.clearAllScopingGates()
		runtime.clearAllPendingScopes()
		clearFermentCache()

		const envId = process.env.KIMCHI_ACTIVE_FERMENT
		if (envId) {
			pendingOneshot = false
			resumeFerment(pi, envId, ctx, runtime)
			Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
		} else if (pi.getFlag("ferment-oneshot") === true) {
			pendingOneshot = true
			setActiveFerment(pi, runtime, undefined)
		} else {
			setActiveFerment(pi, runtime, undefined)
		}
	})

	pi.on("session_shutdown", async () => {
		if (process.env.KIMCHI_SUBAGENT === "1") return
		const f = runtime.getActive()
		if (!f) return
		if (f.status === "running" || f.status === "planned") {
			applyAndPersist(f.id, { type: "pause" })
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
			setActiveFerment(pi, runtime, updated)
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

	pi.on("before_agent_start", async (event) => {
		const f = runtime.getActive()
		if (!f) return {}
		if (f.status === "paused") {
			const pausedSupplement = `\n\n## Ferment Paused\n\nFerment "${f.name}" is paused by the user. Do NOT call any ferment tools (activate_phase, start_step, complete_step, etc.) — they will be rejected. Acknowledge any pending question briefly and wait for the user to resume with /auto.`
			return { systemPrompt: `${event.systemPrompt}${pausedSupplement}` }
		}
		if (f.status !== "running") return {}
		const supplement = buildPlannerSupplement(runtime)
		return { systemPrompt: `${event.systemPrompt}${supplement}` }
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
		runtime.captureJudgeContext(ctx?.model, ctx?.modelRegistry)
		const f = runtime.getActive()
		if (!f) return
		if (f.mode === "exec") return
		if (f.status !== "draft" && f.status !== "running") return
		if (!ctx?.ui?.select || !ctx?.ui?.input) return
		if (event.message.role !== "assistant") return

		if (hasToolCall(event.message.content, "propose_phases")) return
		const text = extractPromptTextAfterLastToolCall(event.message.content)
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
			reply = choice
		} else if (isDraft && choice === yesLabel) {
			const outcome = confirmPendingScope(runtime, f.id, undefined, "turn_end", f.name)
			if (outcome.ok) {
				ctx.ui.notify(
					`Plan saved for "${outcome.outcome.ferment.name}". ${outcome.outcome.ferment.phases.length} phase(s) ready.`,
				)
				reply = `Plan saved by user confirmation — ${outcome.outcome.ferment.phases.length} phase(s) now in "planned" status. You can proceed with activate_phase when the user is ready, or wait for further instructions.`
			} else if (outcome.error.code !== "MISSING_PENDING_PHASES" && outcome.error.code !== "MISSING_PENDING_SCOPE") {
				ctx.ui.notify(`Failed to save plan: ${outcome.error.message}`)
				reply = `Plan save failed: ${outcome.error.message}. Investigate the ferment state and try again.`
			} else {
				reply =
					"User confirmed the plan but you never called propose_phases — there's nothing structured for the host to save. Call propose_phases now with the same plan you just showed, then end with 'Does this plan look right?' so the user can confirm again."
			}
		} else {
			reply = "Yes, proceed."
		}

		runtime.markHumanInput()
		void pi.sendUserMessage(reply, { deliverAs: "followUp" })
	})
}
