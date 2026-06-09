/**
 * Questionnaire reducer — pure state machine.
 *
 * Extracted from `questionnaire.ts` so that keyboard routing, tab
 * navigation, multi-select toggles and the Editor lifecycle can be
 * unit-tested independently of the TUI runtime.
 *
 * The reducer is dependency-free: it takes a `QuestionnaireState` plus an
 * input `QuestionnaireEvent` and returns the next state together with a
 * list of `QuestionnaireEffect`s the host must perform (render request,
 * editor mutation, completion). The host (the `ctx.ui.custom` factory in
 * `questionnaire.ts`) is responsible for translating raw keyboard data
 * into events and applying the resulting effects against the live
 * `tui`/`editor`/`done` references.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type QuestionType = "single" | "multi" | "text" | "confirm"

export interface QuestionOption {
	id: string
	label: string
	description?: string
}

export const YES_NO_OPTIONS: readonly QuestionOption[] = [
	{ id: "yes", label: "Yes" },
	{ id: "no", label: "No" },
]

export interface Question {
	id: string
	label: string
	prompt: string
	type: QuestionType
	options: QuestionOption[]
	allowOther: boolean
	otherLabel?: string
	required: boolean
}

export type RenderOption = QuestionOption & { isOther?: boolean }

export interface Answer {
	id: string
	value: string
	label: string
	wasCustom: boolean
	index?: number
	// multi-select fields
	values?: string[]
	labels?: string[]
	indices?: number[]
}

export interface QuestionnaireState {
	questions: Question[]
	isMulti: boolean
	totalTabs: number
	currentTab: number
	optionIndex: number
	inputMode: boolean
	inputQuestionId: string | null
	answers: ReadonlyMap<string, Answer>
	multiToggles: ReadonlyMap<string, ReadonlySet<number>>
	multiCustomText: ReadonlyMap<string, string>
}

export type QuestionnaireEvent =
	| { kind: "key-up" }
	| { kind: "key-down" }
	| { kind: "key-left" }
	| { kind: "key-right" }
	| { kind: "key-enter" }
	| { kind: "key-escape" }
	| { kind: "key-space" }
	| { kind: "char-typed"; char: string }
	| { kind: "editor-submit"; value: string }
	| { kind: "select-option"; index: number }

export type QuestionnaireEffect =
	| { kind: "render" }
	| { kind: "editor-set-text"; text: string }
	| { kind: "editor-handle-input"; data: string }
	| { kind: "done"; cancelled: boolean }

export interface ReduceResult {
	state: QuestionnaireState
	effects: QuestionnaireEffect[]
}

// ─── Initial state ───────────────────────────────────────────────────────────

export function initialState(questions: Question[]): QuestionnaireState {
	const isMulti = questions.length > 1
	return {
		questions,
		isMulti,
		totalTabs: questions.length + 1,
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		inputQuestionId: null,
		answers: new Map(),
		multiToggles: new Map(),
		multiCustomText: new Map(),
	}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function currentQuestion(state: QuestionnaireState): Question | undefined {
	return state.questions[state.currentTab]
}

export function currentOptions(state: QuestionnaireState): RenderOption[] {
	const q = currentQuestion(state)
	if (!q || q.type === "text") return []
	const opts: RenderOption[] = [...q.options]
	if (q.allowOther) {
		opts.push({ id: "__other__", label: q.otherLabel ?? "Type your own answer", isOther: true })
	}
	return opts
}

export function allRequiredAnswered(state: QuestionnaireState): boolean {
	return state.questions.every((q) => !q.required || state.answers.has(q.id))
}

export function isSubmitTab(state: QuestionnaireState): boolean {
	return state.currentTab === state.questions.length
}

export function getAnswersArray(state: QuestionnaireState): Answer[] {
	return Array.from(state.answers.values())
}

// ─── Internal helpers (do not export) ────────────────────────────────────────

function cloneAnswers(answers: ReadonlyMap<string, Answer>): Map<string, Answer> {
	return new Map(answers)
}

function cloneToggles(toggles: ReadonlyMap<string, ReadonlySet<number>>): Map<string, Set<number>> {
	const out = new Map<string, Set<number>>()
	for (const [k, v] of toggles) out.set(k, new Set(v))
	return out
}

function cloneCustomText(text: ReadonlyMap<string, string>): Map<string, string> {
	return new Map(text)
}

interface MutableState {
	questions: Question[]
	isMulti: boolean
	totalTabs: number
	currentTab: number
	optionIndex: number
	inputMode: boolean
	inputQuestionId: string | null
	answers: Map<string, Answer>
	multiToggles: Map<string, Set<number>>
	multiCustomText: Map<string, string>
}

function toMutable(state: QuestionnaireState): MutableState {
	return {
		questions: state.questions,
		isMulti: state.isMulti,
		totalTabs: state.totalTabs,
		currentTab: state.currentTab,
		optionIndex: state.optionIndex,
		inputMode: state.inputMode,
		inputQuestionId: state.inputQuestionId,
		answers: cloneAnswers(state.answers),
		multiToggles: cloneToggles(state.multiToggles),
		multiCustomText: cloneCustomText(state.multiCustomText),
	}
}

function freeze(s: MutableState): QuestionnaireState {
	return s
}

function mutableCurrentQuestion(s: MutableState): Question | undefined {
	return s.questions[s.currentTab]
}

function mutableCurrentOptions(s: MutableState): RenderOption[] {
	const q = mutableCurrentQuestion(s)
	if (!q || q.type === "text") return []
	const opts: RenderOption[] = [...q.options]
	if (q.allowOther) {
		opts.push({ id: "__other__", label: q.otherLabel ?? "Type your own answer", isOther: true })
	}
	return opts
}

function mutableAllRequiredAnswered(s: MutableState): boolean {
	return s.questions.every((q) => !q.required || s.answers.has(q.id))
}

function saveAnswer(
	s: MutableState,
	questionId: string,
	value: string,
	label: string,
	wasCustom: boolean,
	index?: number,
): void {
	s.answers.set(questionId, { id: questionId, value, label, wasCustom, index })
}

function saveMultiAnswer(s: MutableState, q: Question): void {
	const toggled = s.multiToggles.get(q.id) ?? new Set<number>()
	const values: string[] = []
	const labels: string[] = []
	const indices: number[] = []
	for (const idx of toggled) {
		if (idx < q.options.length) {
			values.push(q.options[idx].id)
			labels.push(q.options[idx].label)
			indices.push(idx + 1)
		}
	}
	const otherIdx = q.options.length
	const customText = s.multiCustomText.get(q.id)
	const otherToggled = toggled.has(otherIdx) && !!customText
	if (otherToggled && customText) {
		values.push(customText)
		labels.push(customText)
		indices.push(otherIdx + 1)
	}
	if (values.length > 0) {
		s.answers.set(q.id, {
			id: q.id,
			value: values.join(", "),
			label: labels.join(", "),
			wasCustom: otherToggled,
			values,
			labels,
			indices,
		})
	} else {
		s.answers.delete(q.id)
	}
}

/**
 * Advance after a single-answer (single/confirm/text/multi-submit) commit.
 *
 * In a single-question flow this emits a `done` effect and leaves the state
 * untouched (the overlay will unmount). In a multi-question flow it moves to
 * the next question, or to the Submit tab if this was the last question.
 */
