import { afterEach, describe, expect, it, vi } from "vitest"
import { EXTRACTION_SYSTEM_PROMPT } from "./capture-worker.js"
import {
	buildValuationState,
	consolidateQuestion,
	consolidateState,
	DECISION_GATE_KINDS,
	decisionGatesEnabled,
	digestQuestion,
	digestState,
	parseDecisionGateFlag,
	recallQuestion,
	recallState,
	supersedeQuestion,
	supersedeState,
	TRIAGE_DURABLE_MIN_P,
	taskLaneEnabled,
	triageQuestions,
	triageVerdict,
	VALUATION_DISCARD_MIN_P,
	VALUATION_STATE,
	valuationQuestion,
} from "./gates.js"

describe("parseDecisionGateFlag", () => {
	it("enables every gate when the env var is absent or empty (default-on)", () => {
		expect([...parseDecisionGateFlag(undefined).enabled]).toEqual([...DECISION_GATE_KINDS])
		expect([...parseDecisionGateFlag("").enabled]).toEqual([...DECISION_GATE_KINDS])
		expect([...parseDecisionGateFlag("  ").enabled]).toEqual([...DECISION_GATE_KINDS])
	})

	it("disables every gate on 'off'", () => {
		expect(parseDecisionGateFlag("off").enabled.size).toBe(0)
		expect(parseDecisionGateFlag(" OFF ").enabled.size).toBe(0)
	})

	it("enables exactly the comma subset, case-insensitively", () => {
		const parsed = parseDecisionGateFlag("valuation,Digest")
		expect([...parsed.enabled].sort()).toEqual(["digest", "valuation"])
		expect(parsed.unknown).toEqual([])
	})

	it("surfaces unknown names without throwing or disabling the valid ones", () => {
		const parsed = parseDecisionGateFlag("valuation,bogus")
		expect([...parsed.enabled]).toEqual(["valuation"])
		expect(parsed.unknown).toEqual(["bogus"])
	})

	it("decisionGatesEnabled reads the process env shape", () => {
		expect([...decisionGatesEnabled({ KIMCHI_MEMORY_DECISION_GATE: "off" }).enabled].length).toBe(0)
		expect([...decisionGatesEnabled({}).enabled].length).toBe(DECISION_GATE_KINDS.length)
	})
})

