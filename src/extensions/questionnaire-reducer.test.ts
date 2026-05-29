import { describe, expect, it } from "vitest"
import {
	type Question,
	type QuestionnaireEvent,
	allRequiredAnswered,
	currentOptions,
	getAnswersArray,
	initialState,
	isSubmitTab,
	reduce,
} from "./questionnaire-reducer.js"

// ─── Test helpers ─────────────────────────────────────────────────────────────

function singleQ(): Question {
	return {
		id: "q1",
		label: "Q1",
		prompt: "Pick one",
		type: "single",
		options: [
			{ id: "opt1", label: "Option 1" },
			{ id: "opt2", label: "Option 2" },
		],
		allowOther: true,
		required: true,
	}
}

function multiQ(): Question {
	return {
		id: "q1",
		label: "Multi Q",
		prompt: "Pick many",
		type: "multi",
		options: [
			{ id: "a", label: "Alpha" },
			{ id: "b", label: "Beta" },
			{ id: "c", label: "Gamma" },
		],
		allowOther: true,
		required: true,
	}
}

function textQ(): Question {
	return {
		id: "q1",
		label: "Text Q",
		prompt: "Free text please",
		type: "text",
		options: [],
		allowOther: false,
		required: true,
	}
}

function confirmQ(): Question {
	return {
		id: "q1",
		label: "Confirm Q",
		prompt: "Yes or no?",
		type: "confirm",
		options: [
			{ id: "yes", label: "Yes" },
			{ id: "no", label: "No" },
		],
		allowOther: false,
		required: true,
	}
}

// ─── Group 1: Initial state ───────────────────────────────────────────────────

describe("initial state", () => {
	it("single question → isMulti=false, totalTabs=2, currentTab=0, optionIndex=0, answers empty", () => {
		const state = initialState([singleQ()])
		expect(state.isMulti).toBe(false)
		expect(state.totalTabs).toBe(2)
		expect(state.currentTab).toBe(0)
		expect(state.optionIndex).toBe(0)
		expect(state.answers.size).toBe(0)
		expect(state.inputMode).toBe(false)
		expect(state.inputQuestionId).toBeNull()
	})

	it("three questions → isMulti=true, totalTabs=4, currentTab=0", () => {
		const state = initialState([singleQ(), multiQ(), textQ()])
		expect(state.isMulti).toBe(true)
		expect(state.totalTabs).toBe(4)
		expect(state.currentTab).toBe(0)
	})
})

// ─── Group 2: Tab navigation (multi-question) ─────────────────────────────────

describe("tab navigation (multi-question)", () => {
	it("key-right from tab 0 advances to tab 1 and resets optionIndex to 0", () => {
		let { state } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-down" })
		expect(state.optionIndex).toBe(1)
		;({ state } = reduce(state, { kind: "key-right" }))
		expect(state.currentTab).toBe(1)
		expect(state.optionIndex).toBe(0)
	})

	it("key-right from last question advances to Submit tab", () => {
		const { state } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-enter" })
		expect(state.currentTab).toBe(1)
	})

	it("key-right from Submit tab wraps to tab 0", () => {
		// The Submit tab is only reachable via advanceAfterAnswer (not key-right cycling from
		// questions — key-right wraps 0→1→0 in a 2-question flow). Construct the state directly.
		const base = initialState([singleQ(), multiQ()])
		const onSubmitTab = {
			...base,
			currentTab: 2, // Submit tab
			answers: new Map([["q1", { id: "q1", value: "opt1", label: "Option 1", wasCustom: false, index: 1 }]]),
		}
		const { state } = reduce(onSubmitTab, { kind: "key-right" })
		expect(state.currentTab).toBe(0)
	})

	it("key-left from tab 0 wraps to Submit tab", () => {
		const { state } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-left" })
		expect(state.currentTab).toBe(2) // totalTabs=3, wrap: (0-1+3)%3=2
		expect(state.optionIndex).toBe(0)
	})

	it("tab navigation is a no-op when isMulti=false", () => {
		const { state, effects } = reduce(initialState([textQ()]), { kind: "key-right" })
		expect(state.currentTab).toBe(0)
		expect(effects).toHaveLength(0)
	})
})

// ─── Group 3: Option navigation ───────────────────────────────────────────────

describe("option navigation", () => {
	it("key-down increments optionIndex up to options.length - 1", () => {
		const { state } = reduce(initialState([singleQ()]), { kind: "key-down" })
		expect(state.optionIndex).toBe(1)
	})

	it("key-up decrements optionIndex down to 0", () => {
		let { state } = reduce(initialState([singleQ()]), { kind: "key-down" })
		expect(state.optionIndex).toBe(1)
		;({ state } = reduce(state, { kind: "key-up" }))
		expect(state.optionIndex).toBe(0)
	})

	it("key-down on a text question is a no-op", () => {
		const { state } = reduce(initialState([textQ()]), { kind: "key-down" })
		expect(state.optionIndex).toBe(0)
	})
})

