/**
 * TypeBox schema validation tests for ProposeScopingParams and related schemas.
 * Uses typebox/value Value.Check for structural validation.
 */

import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import {
	AskUserParams,
	CompleteStepParams,
	ConfirmCompletionCriteriaParams,
	ProposeScopingParams,
	ScopeParams,
} from "./tool-schemas.js"

// Minimal valid payload fixtures
const passingGates = () => [
	{ id: "P1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]

const minimalPhases = () => [{ name: "P1", goal: "Phase 1 goal", steps: [{ description: "Step 1" }] }]

describe("ProposeScopingParams schema", () => {
	it("accepts full payload with questions", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Auth System",
			goal: "Users can log in with OAuth",
			success_criteria: ["E2E tests pass"],
			constraints: ["no external auth libs"],
			assumptions: "k8s cluster provisioned",
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					question: "Which OAuth provider first?",
					options: [
						{ id: "google", label: "Google", recommended: true },
						{ id: "github", label: "GitHub" },
					],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts single, multi, confirm, and text scoping question styles", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "ship",
					type: "confirm",
					question: "Ship this as a yes/no decision?",
				},
				{
					id: "surfaces",
					type: "multi",
					question: "Which surfaces must be included?",
					options: [
						{ id: "cli", label: "CLI" },
						{ id: "docs", label: "Docs" },
					],
				},
				{
					id: "approach",
					type: "single",
					question: "Which approach?",
					options: [
						{ id: "a", label: "A", recommended: true },
						{ id: "b", label: "B" },
					],
				},
				{
					id: "acceptance",
					type: "text",
					question: "What exact acceptance phrase should be used?",
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("rejects the old radio/checkbox vocabulary", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "surfaces",
					type: "checkbox",
					question: "Which surfaces?",
					options: [
						{ id: "cli", label: "CLI" },
						{ id: "docs", label: "Docs" },
					],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(false)
	})

	it("accepts payload without questions (questions is optional)", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts payload without ferment_id (ferment_id is optional)", () => {
		const payload = {
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("documents improvement selection as a multi scoping question", () => {
		const questionsSchema = (ProposeScopingParams as unknown as { properties: { questions: unknown } }).properties
			.questions
		const schemaText = JSON.stringify(questionsSchema)

		expect(schemaText).toContain("multiple plausible work areas")
		expect(schemaText).toContain("ask one multi question")
		expect(schemaText).toContain("Which improvement areas should this ferment include?")
	})

	it("rejects payload without title", () => {
		const payload = {
			ferment_id: "f-123",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(false)
	})

	it("accepts stringified phases/questions as a defensive fallback", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: JSON.stringify(minimalPhases()),
			questions: JSON.stringify([
				{
					id: "q1",
					question: "Which first?",
					options: [
						{ id: "a", label: "A", recommended: true },
						{ id: "b", label: "B" },
					],
				},
			]),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts assumptions as a real string array compatibility fallback", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			assumptions: ["Go toolchain is installed", "The current directory is writable"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts success criteria as a real string array", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass", "Manual smoke works"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("rejects missing or empty success criteria", () => {
		const basePayload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, basePayload)).toBe(false)
		expect(Value.Check(ProposeScopingParams, { ...basePayload, success_criteria: [] })).toBe(false)
	})

	it("allows too-few options through schema so runtime can return a focused validation error", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					question: "Only one option?",
					options: [{ id: "a", label: "Only option" }],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("allows empty options through schema so runtime can return a focused validation error", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					question: "No options?",
					options: [],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts question as the canonical schema field", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					question: "Which path?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("rejects prompt at the schema boundary", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					prompt: "Which path?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(false)
	})

	it("allows more than 3 questions through schema so runtime can return a focused validation error", () => {
		const question = (id: string) => ({
			id,
			question: `Question ${id}`,
			options: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
		})

		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [question("q1"), question("q2"), question("q3"), question("q4")],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("accepts a single phase for simple tasks (minItems: 1)", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})

	it("rejects more than 7 phases (maxItems: 7)", () => {
		const phases = Array.from({ length: 8 }, (_, i) => ({
			name: `P${i + 1}`,
			goal: `Phase ${i + 1} goal`,
			steps: [{ description: "Step" }],
		}))

		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases,
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(false)
	})

	it("allows more than 5 options through schema so runtime can return a focused validation error", () => {
		const payload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: minimalPhases(),
			questions: [
				{
					id: "q1",
					question: "Too many choices?",
					options: [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
						{ id: "c", label: "C" },
						{ id: "d", label: "D" },
						{ id: "e", label: "E" },
						{ id: "f", label: "F" },
					],
				},
			],
			gates: passingGates(),
		}

		expect(Value.Check(ProposeScopingParams, payload)).toBe(true)
	})
})

describe("ScopeParams schema", () => {
	it("rejects payload without title", () => {
		const payload = {
			ferment_id: "f-123",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: [{ name: "Build", goal: "Implement" }],
			gates: passingGates(),
		}

		expect(Value.Check(ScopeParams, payload)).toBe(false)
	})

	it("accepts assumptions as either text or a string array", () => {
		const basePayload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			success_criteria: ["Tests pass"],
			phases: [{ name: "Build", goal: "Implement" }],
			gates: passingGates(),
		}

		expect(Value.Check(ScopeParams, { ...basePayload, assumptions: "Go is installed" })).toBe(true)
		expect(Value.Check(ScopeParams, { ...basePayload, assumptions: ["Go is installed", "Repo is writable"] })).toBe(
			true,
		)
	})

	it("accepts success criteria as an array and rejects legacy text", () => {
		const basePayload = {
			ferment_id: "f-123",
			title: "Test Ferment",
			goal: "Do something",
			phases: [{ name: "Build", goal: "Implement" }],
			gates: passingGates(),
		}

		expect(Value.Check(ScopeParams, { ...basePayload, success_criteria: "Tests pass" })).toBe(false)
		expect(Value.Check(ScopeParams, { ...basePayload, success_criteria: ["Tests pass", "Smoke works"] })).toBe(true)
	})
})

describe("CompleteStepParams schema", () => {
	it("accepts S2 smoke verdict as a defensive alias before gate normalization", () => {
		const payload = {
			ferment_id: "f-123",
			phase_id: "phase-1",
			step_id: "step-1",
			summary: "done",
			gates: [
				{ id: "S1", verdict: "pass", rationale: "ok", evidence: "n/a" },
				{ id: "S2", verdict: "smoke", rationale: "ran a smoke check", evidence: "browser run" },
				{ id: "S3", verdict: "pass", rationale: "ok", evidence: "n/a" },
			],
		}

		expect(Value.Check(CompleteStepParams, payload)).toBe(true)
	})
})

describe("AskUserParams schema", () => {
	const base = (questions: unknown) => ({ ferment_id: "f-1", questions })

	it("accepts confirm response_type for the top-level shorthand", () => {
		const payload = {
			ferment_id: "f-1",
			question:
				"I'll consider this done when the script continuously prints CPU temperature and exits cleanly. Sound right?",
			response_type: "confirm",
		}
		expect(Value.Check(AskUserParams, payload)).toBe(true)
	})

	it("accepts the single/multi/text/confirm question vocabulary", () => {
		const payload = base([
			{ id: "approach", type: "single", prompt: "Which?", options: [{ id: "a", label: "A" }] },
			{ id: "areas", type: "multi", prompt: "Which areas?", options: [{ id: "x", label: "X" }] },
			{ id: "note", type: "text", prompt: "Anything else?" },
			{ id: "ship", type: "confirm", prompt: "Ship behind a flag?" },
		])
		expect(Value.Check(AskUserParams, payload)).toBe(true)
	})

	it("accepts a custom otherLabel for allowOther questions", () => {
		const payload = base([
			{
				id: "changes",
				type: "single",
				prompt: "Any additions or changes?",
				options: [{ id: "no", label: "No" }],
				allowOther: true,
				otherLabel: "Yes (Type in your answer)",
			},
		])
		expect(Value.Check(AskUserParams, payload)).toBe(true)
	})

	// LLM-1928: the original failure was ask_user.questions[].type using the
	// wrong vocabulary. These types must now be rejected at the schema layer.
	it("rejects the old radio vocabulary in questions[].type", () => {
		const payload = base([{ id: "approach", type: "radio", prompt: "Which?", options: [{ id: "a", label: "A" }] }])
		expect(Value.Check(AskUserParams, payload)).toBe(false)
	})

	it("rejects the old checkbox vocabulary in questions[].type", () => {
		const payload = base([
			{ id: "areas", type: "checkbox", prompt: "Which areas?", options: [{ id: "x", label: "X" }] },
		])
		expect(Value.Check(AskUserParams, payload)).toBe(false)
	})

	it("rejects an invented question type", () => {
		const payload = base([{ id: "ship", type: "confirmation", prompt: "Ship?" }])
		expect(Value.Check(AskUserParams, payload)).toBe(false)
	})
})

describe("ConfirmCompletionCriteriaParams schema", () => {
	it("accepts non-empty criteria", () => {
		const payload = {
			ferment_id: "f-1",
			criteria: ["README.md exists and documents usage; verify with manual read-through."],
		}

		expect(Value.Check(ConfirmCompletionCriteriaParams, payload)).toBe(true)
	})

	it("rejects empty criteria", () => {
		const payload = {
			ferment_id: "f-1",
			criteria: [],
		}

		expect(Value.Check(ConfirmCompletionCriteriaParams, payload)).toBe(false)
	})
})
