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
	taskLaneEnabled,
	recallQuestion,
	recallState,
	supersedeQuestion,
	supersedeState,
	TRIAGE_DURABLE_MIN_P,
	triageQuestion,
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
	it("pins the triage criteria to the E5b-validated text", () => {
		const q = triageQuestion().has_durable_fact
		expect(q.instructions).toBe(
			"Does this snippet contain at least one DURABLE fact worth capturing to long-term memory? Durable sources are: (a) USER-STATED facts — stable preferences, decisions with rationale, corrections, personal context (role, family, plans, possessions, constraints), itemized values (counts, prices, dates, measurements) — each occurrence of recurring items as its own fact; (b) ASSISTANT-PROVIDED answers the user engaged with — the user asked a question it answers, or accepted/acted on/referred back to it (schedules, rotations, recipes, recommendations, numbers); (c) plans and dated events. NOT durable: small talk with no fact content, code/file contents, generic advice the user never engaged with.",
		)
		expect(q.criteria).toEqual({
			yes: "At least one durable fact is present",
			no: "Nothing durable — only transient content",
		})
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
		const triageText =
			`${triageQuestion().has_durable_fact.instructions} ${Object.values(triageQuestion().has_durable_fact.criteria).join(" ")}`.toLowerCase()
		for (const marker of ["itemized values", "assistant-provided", "dated events"]) {
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
		const BASE_TRIAGE =
			"Does this snippet contain at least one DURABLE fact worth capturing to long-term memory? Durable sources are: (a) USER-STATED facts — stable preferences, decisions with rationale, corrections, personal context (role, family, plans, possessions, constraints), itemized values (counts, prices, dates, measurements) — each occurrence of recurring items as its own fact; (b) ASSISTANT-PROVIDED answers the user engaged with — the user asked a question it answers, or accepted/acted on/referred back to it (schedules, rotations, recipes, recommendations, numbers); (c) plans and dated events. NOT durable: small talk with no fact content, code/file contents, generic advice the user never engaged with."
		const BASE_VALUATION_KEEP =
			"Durable from ANY source: user-stated (stable preference, decision with rationale, correction, personal context, possession with purpose, itemized value, dated event/plan) OR assistant-provided fact the user engaged with (asked, accepted, acted on, referred back: schedules, rotations, recipes, numbers, recommendations) OR lasting project convention"

		it("flag OFF: triage + valuation strings stay byte-identical to the calibrated base set", () => {
			vi.stubEnv("KIMCHI_MEMORY_TASK_SCOPE", "")
			try {
				expect(triageQuestion().has_durable_fact.instructions).toBe(BASE_TRIAGE)
				expect(valuationQuestion("f", 0).criteria.keep).toBe(BASE_VALUATION_KEEP)
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("flag ON: triage + valuation accept durable task knowledge", () => {
			vi.stubEnv("KIMCHI_MEMORY_TASK_SCOPE", "1")
			try {
				const triage = triageQuestion().has_durable_fact.instructions
				expect(triage).toContain("DURABLE TASK facts")
				expect(triage).toContain("schema/identifier")
				expect(triage.startsWith(BASE_TRIAGE.slice(0, 100))).toBe(true)
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
