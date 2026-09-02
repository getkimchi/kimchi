export type { QuestionFormResult } from "./questionnaire-form.js"
export { createQuestionForm } from "./questionnaire-form.js"
export type { Answer, Question, QuestionType } from "./questionnaire-reducer.js"
export { YES_NO_OPTIONS } from "./questionnaire-reducer.js"

import { default as questionnaireExtension } from "./questionnaire.js"

export { normalizeQuestionType } from "./questionnaire.js"
export default questionnaireExtension
