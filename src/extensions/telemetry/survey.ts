import type { SessionContext } from "./session-context.js"

type SurveyAttrs = Record<string, string | number>

export interface SurveyTelemetryDefinition {
	id: string
	version: number
	question: {
		id: string
		text: string
		help?: string
	}
	options: readonly {
		id: string
		label: string
		score?: number
	}[]
}

export interface SurveyShownTelemetry {
	survey: SurveyTelemetryDefinition
	impressionId: string
	trigger?: string
}

export interface SurveyAnsweredTelemetry extends SurveyShownTelemetry {
	answerId: string
}

export interface SurveyDismissedTelemetry extends SurveyShownTelemetry {
	reason?: string
}

function commonSurveyAttrs(args: SurveyShownTelemetry): SurveyAttrs {
	return {
		impression_id: args.impressionId,
		survey_id: args.survey.id,
		survey_version: args.survey.version,
		...(args.trigger ? { trigger: args.trigger } : {}),
		question_id: args.survey.question.id,
		question_text: args.survey.question.text,
		...(args.survey.question.help ? { question_help: args.survey.question.help } : {}),
	}
}

export function emitSurveyShown(ctx: SessionContext, args: SurveyShownTelemetry): void {
	ctx.emit("survey_shown", commonSurveyAttrs(args))
}

export function emitSurveyAnswered(ctx: SessionContext, args: SurveyAnsweredTelemetry): void {
	const answer = args.survey.options.find((option) => option.id === args.answerId)
	if (!answer) return

	ctx.emit("survey_answered", {
		...commonSurveyAttrs(args),
		answer_id: answer.id,
		answer_label: answer.label,
		...(answer.score !== undefined ? { answer_score: answer.score } : {}),
	})
}

export function emitSurveyDismissed(ctx: SessionContext, args: SurveyDismissedTelemetry): void {
	ctx.emit("survey_dismissed", {
		...commonSurveyAttrs(args),
		dismiss_reason: args.reason ?? "dismissed",
	})
}