describe("gate criteria (verbatim, taxonomy-sync)", () => {
	it("pins the triage question set to the 2026-11-12 multi-class replacement", () => {
		const qs = triageQuestions()
		expect(Object.keys(qs).sort()).toEqual([
			"engaged_assistant_answer",
			"insight_worth_future_self",
			"learned_conclusion",
			"plan_or_dated_event",
			"user_stated_durable",
		])
		expect(qs.user_stated_durable.instructions).toBe(
			"Does this snippet contain any USER-STATED durable fact: a stable preference, a decision with rationale, a correction, personal context (role, plans, possessions, constraints), or an itemized value (count, price, date, measurement)?",
		)
		expect(qs.user_stated_durable.criteria).toEqual({ yes: "At least one user-stated durable fact", no: "None" })
		expect(qs.engaged_assistant_answer.instructions).toBe(
			"Does this snippet contain an assistant-provided answer or fact the USER actively engaged with (asked for, accepted, acted on, or referred back to) — e.g. schedules, rotations, recipes, recommendations, numbers the user needed?",
		)
		expect(qs.plan_or_dated_event.instructions).toBe(
			"Does this snippet contain a plan, a scheduled event, or a dated occurrence worth recalling later?",
		)
		expect(qs.learned_conclusion.instructions).toBe(
			"Does this snippet contain a CONCLUSION established from evidence during the session — a failure pattern identified, a procedure/approach validated or invalidated by its observed outcome, a verified mechanic/rule of the environment, or a tactical/strategic lesson — regardless of whether the user or the assistant stated it?",
		)
		expect(qs.insight_worth_future_self.instructions).toContain("FUTURE session")
	})

	it("triageVerdict: skips only when every gate class is below the durable bar", () => {
		const a = (p: number) => ({
			type: "choice" as const,
			choice: "no",
			probabilities: { yes: p, no: 1 - p },
			confidence: 1 - p,
		})
		// one class above the bar → keep, tagged with the carrying class
		const keep = triageVerdict({ learned_conclusion: a(0.96), user_stated_durable: a(0.01) })
		expect(keep.skip).toBe(false)
		expect(keep.maxP).toBeCloseTo(0.96)
		expect(keep.topClass).toBe("learned_conclusion")
		// all four below the bar → skip, with the per-class map attached
		const skip = triageVerdict({
			user_stated_durable: a(0.02),
			engaged_assistant_answer: a(0.2),
			plan_or_dated_event: a(0.05),
			learned_conclusion: a(0.1),
			insight_worth_future_self: a(0.7),
		})
		expect(skip.skip).toBe(true)
		expect(skip.maxP).toBeCloseTo(0.2)
		expect(skip.topClass).toBe("engaged_assistant_answer")
		expect(skip.probabilities.insight_worth_future_self).toBeCloseTo(0.7)
		// the signal question alone must never gate a keep
		expect(
			triageVerdict({
				user_stated_durable: a(0.05),
				engaged_assistant_answer: a(0.05),
				plan_or_dated_event: a(0.05),
				learned_conclusion: a(0.05),
				insight_worth_future_self: a(0.99),
			}).skip,
		).toBe(true)
		// no numeric answers → no skip (unknowns extract, pre-split behavior)
		expect(triageVerdict({}).skip).toBe(false)
	})

	it("triage/valuation criteria cover the extraction prompt's positive categories (sync guard)", () => {
		// Category terms pulled from EXTRACTION_SYSTEM_PROMPT's Include list —
		// if the extraction taxonomy grows a category, this test forces the
		// criteria builders to grow with it (the E5b completeness lesson).
		const prompt = EXTRACTION_SYSTEM_PROMPT
		for (const marker of [
			"stable preferences",
			"decisions",
			"rationale",
			"corrections",
			"personal context",
			"itemized",
		]) {
			expect(prompt, `extraction prompt carries ${marker}`).toContain(marker)
		}
		const triageText = Object.values(triageQuestions())
			.map((q) => `${q.instructions} ${Object.values(q.criteria).join(" ")}`)
			.join(" ")
			.toLowerCase()
		for (const marker of ["itemized value", "assistant-provided", "dated"]) {
			expect(triageText, `triage criteria cover ${marker}`).toContain(marker)
		}
		const valText =
			`${VALUATION_STATE} ${valuationQuestion("f", 0).instructions} ${Object.values(valuationQuestion("f", 0).criteria).join(" ")}`.toLowerCase()
		for (const marker of ["user-stated", "assistant-provided", "itemized value", "dated event"]) {
			expect(valText, `valuation criteria cover ${marker}`).toContain(marker)
		}
	})

	it("pins the digest criteria, including the dated/pairwise extension and the echo clause", () => {
		const q = digestQuestion("some fact", 2)
		expect(q.instructions).toBe(
			`Candidate memory fact 3: "some fact" — would injecting this fact into the session's context materially help answer the user's question?`,
		)
		expect(q.criteria.inject).toContain("carries a date/value/name the question's reasoning needs")
		expect(q.criteria.inject).toContain("inject facts for BOTH sides when present")
		expect(q.criteria.skip).toContain("same-session echo")
	})

	it("pins the recall criteria, including the opaque-identifiers clause from E4's miss", () => {
		const q = recallQuestion().lookup
		expect(q.criteria.search).toContain("opaque identifiers/names (PR numbers, PIDs, project codenames)")
		expect(q.criteria.skip).toContain("fully answerable from the current conversation")
	})

	it("pins the supersede judgement rules to the E7-validated conservative set", () => {
		const q = supersedeQuestion({ id: "abcdef0123456", memory: "I have 38 pre-1920 American coins" })
		expect(q.instructions).toContain("delete only on explicit changed-value evidence")
		expect(q.instructions).toContain("Complementary details are not replacements")
		expect(q.instructions).toContain("later dated fact supersedes an earlier dated one")
		expect(q.instructions).toContain("near-identical restatement is NOT a replacement")
		expect(q.criteria).toEqual({
			delete: "A new fact explicitly replaces this memory's value for the same subject",
			keep: "Complementary detail, different subject/dimension, duplicate restatement, or uncertain — keep it",
		})
	})

	it("pins the consolidation classification to the E7-validated set", () => {
		const q = consolidateQuestion("I use a Suica card for getting around Tokyo", 0)
		expect(Object.keys(q.criteria).sort()).toEqual(["complementary", "exact_twin", "near_twin", "unique"])
	})

	describe("task-lane criterion wording (KIMCHI_MEMORY_TASK_SCOPE)", () => {
		const BASE_USER_STATED =
			"Does this snippet contain any USER-STATED durable fact: a stable preference, a decision with rationale, a correction, personal context (role, plans, possessions, constraints), or an itemized value (count, price, date, measurement)?"
		const BASE_VALUATION_KEEP =
			"Durable from ANY source: user-stated (stable preference, decision with rationale, correction, personal context, possession with purpose, itemized value, dated event/plan) OR assistant-provided fact the user engaged with (asked, accepted, acted on, referred back: schedules, rotations, recipes, numbers, recommendations) OR lasting project convention"

		it("flag OFF: triage + valuation strings stay byte-identical to the calibrated base set", () => {
			vi.stubEnv("KIMCHI_MEMORY_TASK_SCOPE", "")
			try {
				expect(triageQuestions().user_stated_durable.instructions).toBe(BASE_USER_STATED)
				expect(valuationQuestion("f", 0).criteria.keep).toBe(BASE_VALUATION_KEEP)
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("flag ON: triage + valuation accept durable task knowledge", () => {
			vi.stubEnv("KIMCHI_MEMORY_TASK_SCOPE", "1")
			try {
				const triage = triageQuestions().user_stated_durable.instructions
				expect(triage).toContain("TASK facts")
				expect(triage).toContain("schema/identifier")
				expect(triage.startsWith(BASE_USER_STATED.slice(0, 100))).toBe(true)
				const keep = valuationQuestion("f", 0).criteria.keep
				expect(keep).toContain("durable task knowledge")
				expect(keep.startsWith(BASE_VALUATION_KEEP)).toBe(true)
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("taskLaneEnabled parses the env flag like the other gate env reads", () => {
			for (const off of [undefined, "", "0", "false"]) {
				expect(taskLaneEnabled({ KIMCHI_MEMORY_TASK_SCOPE: off } as NodeJS.ProcessEnv)).toBe(false)
			}
			for (const on of ["1", "true", "yes"]) {
				expect(taskLaneEnabled({ KIMCHI_MEMORY_TASK_SCOPE: on } as NodeJS.ProcessEnv)).toBe(true)
			}
		})
	})

	it("valuation discard bar matches the spike's confidence calibration (E2)", () => {
		expect(VALUATION_DISCARD_MIN_P).toBe(0.9)
	})

	describe("gateNoiseClassesEnabled (KIMCHI_MEMORY_GATE_NOISE_CLASSES)", () => {
		afterEach(() => {
			delete process.env.KIMCHI_MEMORY_GATE_NOISE_CLASSES
		})

		it("is OFF by default — valuation criteria stay bit-identical to pre-flag", () => {
			delete process.env.KIMCHI_MEMORY_GATE_NOISE_CLASSES
			const q = valuationQuestion("some fact", 0)
			expect(q.criteria.discard).toBe(
				"Transient: task progress, statuses, work summaries, tool output, or content with no identifiable fact a future session could use",
			)
		})

		it("ON appends the measured harness/evaluation boilerplate classes to discard", () => {
			process.env.KIMCHI_MEMORY_GATE_NOISE_CLASSES = "1"
			const q = valuationQuestion("some fact", 0)
			expect(q.criteria.discard).toContain("harness or evaluation protocol boilerplate")
			expect(q.criteria.discard).toContain("query limits")
			expect(q.criteria.discard).toContain("reply-format rules")
			expect(q.criteria.discard).toContain("question numbering")
			// Keep criteria unchanged — the flag only widens discard (false-rejects
			// are the expensive direction).
			expect(q.criteria.keep).not.toContain("boilerplate")
		})
	})

	describe("buildValuationState (KIMCHI_MEMORY_VALUATION_CONTEXT)", () => {
		afterEach(() => {
			delete process.env.KIMCHI_MEMORY_VALUATION_CONTEXT
		})

		it("OFF: returns the static state regardless of inputs", () => {
			delete process.env.KIMCHI_MEMORY_VALUATION_CONTEXT
			expect(buildValuationState(["existing fact"])).toBe(VALUATION_STATE)
			expect(buildValuationState()).toBe(VALUATION_STATE)
		})

		it("ON with no existing facts: returns the static state (no dangling header)", () => {
			process.env.KIMCHI_MEMORY_VALUATION_CONTEXT = "1"
			expect(buildValuationState([])).toBe(VALUATION_STATE)
			expect(buildValuationState()).toBe(VALUATION_STATE)
		})

		it("ON with existing facts: the state carries the store digest", () => {
			process.env.KIMCHI_MEMORY_VALUATION_CONTEXT = "1"
			const state = buildValuationState(["user prefers pnpm", "typescript project"])
			expect(state).toContain(VALUATION_STATE)
			expect(state).toContain("- user prefers pnpm")
			expect(state).toContain("- typescript project")
			expect(state).toContain("already holds these memories")
		})

		it("ON: caps the digest at VALUATION_CONTEXT_MAX_FACTS", () => {
			process.env.KIMCHI_MEMORY_VALUATION_CONTEXT = "1"
			const state = buildValuationState(Array.from({ length: 150 }, (_, i) => `fact ${i}`))
			expect(state).toContain("- fact 99")
			expect(state).not.toContain("- fact 100")
		})
	})

	it("triage durable bar matches the LongMemEval calibration (E5b/E6)", () => {
		expect(TRIAGE_DURABLE_MIN_P).toBe(0.3)
	})

	it("states carry the request/subject context the questions reference", () => {
		expect(digestState("build a memory dump analyzer")).toBe(
			'The user asks: """build a memory dump analyzer"""\nThe memory store holds the following remembered facts. Decide for each whether it belongs in the injected context.',
		)
		expect(recallState("some facts", "turn text")).toContain("some facts")
		expect(supersedeState(["new fact"], [{ id: "abc", memory: "old fact" }])).toContain("new fact")
		expect(supersedeState(["new fact"], [{ id: "abc", memory: "old fact" }])).toContain("abc: old fact")
		expect(consolidateState(["a", "b"])).toContain("1. a\n2. b")
	})
})