function advanceAfterAnswer(s: MutableState, effects: QuestionnaireEffect[]): void {
	if (!s.isMulti) {
		effects.push({ kind: "done", cancelled: false })
		return
	}
	if (s.currentTab < s.questions.length - 1) {
		s.currentTab++
	} else {
		s.currentTab = s.questions.length // Submit tab
	}
	s.optionIndex = 0
	effects.push({ kind: "render" })
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function reduce(state: QuestionnaireState, event: QuestionnaireEvent): ReduceResult {
	const s = toMutable(state)
	const effects: QuestionnaireEffect[] = []

	// ── Editor submit (fires from Editor.onSubmit regardless of input mode) ──
	if (event.kind === "editor-submit") {
		if (!s.inputQuestionId) {
			return { state: freeze(s), effects }
		}
		const trimmed = event.value.trim() || "(no response)"
		const q = s.questions.find((x) => x.id === s.inputQuestionId)
		if (q?.type === "multi") {
			s.multiCustomText.set(q.id, trimmed)
			if (!s.multiToggles.has(q.id)) s.multiToggles.set(q.id, new Set())
			s.multiToggles.get(q.id)?.add(q.options.length)
			saveMultiAnswer(s, q)
			s.inputMode = false
			s.inputQuestionId = null
			effects.push({ kind: "editor-set-text", text: "" })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		if (s.inputQuestionId) {
			saveAnswer(s, s.inputQuestionId, trimmed, trimmed, true)
		}
		s.inputMode = false
		s.inputQuestionId = null
		effects.push({ kind: "editor-set-text", text: "" })
		advanceAfterAnswer(s, effects)
		return { state: freeze(s), effects }
	}

	// ── Input mode: editor owns most keys ──────────────────────────────────
	if (s.inputMode) {
		if (event.kind === "key-escape") {
			s.inputMode = false
			s.inputQuestionId = null
			effects.push({ kind: "editor-set-text", text: "" })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		// Map any other event to a raw editor input. For key-* events we forward
		// the canonical escape sequences/characters; the host's `handleInput`
		// already calls `editor.handleInput(data)` directly in input mode, so
		// most paths never reach this branch. We expose it for completeness
		// (e.g. char-typed during input mode is forwarded transparently).
		if (event.kind === "char-typed") {
			effects.push({ kind: "editor-handle-input", data: event.char })
		}
		effects.push({ kind: "render" })
		return { state: freeze(s), effects }
	}

	const q = mutableCurrentQuestion(s)
	const opts = mutableCurrentOptions(s)

	// ── Tab navigation (multi-question only) ───────────────────────────────
	if (s.isMulti) {
		if (event.kind === "key-right") {
			s.currentTab = (s.currentTab + 1) % s.totalTabs
			s.optionIndex = 0
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		if (event.kind === "key-left") {
			s.currentTab = (s.currentTab - 1 + s.totalTabs) % s.totalTabs
			s.optionIndex = 0
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
	}

	// ── Submit tab ─────────────────────────────────────────────────────────
	if (s.currentTab === s.questions.length) {
		if (event.kind === "key-enter" && mutableAllRequiredAnswered(s)) {
			effects.push({ kind: "done", cancelled: false })
			return { state: freeze(s), effects }
		}
		if (event.kind === "key-escape") {
			effects.push({ kind: "done", cancelled: true })
			return { state: freeze(s), effects }
		}
		return { state: freeze(s), effects }
	}

	// ── Text question (no options): enter input mode on Enter or printable ─
	if (q && q.type === "text") {
		if (event.kind === "key-enter") {
			s.inputMode = true
			s.inputQuestionId = q.id
			const existing = s.answers.get(q.id)
			effects.push({ kind: "editor-set-text", text: existing?.wasCustom ? existing.value : "" })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		if (event.kind === "key-escape") {
			effects.push({ kind: "done", cancelled: true })
			return { state: freeze(s), effects }
		}
		// Start typing immediately. Single-char printable input.
		if (event.kind === "char-typed" && event.char.length === 1 && event.char >= " ") {
			s.inputMode = true
			s.inputQuestionId = q.id
			effects.push({ kind: "editor-set-text", text: "" })
			effects.push({ kind: "editor-handle-input", data: event.char })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		return { state: freeze(s), effects }
	}

	// ── Option navigation ──────────────────────────────────────────────────
	if (event.kind === "key-up") {
		s.optionIndex = Math.max(0, s.optionIndex - 1)
		effects.push({ kind: "render" })
		return { state: freeze(s), effects }
	}
	if (event.kind === "key-down") {
		s.optionIndex = Math.min(opts.length - 1, s.optionIndex + 1)
		effects.push({ kind: "render" })
		return { state: freeze(s), effects }
	}

	// ── Multi-select: Space toggles ────────────────────────────────────────
	if (q && q.type === "multi" && event.kind === "key-space") {
		if (!s.multiToggles.has(q.id)) s.multiToggles.set(q.id, new Set())
		const toggled = s.multiToggles.get(q.id) ?? new Set<number>()
		const opt = opts[s.optionIndex]
		// Other rows can be toggled with Space only after a custom value has been
		// typed (or pre-existing).
		const canToggleOther = opt?.isOther && s.multiCustomText.has(q.id)
		if (opt && (!opt.isOther || canToggleOther)) {
			if (toggled.has(s.optionIndex)) {
				toggled.delete(s.optionIndex)
			} else {
				toggled.add(s.optionIndex)
			}
			saveMultiAnswer(s, q)
			effects.push({ kind: "render" })
		}
		return { state: freeze(s), effects }
	}

	// ── Multi-select: Enter on the Other row, no committed text yet ────────
	// Opens the free-text editor. When Other already has text AND is toggled
	// on, fall through so Enter advances/submits like the regular rows.
	if (q && q.type === "multi" && event.kind === "key-enter" && opts[s.optionIndex]?.isOther) {
		const toggled = s.multiToggles.get(q.id) ?? new Set<number>()
		const otherIdx = q.options.length
		const committed = s.multiCustomText.has(q.id) && toggled.has(otherIdx)
		if (!committed) {
			s.inputMode = true
			s.inputQuestionId = q.id
			effects.push({ kind: "editor-set-text", text: s.multiCustomText.get(q.id) ?? "" })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
	}

	// ── Multi-select: Enter submits current selections ─────────────────────
	if (q && q.type === "multi" && event.kind === "key-enter") {
		saveMultiAnswer(s, q)
		advanceAfterAnswer(s, effects)
		return { state: freeze(s), effects }
	}

	// ── Single/confirm: Enter selects ──────────────────────────────────────
	if (event.kind === "key-enter" && q) {
		const opt = opts[s.optionIndex]
		if (opt?.isOther) {
			s.inputMode = true
			s.inputQuestionId = q.id
			effects.push({ kind: "editor-set-text", text: "" })
			effects.push({ kind: "render" })
			return { state: freeze(s), effects }
		}
		if (opt) {
			saveAnswer(s, q.id, opt.id, opt.label, false, s.optionIndex + 1)
			advanceAfterAnswer(s, effects)
		}
		return { state: freeze(s), effects }
	}

	// ── Number-key direct selection ───────────────────────────────────────
	// Pressing 1-9 jumps directly to that option (1-based).
	// For single/confirm: immediately confirms the selection.
	// For multi: moves focus to that option and toggles it.
	if (event.kind === "select-option" && q) {
		const idx = event.index
		if (idx >= 0 && idx < opts.length) {
			s.optionIndex = idx
			const opt = opts[idx]
			if (q.type === "multi") {
				// Toggle like Space, but skip Other (requires typed text first)
				if (opt && !opt.isOther) {
					if (!s.multiToggles.has(q.id)) s.multiToggles.set(q.id, new Set())
					const toggled = s.multiToggles.get(q.id) ?? new Set<number>()
					if (toggled.has(idx)) {
						toggled.delete(idx)
					} else {
						toggled.add(idx)
					}
					saveMultiAnswer(s, q)
				}
			} else {
				// single / confirm: confirm immediately (skip Other)
				if (opt && !opt.isOther) {
					saveAnswer(s, q.id, opt.id, opt.label, false, idx + 1)
					advanceAfterAnswer(s, effects)
					return { state: freeze(s), effects }
				}
			}
			effects.push({ kind: "render" })
		}
		return { state: freeze(s), effects }
	}

	// ── Cancel ─────────────────────────────────────────────────────────────
	if (event.kind === "key-escape") {
		effects.push({ kind: "done", cancelled: true })
		return { state: freeze(s), effects }
	}

	return { state: freeze(s), effects }
}
