// ACP regression for questionnaire choice elicitation.
//
// The questionnaire tool should use structured ACP elicitation for choices.
// It must not collect ordinary multi-select choices through a generic
// free-text input field. If a selected option needs free text (the current
// questionnaire vocabulary represents this with allowOther), that free-text
// prompt should be a second elicitation after the structured choice response.

import type { ClientCapabilities, CreateElicitationResponse } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const ELICITATION_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const OPTIONS = [
	{ id: "a", label: "A" },
	{ id: "b", label: "B" },
	{ id: "c", label: "C" },
	{ id: "d", label: "D" },
]

describe("ACP integration — questionnaire structured elicitation regression", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	async function runQuestionnaireScenario(options: {
		artifactName: string
		question: QuestionnaireQuestion
		answer: CreateElicitationResponse
		userPrompt: string
	}) {
		fixture = await startAcpFixture({
			artifactName: options.artifactName,
			responses: [questionnaireResponse(options.question), { stream: ["done"] }],
			clientCapabilities: ELICITATION_CAPABILITIES,
		})
		fixture.client.answerNextElicitationWith(options.answer)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, options.userPrompt)
		return { result, client: fixture.client }
	}

	it(
		"normal multi-select choices use structured elicitation, not free-text input",
		async () => {
			const { result, client } = await runQuestionnaireScenario({
				artifactName: "questionnaire-choice-structured",
				question: {
					id: "choice",
					prompt: "Pick the options to implement.",
					allowOther: false,
				},
				answer: { action: "accept", content: { value: ["a", "b"] } },
				userPrompt: "Ask me which options to implement.",
			})

			expect(result.stopReason).toBe("end_turn")
			expect(client.permissionRequests, "questionnaire is not a permission request").toEqual([])
			expect(client.elicitationRequests, "normal choices should be one structured elicitation").toHaveLength(1)

			const valueField = valueFieldOf(client.elicitationRequests[0].params)
			expect(valueField).toEqual({
				type: "array",
				items: {
					anyOf: [
						{ const: "a", title: "A" },
						{ const: "b", title: "B" },
						{ const: "c", title: "C" },
						{ const: "d", title: "D" },
					],
				},
				minItems: 1,
			})
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"free-text follow-up is a second elicitation only after selecting Other",
		async () => {
			const { client } = await runQuestionnaireScenario({
				artifactName: "questionnaire-choice-custom-followup",
				question: {
					id: "choice",
					prompt: "Pick the options to implement.",
					allowOther: true,
				},
				answer: { action: "accept", content: { value: ["a", "__other__"] } },
				userPrompt: "Ask me which options to implement.",
			})

			expect(client.permissionRequests, "questionnaire is not a permission request").toEqual([])
			expect(client.elicitationRequests, "Other selection should split choice and text input").toHaveLength(2)

			const choiceField = valueFieldOf(client.elicitationRequests[0].params)
			expect(choiceField).toMatchObject({
				type: "array",
				items: {
					anyOf: expect.arrayContaining([{ const: "__other__", title: "Type your own answer" }]),
				},
			})

			const followUpField = valueFieldOf(client.elicitationRequests[1].params)
			expect(followUpField).toMatchObject({ type: "string" })
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"free-form-only choices use one string elicitation without a synthetic choice step",
		async () => {
			const { client } = await runQuestionnaireScenario({
				artifactName: "questionnaire-choice-free-form-only",
				question: {
					id: "choice",
					type: "single",
					prompt: "Describe the option to implement.",
					options: [],
					allowOther: true,
				},
				answer: { action: "accept", content: { value: "custom option" } },
				userPrompt: "Ask me what option to implement.",
			})

			expect(client.permissionRequests, "questionnaire is not a permission request").toEqual([])
			expect(client.elicitationRequests, "free-form-only questions should be one text elicitation").toHaveLength(1)
			expect(valueFieldOf(client.elicitationRequests[0].params)).toEqual({ type: "string" })
		},
		STARTUP_TIMEOUT_MS,
	)
})

interface QuestionnaireQuestion {
	id: string
	prompt: string
	allowOther: boolean
	type?: "single" | "multi"
	options?: typeof OPTIONS
}

function questionnaireResponse(question: QuestionnaireQuestion) {
	return {
		stream: ["I'll ask a structured question."],
		toolCalls: [
			{
				function: {
					name: "questionnaire",
					arguments: JSON.stringify({
						questions: [
							{
								id: question.id,
								type: question.type ?? "multi",
								prompt: question.prompt,
								options: question.options ?? OPTIONS,
								allowOther: question.allowOther,
							},
						],
					}),
				},
			},
		],
	}
}

function valueFieldOf(params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object") throw new Error("elicitation params must be an object")
	const schema = (params as { requestedSchema?: { properties?: Record<string, unknown> } }).requestedSchema
	const value = schema?.properties?.value
	if (!value || typeof value !== "object") throw new Error("elicitation schema must include a value field")
	return value as Record<string, unknown>
}
