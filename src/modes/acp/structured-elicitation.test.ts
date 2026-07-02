import { describe, expect, it } from "vitest"
import { choiceSchema, confirmSchema, freeTextSchema } from "./structured-elicitation.js"

const OPTIONS = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta" },
	{ id: "c", label: "Gamma" },
]

describe("structured elicitation schema builders", () => {
	it("builds a required single-choice value schema", () => {
		expect(choiceSchema(OPTIONS, true, false)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					oneOf: [
						{ const: "a", title: "Alpha" },
						{ const: "b", title: "Beta" },
						{ const: "c", title: "Gamma" },
					],
				},
			},
			required: ["value"],
		})
	})

	it("builds an optional multi-choice value schema", () => {
		expect(choiceSchema(OPTIONS, false, true)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "array",
					items: {
						anyOf: [
							{ const: "a", title: "Alpha" },
							{ const: "b", title: "Beta" },
							{ const: "c", title: "Gamma" },
						],
					},
				},
			},
			required: [],
		})
	})

	it("adds minItems to required multi-choice schemas", () => {
		expect(choiceSchema(OPTIONS, true, true)).toMatchObject({
			properties: {
				value: {
					minItems: 1,
				},
			},
			required: ["value"],
		})
	})

	it("builds text value schemas with optional descriptions", () => {
		expect(freeTextSchema(true, "Enter your name")).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					description: "Enter your name",
				},
			},
			required: ["value"],
		})

		expect(freeTextSchema(false)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
			required: [],
		})

		expect(freeTextSchema(true, "")).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					description: "",
				},
			},
			required: ["value"],
		})
	})

	it("builds the confirm schema", () => {
		expect(confirmSchema()).toEqual({
			type: "object",
			properties: {
				confirmed: {
					type: "boolean",
					default: false,
				},
			},
			required: ["confirmed"],
		})
	})
})
