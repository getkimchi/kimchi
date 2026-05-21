import { Value } from "typebox/value"
import { describe, expect, it } from "vitest"
import { ProposeScopingParams } from "./tool-schemas.js"

const passingPlanGates = () => [
	{ id: "P1", verdict: "pass" as const, rationale: "Every phase has a concrete verify signal.", evidence: "plan" },
	{ id: "P2", verdict: "pass" as const, rationale: "The phase ordering is valid.", evidence: "plan" },
	{ id: "P3", verdict: "pass" as const, rationale: "Success criteria map to verifiable work.", evidence: "plan" },
]

const simpleTodoOnePhasePayload = {
	ferment_id: "f-todo",
	title: "Create a TODO app",
	goal: "Build a functional, responsive TODO application with add, edit, delete, complete, filtering, and persistence.",
	success_criteria:
		"Users can add, edit, delete, complete, and filter todos. Todos persist across reloads. The app works on mobile and desktop.",
	constraints: ["Single-page browser app", "No backend required", "Use localStorage for persistence"],
	assumptions: ["Browser-based app", "Single-user use case", "Standard TODO UX is acceptable"],
	phases: [
		{
			name: "TODO App Vertical Slice",
			goal: "Build and verify the complete TODO app end to end in one cohesive slice.",
			steps: [
				{ description: "Create the HTML/CSS/JS project structure and render the initial TODO interface" },
				{ description: "Implement add, edit, delete, complete, and filter behavior" },
				{ description: "Persist todos in localStorage and restore them on load" },
				{ description: "Polish responsive layout and run a final smoke test" },
			],
		},
	],
	questions: [],
	gates: passingPlanGates(),
}

const thoroughQuestionsTodoPayload = {
	...simpleTodoOnePhasePayload,
	ferment_id: "f-todo-thorough",
	title: "Create a TODO app with thorough questions",
	assumptions: [
		"User asked for thorough questions, but no decision-blocking uncertainty is present",
		"Thoroughness is captured in assumptions, success criteria, constraints, and verification steps",
		"Static browser app, vanilla JavaScript, localStorage persistence, and basic MVP scope are safe defaults",
	],
	questions: [],
}

const manualRunTwoPhasePayload = {
	ferment_id: "f-manual",
	title: "Create a TODO app",
	goal: "Build a visually polished TODO app using Vanilla JavaScript and Tailwind CSS.",
	success_criteria:
		"Users can add, edit, delete, complete, and filter todos. Todos persist across reloads and the UI is responsive.",
	constraints: ["Single-page application with no backend", "Vanilla JavaScript only", "Tailwind CSS for styling"],
	assumptions: [
		"Browser-based web app",
		"Standard TODO app UX patterns are acceptable",
		"Tailwind CSS can be included via CDN for simplicity",
	],
	phases: [
		{
			name: "Project Setup & Core CRUD",
			goal: "Create the HTML file, wire up Tailwind CSS, and implement full CRUD for todos.",
			steps: [
				{ description: "Create index.html with Tailwind CSS CDN, basic layout, and script tag" },
				{ description: "Implement todo state array and DOM rendering function to display todos" },
				{ description: "Wire up add, toggle complete, edit, and delete handlers" },
			],
		},
		{
			name: "Filtering, Persistence & Polish",
			goal: "Add filters, localStorage persistence, empty states, and responsive refinements.",
			steps: [
				{ description: "Add All/Active/Completed filter buttons" },
				{ description: "Implement localStorage read on load and write after state changes" },
				{ description: "Add empty states and responsive styling" },
			],
		},
	],
	gates: passingPlanGates(),
}

describe("Ferment scoping benchmark cases", () => {
	it("accepts a simple TODO app as one vertical-slice phase", () => {
		expect(Value.Check(ProposeScopingParams, simpleTodoOnePhasePayload)).toBe(true)
		expect(simpleTodoOnePhasePayload.questions).toEqual([])
		expect(simpleTodoOnePhasePayload.assumptions).toContain("Browser-based app")
		expect(simpleTodoOnePhasePayload.assumptions).toContain("Standard TODO UX is acceptable")
	})

	it("treats a request to be thorough with TODO questions as no-question defaults", () => {
		expect(Value.Check(ProposeScopingParams, thoroughQuestionsTodoPayload)).toBe(true)
		expect(thoroughQuestionsTodoPayload.questions).toEqual([])
		expect(thoroughQuestionsTodoPayload.assumptions).toContain(
			"Thoroughness is captured in assumptions, success criteria, constraints, and verification steps",
		)
		expect(thoroughQuestionsTodoPayload.assumptions.join("\n")).toContain("safe defaults")
	})

	it("accepts the observed manual-run payload shape with assumptions as an array", () => {
		expect(Value.Check(ProposeScopingParams, manualRunTwoPhasePayload)).toBe(true)
	})

	it("schema guidance nudges one-phase simple plans and discourages artificial phase splitting", () => {
		const schemaText = JSON.stringify(ProposeScopingParams)

		expect(schemaText).toContain('"minItems":1')
		expect(schemaText).toContain("Default to ONE phase for simple tasks")
		expect(schemaText).toContain("decision-blocking uncertainty")
		expect(schemaText).toContain("be thorough in assumptions, success criteria, constraints, and verification steps")
		expect(schemaText).toContain("Do not ask about defaults you can safely choose")
		expect(schemaText).toContain("single-select question")
		expect(schemaText).toContain("outcome boundary")
		expect(schemaText).toContain("risk/tradeoff")
		expect(schemaText).toContain("verification standard")
		expect(schemaText).toContain("feature-shopping questions")
		expect(schemaText).toContain("tech stack, platform, persistence, or extra features")
		expect(schemaText).toContain("vertical slice/tracer bullet")
		expect(schemaText).toContain("Do not create phases just for setup")
		expect(schemaText).toContain("CRUD vs polish")
		expect(schemaText).not.toContain('"minItems":3')
		expect(schemaText).not.toContain("3-7 ordered phase")
		expect(schemaText).not.toContain("at least 3 phases")
	})
})
