import type { SessionContext } from "./session-context.js"

type SurveyAttrs = Record<string, string | number | boolean>
type SurveyOption = SurveyTelemetryDefinition["options"][number]

const surveyIDAttr = "survey_id"
const surveySubmissionIDAttr = "survey_submission_id"
const questionIDAttr = "question_id"
const answerValueAttr = "answer_value"
const surveyCompletedAttr = "survey_completed"

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
	trigger?: string
}

export interface SurveyAnsweredTelemetry extends SurveyShownTelemetry {
	answerId: string
	submissionId: string
}

export interface SurveyDismissedTelemetry extends SurveyShownTelemetry {
	reason?: string
}

function commonSurveyAttrs(args: SurveyShownTelemetry): SurveyAttrs {
	return {
		[surveyIDAttr]: args.survey.id,
	}
}

function surveyResponseValue(answer: SurveyOption): string {
	return answer.label
}

export function emitSurveyShown(ctx: SessionContext, args: SurveyShownTelemetry): void {
	ctx.emit("survey_shown", commonSurveyAttrs(args))
}

export function emitSurveyAnswered(ctx: SessionContext, args: SurveyAnsweredTelemetry): void {
	const answer = args.survey.options.find((option) => option.id === args.answerId)
	if (!answer) return

	ctx.emit("survey_answered", {
		...commonSurveyAttrs(args),
		[surveySubmissionIDAttr]: args.submissionId,
		[questionIDAttr]: args.survey.question.id,
		[answerValueAttr]: surveyResponseValue(answer),
		[surveyCompletedAttr]: true,
	})
}

export function emitSurveyDismissed(ctx: SessionContext, args: SurveyDismissedTelemetry): void {
	ctx.emit("survey_dismissed", commonSurveyAttrs(args))
}
