import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FINDING_TEXT_LIMITS, type FindingInput, type ReviewSubmitContext, submitFinding } from "./store.js"

const NOW = () => new Date("2026-11-17T12:00:00Z")

function validFinding(): FindingInput {
	return {
		path: "src/value.ts",
		line: 1,
		title: "The fallback drops valid input",
		description: "Users submitting valid records receive an error instead of the expected saved result.",
		explanation: "Static inspection of parseRecord shows that the empty-object case reaches the rejection branch.",
		suggestion: "Accept the empty-object case before validating optional properties and add a regression test.",
		priority: "P1",
		type: "bug",
	}
}

const textCases = [
	{ field: "title", limit: FINDING_TEXT_LIMITS.title },
	{ field: "description", limit: FINDING_TEXT_LIMITS.description },
	{ field: "explanation", limit: FINDING_TEXT_LIMITS.explanation },
	{ field: "suggestion", limit: FINDING_TEXT_LIMITS.suggestion },
] as const

describe("review-finding/v1 field validation", () => {
	let sandbox: string
	let context: ReviewSubmitContext

	beforeEach(async () => {
		sandbox = mkdtempSync(join(tmpdir(), "kimchi-finding-validation-"))
		const contextDir = join(sandbox, "review-context")
		await mkdir(contextDir, { recursive: true })
		context = { contextDir, outputDir: join(sandbox, "review-output"), writer: "final", now: NOW }
	})

	afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

	function submitRaw(input: Record<string, unknown>) {
		return submitFinding(input as unknown as FindingInput, context)
	}

	function outputText(): string {
		return readFileSync(join(sandbox, "review-output", "findings", "final.jsonl"), "utf8")
	}

	it.each(textCases)("validates $field missing, empty, over-limit, exact-limit, and trimmed values", async ({
		field,
		limit,
	}) => {
		const missing = validFinding() as unknown as Record<string, unknown>
		delete missing[field]
		expect(await submitRaw(missing)).toMatchObject({ accepted: false, reason: "invalid_field", field })

		for (const empty of ["", "   "]) {
			expect(await submitRaw({ ...validFinding(), [field]: empty })).toMatchObject({
				accepted: false,
				field,
				limit,
				actual_length: 0,
			})
		}

		const overLimit = await submitRaw({ ...validFinding(), [field]: "x".repeat(limit + 1) })
		expect(overLimit).toMatchObject({ accepted: false, field, limit, actual_length: limit + 1 })
		expect(overLimit.message).toContain(`actual length is ${limit + 1}`)
		expect(overLimit.message).toContain(`${limit} Unicode code points`)

		const exact = "🙂".repeat(limit)
		expect(await submitRaw({ ...validFinding(), [field]: `  ${exact}  ` })).toMatchObject({ accepted: true })
		const record = JSON.parse(outputText().trim()) as Record<string, unknown>
		expect(record[field]).toBe(exact)
		expect(Array.from(record[field] as string)).toHaveLength(limit)
	})

	it.each([
		"line\nbreak",
		"carriage\rreturn",
		"tab\tseparated",
		"nul\0character",
		"control\u0085character",
		"separator\u2028line",
	])("rejects control characters and multiple lines in title: %s", async (title) => {
		expect(await submitRaw({ ...validFinding(), title })).toMatchObject({
			accepted: false,
			reason: "invalid_field",
			field: "title",
		})
	})

	it("rejects NUL in the other bounded text fields", async () => {
		for (const field of ["description", "explanation", "suggestion"] as const) {
			expect(await submitRaw({ ...validFinding(), [field]: `bad\0${field}` })).toMatchObject({
				accepted: false,
				field,
			})
		}
	})

	it("requires priority and type", async () => {
		for (const field of ["priority", "type"] as const) {
			const missing = validFinding() as unknown as Record<string, unknown>
			delete missing[field]
			expect(await submitRaw(missing)).toMatchObject({ accepted: false, reason: "invalid_field", field })
			expect(await submitRaw({ ...validFinding(), [field]: "" })).toMatchObject({
				accepted: false,
				reason: "invalid_field",
				field,
			})
		}
	})

	it.each([
		{ field: "priority", value: "P5" },
		{ field: "priority", value: "critical" },
		{ field: "type", value: "maintainability" },
	])("rejects the invalid $field enum $value", async ({ field, value }) => {
		const result = await submitRaw({ ...validFinding(), [field]: value })
		expect(result).toMatchObject({ accepted: false, reason: "invalid_field", field })
		expect(result.message).toContain(field)
	})

	it.each([
		{ field: "severity", value: "critical" },
		{ field: "evidence", value: "static" },
	])("rejects the legacy $field field without an alias", async ({ field, value }) => {
		expect(await submitRaw({ ...validFinding(), [field]: value })).toMatchObject({
			accepted: false,
			reason: "invalid_field",
			field,
		})
	})

	it.each([
		{ field: "id", value: "wrong" },
		{ field: "created_at", value: "" },
	])("rejects invalid stored $field before appending", async ({ field, value }) => {
		expect((await submitFinding(validFinding(), context)).accepted).toBe(true)
		const original = JSON.parse(outputText().trim()) as Record<string, unknown>
		const malformed = `${JSON.stringify({ ...original, [field]: value })}\n`
		writeFileSync(join(sandbox, "review-output", "findings", "final.jsonl"), malformed)

		expect(await submitFinding(validFinding(), context)).toMatchObject({ accepted: false, reason: "output_read" })
		expect(outputText()).toBe(malformed)
	})

	it("revalidates stored findings before appending and leaves malformed output unchanged", async () => {
		expect((await submitFinding(validFinding(), context)).accepted).toBe(true)
		const original = JSON.parse(outputText().trim()) as Record<string, unknown>
		const malformed = `${JSON.stringify({ ...original, title: "x".repeat(FINDING_TEXT_LIMITS.title + 1) })}\n`
		writeFileSync(join(sandbox, "review-output", "findings", "final.jsonl"), malformed)

		expect(await submitFinding(validFinding(), context)).toMatchObject({ accepted: false, reason: "output_read" })
		expect(outputText()).toBe(malformed)
	})
})
