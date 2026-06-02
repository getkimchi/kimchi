import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { getActiveFerment } from "../ferment/index.js"
import { trackSurveyAnswered, trackSurveyDismissed, trackSurveyShown } from "../telemetry/index.js"
import {
	INITIAL_SURVEY,
	type InitialSurveyAnswerId,
	type InitialSurveyDismissReason,
	type InitialSurveyTrigger,
	hasInitialSurveyBeenSeen,
	showInitialSurvey,
} from "./survey.js"

export interface SurveysExtensionOptions {
	configPath?: string
	now?: () => Date
}

export default function surveysExtension(options: SurveysExtensionOptions = {}) {
	return (pi: ExtensionAPI) => {
		if (hasInitialSurveyBeenSeen(options.configPath)) return

		let standardCodingPromptCount = 0
		let pendingSurveyTrigger: InitialSurveyTrigger | undefined
		let surveyShowing = false
		let surveySeen = false

		const requestSurveyAfterAgent = (trigger: InitialSurveyTrigger) => {
			if (surveySeen) return
			if (!pendingSurveyTrigger) pendingSurveyTrigger = trigger
		}

		const maybeShowSurvey = (ctx: ExtensionContext) => {
			if (surveySeen || surveyShowing || !pendingSurveyTrigger) return
			if (hasInitialSurveyBeenSeen(options.configPath)) {
				surveySeen = true
				pendingSurveyTrigger = undefined
				return
			}
			if (!ctx.hasUI) return
			const trigger = pendingSurveyTrigger
			surveyShowing = true
			const submissionId = randomUUID()
			void showInitialSurvey(ctx, {
				configPath: options.configPath,
				now: options.now,
				trigger,
				onShown: (shownTrigger) => trackSurveyShown({ survey: INITIAL_SURVEY, trigger: shownTrigger }),
				onAnswered: (answerId: InitialSurveyAnswerId, answeredTrigger) =>
					trackSurveyAnswered({
						survey: INITIAL_SURVEY,
						answerId,
						submissionId,
						trigger: answeredTrigger,
					}),
				onDismissed: (reason: InitialSurveyDismissReason, dismissedTrigger) =>
					trackSurveyDismissed({
						survey: INITIAL_SURVEY,
						reason,
						trigger: dismissedTrigger,
					}),
			})
				.catch((err: unknown) => {
					ctx.ui.notify(`Survey failed: ${err instanceof Error ? err.message : String(err)}`, "warning")
				})
				.then((shown) => {
					if (shown) {
						surveySeen = true
						if (pendingSurveyTrigger === trigger) pendingSurveyTrigger = undefined
					}
				})
				.finally(() => {
					surveyShowing = false
				})
		}

		pi.on("session_start", () => {
			standardCodingPromptCount = 0
			pendingSurveyTrigger = undefined
		})

		pi.on("tool_execution_end", (event) => {
			const e = event as { toolName?: string; isError?: boolean }
			if (e.toolName === "complete_ferment" && e.isError !== true) {
				requestSurveyAfterAgent("ferment_completed")
			}
		})

		pi.on("input", (event) => {
			if (isStandardCodingUserPrompt(event)) {
				standardCodingPromptCount += 1
				if (standardCodingPromptCount === 3) requestSurveyAfterAgent("third_coding_prompt")
			}
		})

		pi.on("agent_end", (_event, ctx) => {
			maybeShowSurvey(ctx)
		})
	}
}

function isStandardCodingUserPrompt(event: InputEvent): boolean {
	if (event.source !== "interactive" && event.source !== "rpc") return false
	if (getActiveFerment() !== undefined) return false
	const text = event.text.trimStart()
	return text.length > 0 && !text.startsWith("/")
}
