import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { getAgentStructuredOutput, runAsAgentWorker } from "../../agent-worker-context.js"
import { PLAN_REVIEW_SUBMIT_TOOL } from "../../agents/personas/types.js"
import { PLAN_REVIEW_PROVENANCE_FIELD, verifyPlanReviewToken } from "../plan-review-provenance.js"
import { PlanReviewSchema } from "../tool-schemas.js"
import { registerPlanReviewTool } from "./plan-review.js"

interface RegisteredTool {
	name: string
	parameters: unknown
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { text: string }[]; isError?: boolean }>
}

function errText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (!result.isError) throw new Error(`Expected error result, got ok: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function okText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (result.isError) throw new Error(`Expected ok result, got error: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function createPlanReviewHarness() {
	const tools = new Map<string, RegisteredTool>()
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool)
		},
	} as unknown as ExtensionAPI

	registerPlanReviewTool(pi)

	const tool = tools.get(PLAN_REVIEW_SUBMIT_TOOL)
	if (!tool) throw new Error(`${PLAN_REVIEW_SUBMIT_TOOL} was not registered`)

	return { tools, tool }
}

const APPROVED_PAYLOAD = {
	status: "approved" as const,
	summary: "Plan is solid.",
	required_changes: [],
	reservations: [],
	questions: [],
}

const NEEDS_REVISION_PAYLOAD = {
	status: "needs_revision" as const,
	summary: "Several issues found.",
	required_changes: ["Fix the data model", "Add error handling"],
	reservations: [],
	questions: [],
}

describe("registerPlanReviewTool — registration", () => {
	it("registers a tool with name PLAN_REVIEW_SUBMIT_TOOL", () => {
		const { tool } = createPlanReviewHarness()
		expect(tool.name).toBe(PLAN_REVIEW_SUBMIT_TOOL)
	})

	it("registers with parameters equal to PlanReviewSchema", () => {
		const { tool } = createPlanReviewHarness()
		expect(tool.parameters).toEqual(PlanReviewSchema)
	})
})

describe("registerPlanReviewTool — execute: approved path", () => {
	it("returns ok (not isError) for a valid approved payload with empty required_changes", async () => {
		const { tool } = createPlanReviewHarness()

		const result = await runAsAgentWorker(() =>
			tool.execute("tool-call-1", APPROVED_PAYLOAD as unknown as Record<string, unknown>),
		)

		expect(result.isError).toBeFalsy()
		expect(okText(result)).toContain("submitted")
	})

	it("captures the approved payload as structuredOutput after execute", async () => {
		const { tool } = createPlanReviewHarness()
		let captured: unknown

		await runAsAgentWorker(async () => {
			await tool.execute("tool-call-1", APPROVED_PAYLOAD as unknown as Record<string, unknown>)
			captured = getAgentStructuredOutput()
		})

		// Captured verdict carries the original fields plus a valid provenance token.
		expect(captured).toMatchObject(APPROVED_PAYLOAD)
		expect(verifyPlanReviewToken((captured as Record<string, unknown>)[PLAN_REVIEW_PROVENANCE_FIELD])).toBe(true)
	})
})

describe("registerPlanReviewTool — execute: semantic rejection cases", () => {
	it("returns isError true for needs_revision with empty required_changes", async () => {
		const { tool } = createPlanReviewHarness()
		const badPayload = {
			status: "needs_revision" as const,
			summary: "Something is wrong.",
			required_changes: [],
			reservations: [],
			questions: [],
		}

		const result = await runAsAgentWorker(() =>
			tool.execute("tool-call-2", badPayload as unknown as Record<string, unknown>),
		)

		expect(result.isError).toBe(true)
		expect(errText(result)).toMatch(/required_changes/)
	})

	it("does NOT capture structuredOutput when needs_revision with empty required_changes is rejected", async () => {
		const { tool } = createPlanReviewHarness()
		const badPayload = {
			status: "needs_revision" as const,
			summary: "Something is wrong.",
			required_changes: [],
			reservations: [],
			questions: [],
		}
		let captured: unknown = "sentinel"

		await runAsAgentWorker(async () => {
			await tool.execute("tool-call-2", badPayload as unknown as Record<string, unknown>)
			captured = getAgentStructuredOutput()
		})

		expect(captured).toBeUndefined()
	})

	it("returns isError true for approved with non-empty required_changes", async () => {
		const { tool } = createPlanReviewHarness()
		const badPayload = {
			status: "approved" as const,
			summary: "Looks fine.",
			required_changes: ["this contradicts approved"],
			reservations: [],
			questions: [],
		}

		const result = await runAsAgentWorker(() =>
			tool.execute("tool-call-3", badPayload as unknown as Record<string, unknown>),
		)

		expect(result.isError).toBe(true)
		expect(errText(result)).toMatch(/required_changes/)
	})

	it("does NOT capture structuredOutput when approved with non-empty required_changes is rejected", async () => {
		const { tool } = createPlanReviewHarness()
		const badPayload = {
			status: "approved" as const,
			summary: "Looks fine.",
			required_changes: ["this contradicts approved"],
			reservations: [],
			questions: [],
		}
		let captured: unknown = "sentinel"

		await runAsAgentWorker(async () => {
			await tool.execute("tool-call-3", badPayload as unknown as Record<string, unknown>)
			captured = getAgentStructuredOutput()
		})

		expect(captured).toBeUndefined()
	})
})

describe("registerPlanReviewTool — execute: valid needs_revision path", () => {
	it("returns ok for needs_revision with non-empty required_changes", async () => {
		const { tool } = createPlanReviewHarness()

		const result = await runAsAgentWorker(() =>
			tool.execute("tool-call-4", NEEDS_REVISION_PAYLOAD as unknown as Record<string, unknown>),
		)

		expect(result.isError).toBeFalsy()
		expect(okText(result)).toContain("submitted")
	})

	it("captures needs_revision payload as structuredOutput", async () => {
		const { tool } = createPlanReviewHarness()
		let captured: unknown

		await runAsAgentWorker(async () => {
			await tool.execute("tool-call-4", NEEDS_REVISION_PAYLOAD as unknown as Record<string, unknown>)
			captured = getAgentStructuredOutput()
		})

		expect(captured).toMatchObject(NEEDS_REVISION_PAYLOAD)
		expect(verifyPlanReviewToken((captured as Record<string, unknown>)[PLAN_REVIEW_PROVENANCE_FIELD])).toBe(true)
	})
})
