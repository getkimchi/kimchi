import type { TelemetryContext } from "./session-context.js"

type SurveyAttrs = Record<string, string | number | boolean>
type SurveyOption = SurveyTelemetryDefinition["options"][number]

const surveyIDAttr = "survey_id"
const surveySubmissionIDAttr = "survey_submission_id"
const questionIDAttr = "question_id"
const answerValueAttr = "answer_value"
const questionID2Attr = "question_id_2"
const answerValue2Attr = "answer_value_2"
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
	/** Option ID resolved via the survey's `options` label lookup. Ignored when `answerValue` is set. */
	answerId?: string
	submissionId: string
	/**
	 * Raw answer value sent verbatim, skipping the `options` lookup — for
	 * free-form (open) questions where no options exist.
	 */
	answerValue?: string
	/** Optional response to a second question on the same survey, emitted as `question_id_2` / `answer_value_2`. */
	secondResponse?: { questionId: string; answerValue: string }
	/** Flow-specific attributes spread verbatim into the emitted record. */
	extraAttrs?: SurveyAttrs
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

export function emitSurveyShown(ctx: TelemetryContext, args: SurveyShownTelemetry): void {
	ctx.emit("survey_shown", commonSurveyAttrs(args))
}

export function emitSurveyAnswered(ctx: TelemetryContext, args: SurveyAnsweredTelemetry): void {
	const answerValue = resolveAnswerValue(args)
	if (answerValue === undefined) return

	ctx.emit("survey_answered", {
		...commonSurveyAttrs(args),
		[surveySubmissionIDAttr]: args.submissionId,
		[questionIDAttr]: args.survey.question.id,
		[answerValueAttr]: answerValue,
		...(args.secondResponse && {
			[questionID2Attr]: args.secondResponse.questionId,
			[answerValue2Attr]: args.secondResponse.answerValue,
		}),
		[surveyCompletedAttr]: true,
		...(args.extraAttrs ?? {}),
	})
}

function resolveAnswerValue(args: SurveyAnsweredTelemetry): string | undefined {
	if (args.answerValue !== undefined) return args.answerValue
	if (args.answerId === undefined) return undefined
	const answer = args.survey.options.find((option) => option.id === args.answerId)
	return answer ? surveyResponseValue(answer) : undefined
}

export function emitSurveyDismissed(ctx: TelemetryContext, args: SurveyDismissedTelemetry): void {
	ctx.emit("survey_dismissed", commonSurveyAttrs(args))
}