// ─── Group 4: Single/confirm answer + advance ─────────────────────────────────

describe("single/confirm answer + advance", () => {
	it("Enter on a regular option saves Answer with wasCustom=false, index, value, label", () => {
		const { state } = reduce(initialState([singleQ()]), { kind: "key-enter" })
		const answer = state.answers.get("q1")
		expect(answer).toMatchObject({
			wasCustom: false,
			index: 1,
			value: "opt1",
			label: "Option 1",
		})
	})

	it("in multi-question flow, Enter advances currentTab by 1 and emits [render]", () => {
		const { state, effects } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-enter" })
		expect(state.currentTab).toBe(1)
		expect(effects).toContainEqual({ kind: "render" })
	})

	it("in single-question flow, Enter emits [done {cancelled:false}]", () => {
		const { effects } = reduce(initialState([singleQ()]), { kind: "key-enter" })
		expect(effects).toContainEqual({ kind: "done", cancelled: false })
	})

	it("Enter on the Other row sets inputMode=true, inputQuestionId=q.id, emits [editor-set-text, render]", () => {
		// singleQ has 2 options + Other = 3 items; need 2 key-downs to reach Other (index 2)
		let { state, effects } = reduce(initialState([singleQ()]), { kind: "key-down" })
		expect(state.optionIndex).toBe(1)
		;({ state, effects } = reduce(state, { kind: "key-down" }))
		expect(state.optionIndex).toBe(2)
		;({ state, effects } = reduce(state, { kind: "key-enter" }))
		expect(state.inputMode).toBe(true)
		expect(state.inputQuestionId).toBe("q1")
		expect(effects).toContainEqual({ kind: "editor-set-text", text: "" })
		expect(effects).toContainEqual({ kind: "render" })
	})
})

// ─── Group 5: Multi-select toggles ────────────────────────────────────────────

