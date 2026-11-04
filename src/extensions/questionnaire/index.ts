// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export type { QuestionFormResult } from "./questionnaire-form.js"
export { createQuestionForm } from "./questionnaire-form.js"
export type { Answer, Question, QuestionType } from "./questionnaire-reducer.js"
export { YES_NO_OPTIONS } from "./questionnaire-reducer.js"

import { default as questionnaireExtension } from "./questionnaire.js"

export { normalizeQuestionType } from "./questionnaire.js"
export default questionnaireExtension
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