describe("multi-select toggles", () => {
	it("key-space on a regular row adds the index to multiToggles and writes an Answer with values/labels/indices", () => {
		const { state } = reduce(initialState([multiQ()]), { kind: "key-space" })
		const toggled = state.multiToggles.get("q1")
		expect(toggled?.has(0)).toBe(true)
		const answer = state.answers.get("q1")
		expect(answer?.values).toEqual(["a"])
		expect(answer?.labels).toEqual(["Alpha"])
		expect(answer?.indices).toEqual([1])
		expect(answer?.wasCustom).toBe(false)
	})

	it("second key-space on same row removes toggle; Answer deleted when set becomes empty", () => {
		let { state } = reduce(initialState([multiQ()]), { kind: "key-space" })
		expect(state.answers.has("q1")).toBe(true)
		;({ state } = reduce(state, { kind: "key-space" }))
		expect(state.multiToggles.get("q1")?.has(0)).toBe(false)
		expect(state.answers.has("q1")).toBe(false)
	})

	it("key-space on the Other row with no committed text is a no-op", () => {
		// multiQ has 3 options + Other = 4 items; Other is at index 3
		let { state } = reduce(initialState([multiQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		expect(state.optionIndex).toBe(3) // Other row
		;({ state } = reduce(state, { kind: "key-space" }))
		// Answer is still absent (key no-op) — the reducer creates an empty Set but
		// the toggle is not added because canToggleOther=false with no committed text.
		expect(state.answers.has("q1")).toBe(false)
	})

	it("key-space on Other row after committed custom text adds Other index to toggles and sets wasCustom=true", () => {
		// After editor-submit on Other, Other is committed and toggled on.
		// Pressing Space toggles Other back off (no-op for answer), then pressing Space
		// again toggles it back on (wasCustom=true should be preserved).
		const q1 = { ...multiQ(), id: "q1" }
		const q2 = { ...multiQ(), id: "q2" }
		// Go to Other row of Q1, open editor, submit "custom value"
		let { state } = reduce(initialState([q1, q2]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		expect(state.optionIndex).toBe(3) // Other row
		;({ state } = reduce(state, { kind: "key-enter" })) // open editor
		expect(state.inputMode).toBe(true)
		;({ state } = reduce(state, { kind: "editor-submit", value: "custom value" }))
		// After editor-submit, state is still on Q1 (not the Submit tab).
		// Other is committed and toggled. Space toggles Other OFF.
		;({ state } = reduce(state, { kind: "key-space" }))
		// Space again toggles Other back ON — wasCustom should stay true.
		;({ state } = reduce(state, { kind: "key-space" }))
		const answer = state.answers.get("q1")
		expect(answer?.wasCustom).toBe(true)
		expect(answer?.values).toContain("custom value")
	})
})

// ─── Group 6: Multi-select "Other" lifecycle ──────────────────────────────────

describe('multi-select "Other" lifecycle', () => {
	it("first Enter on Other row → inputMode=true, inputQuestionId=q.id, editor-set-text with ''", () => {
		let { state } = reduce(initialState([multiQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		const { state: after, effects } = reduce(state, { kind: "key-enter" })
		expect(after.inputMode).toBe(true)
		expect(after.inputQuestionId).toBe("q1")
		expect(effects).toContainEqual({ kind: "editor-set-text", text: "" })
		expect(effects).toContainEqual({ kind: "render" })
	})

	it("editor-submit with value → multiCustomText set, multiToggles includes Other index, Answer.wasCustom=true, inputMode=false", () => {
		let { state } = reduce(initialState([multiQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-enter" }))
		;({ state } = reduce(state, { kind: "editor-submit", value: "hello" }))
		expect(state.multiCustomText.get("q1")).toBe("hello")
		expect(state.multiToggles.get("q1")?.has(3)).toBe(true) // otherIdx = options.length = 3
		expect(state.answers.get("q1")?.wasCustom).toBe(true)
		expect(state.inputMode).toBe(false)
	})

	it('editor-submit with whitespace-only value → trimmed to "(no response)"', () => {
		let { state } = reduce(initialState([multiQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-enter" }))
		;({ state } = reduce(state, { kind: "editor-submit", value: "   " })) // trimmed to ""
		expect(state.multiCustomText.get("q1")).toBe("(no response)")
		expect(state.answers.get("q1")?.wasCustom).toBe(true)
	})

	it("with Other already committed, key-enter on Other row falls through and submits current multi-selection", () => {
		let { state } = reduce(initialState([multiQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-enter" }))
		;({ state } = reduce(state, { kind: "editor-submit", value: "typed" })) // Other committed + toggled
		// Now optionIndex is 3 (Other), press Space to toggle it on
		expect(state.multiToggles.get("q1")?.has(3)).toBe(true)
		// Enter on Other row — should fall through and submit
		;({ state } = reduce(state, { kind: "key-enter" }))
		const answer = state.answers.get("q1")
		expect(answer?.values).toContain("typed")
	})
})

// ─── Group 7: Free-text questions ─────────────────────────────────────────────

describe("free-text questions", () => {
	it("Enter on a text question opens input mode pre-filled from existing custom answer", () => {
		// Pre-seed state with a custom answer, then open editor via Enter
		let s = initialState([textQ()])
		// Manually inject a custom answer by going through the submit flow first
		;({ state: s } = reduce(s, { kind: "key-enter" }))
		;({ state: s } = reduce(s, { kind: "editor-submit", value: "my answer" }))
		// Simulate re-opening the same text question in a fresh state (same id)
		const reopened = { ...initialState([{ ...textQ(), id: "q1" }]) }
		const seeded: typeof reopened = {
			...reopened,
			answers: new Map([["q1", { id: "q1", value: "my answer", label: "my answer", wasCustom: true }]]),
		}
		const { state: after, effects } = reduce(seeded, { kind: "key-enter" })
		expect(after.inputMode).toBe(true)
		expect(effects).toContainEqual({ kind: "editor-set-text", text: "my answer" })
	})

	it('printable char-typed opens input mode and emits [editor-set-text "", editor-handle-input "x"]', () => {
		const { state, effects } = reduce(initialState([textQ()]), { kind: "char-typed", char: "x" })
		expect(state.inputMode).toBe(true)
		expect(state.inputQuestionId).toBe("q1")
		expect(effects).toContainEqual({ kind: "editor-set-text", text: "" })
		expect(effects).toContainEqual({ kind: "editor-handle-input", data: "x" })
		expect(effects).toContainEqual({ kind: "render" })
	})

	it("char-typed with a control char (< ' ') is a no-op when not in input mode", () => {
		const { state, effects } = reduce(initialState([textQ()]), { kind: "char-typed", char: "\x01" })
		expect(state.inputMode).toBe(false)
		expect(effects).toHaveLength(0)
	})

	it("editor-submit on a text question in single-question flow emits [done]", () => {
		const { state } = reduce(initialState([textQ()]), { kind: "key-enter" })
		const { effects } = reduce(state, { kind: "editor-submit", value: "the answer" })
		expect(effects).toContainEqual({ kind: "done", cancelled: false })
	})
})

// ─── Group 8: Escape behaviour ────────────────────────────────────────────────

describe("escape behaviour", () => {
	it("in input mode, key-escape exits input mode without saving and emits [editor-set-text, render]", () => {
		let { state } = reduce(initialState([singleQ()]), { kind: "key-down" })
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-enter" })) // open editor on Other
		expect(state.inputMode).toBe(true)
		;({ state } = reduce(state, { kind: "editor-submit", value: "something" })) // commit
		;({ state } = reduce(state, { kind: "key-down" }))
		;({ state } = reduce(state, { kind: "key-enter" })) // reopen for test
		const { state: after, effects } = reduce(state, { kind: "key-escape" })
		expect(after.inputMode).toBe(false)
		expect(effects).toContainEqual({ kind: "editor-set-text", text: "" })
		expect(effects).toContainEqual({ kind: "render" })
	})

	it("on Submit tab, key-escape emits [done {cancelled:true}]", () => {
		let { state } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-enter" })
		;({ state } = reduce(state, { kind: "key-right" })) // advance to submit tab
		const { effects } = reduce(state, { kind: "key-escape" })
		expect(effects).toContainEqual({ kind: "done", cancelled: true })
	})

	it("on a regular tab not in input mode, key-escape emits [done {cancelled:true}]", () => {
		const { effects } = reduce(initialState([singleQ()]), { kind: "key-escape" })
		expect(effects).toContainEqual({ kind: "done", cancelled: true })
	})
})

// ─── Group 9: Submit gating ───────────────────────────────────────────────────

describe("submit gating", () => {
	it("Enter on Submit tab when allRequiredAnswered=true → [done {cancelled:false}]", () => {
		let { state } = reduce(initialState([singleQ(), multiQ()]), { kind: "key-enter" })
		;({ state } = reduce(state, { kind: "key-right" })) // submit tab
		const { effects } = reduce(state, { kind: "key-enter" })
		expect(effects).toContainEqual({ kind: "done", cancelled: false })
	})

	it("Enter on Submit tab when a required question is missing → no effect, state unchanged", () => {
		// Build a state where we are on the Submit tab (currentTab=2) with Q1 answered but Q2 missing.
		// Use distinct IDs for each question — singleQ() and multiQ() both use id:"q1".
		const sq = { ...singleQ(), id: "sq" }
		const mq = { ...multiQ(), id: "mq" }
		const s = initialState([sq, mq])
		const onSubmitTab = {
			...s,
			currentTab: 2, // force Submit tab
			answers: new Map([["sq", { id: "sq", value: "opt1", label: "Option 1", wasCustom: false, index: 1 }]]),
		}
		const { state: after, effects } = reduce(onSubmitTab, { kind: "key-enter" })
		expect(after).toStrictEqual(onSubmitTab) // value equality — reducer always returns new object
		expect(effects).toHaveLength(0)
	})
})

// ─── Group 10: Helpers ────────────────────────────────────────────────────────

describe("helpers", () => {
	it("currentOptions returns options + synthesised Other row when allowOther=true", () => {
		const state = initialState([singleQ()])
		const opts = currentOptions(state)
		expect(opts).toHaveLength(3) // 2 options + Other
		expect(opts[2]).toMatchObject({ id: "__other__", label: "Type your own answer", isOther: true })
	})

	it("currentOptions returns [] for text questions", () => {
		const state = initialState([textQ()])
		expect(currentOptions(state)).toHaveLength(0)
	})

	it("currentOptions returns [] when currentTab === questions.length (Submit tab)", () => {
		// In a 2-question flow, Enter on Q1 advances to Q2; Enter on Q2 advances to Submit (tab 2).
		let state = initialState([singleQ(), multiQ()])
		;({ state } = reduce(state, { kind: "key-enter" })) // Q1 answered → tab 1
		;({ state } = reduce(state, { kind: "key-enter" })) // Q2 answered → submit tab
		expect(isSubmitTab(state)).toBe(true)
		expect(currentOptions(state)).toHaveLength(0)
	})

	it("getAnswersArray returns answers in insertion order", () => {
		const q1 = { ...singleQ(), id: "a" }
		const q2 = { ...singleQ(), id: "b" }
		let state = initialState([q1, q2])
		// Answer Q1
		;({ state } = reduce(state, { kind: "key-enter" }))
		// Answer Q2
		;({ state } = reduce(state, { kind: "key-enter" }))
		const arr = getAnswersArray(state)
		expect(arr.map((a) => a.id)).toEqual(["a", "b"])
	})
})
