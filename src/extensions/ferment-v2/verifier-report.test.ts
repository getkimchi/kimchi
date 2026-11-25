import { describe, expect, it } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { VerifierEvidence } from "./verifier-guard.js"
import {
	createVerifierReport,
	type FindingResponse,
	formatCarriedFindings,
	type OpenFinding,
} from "./verifier-report.js"

const evidence: VerifierEvidence = {
	id: "e1",
	toolName: "bash",
	input: { command: "rerun F1" },
	isError: false,
	excerpt: "F1 still fails",
}

function makeHarness(openFindings: readonly OpenFinding[] = []) {
	const child = createExtensionApi()
	const report = createVerifierReport({
		evidence: new Map([[evidence.id, evidence]]),
		openFindings,
		objective: "F1 must pass",
		cwd: "/repo",
		currentTree: "tree-2",
	})
	report.beginAttempt()
	const register = typeof report.extension === "function" ? report.extension : report.extension.factory
	register(child.api)
	return {
		report,
		execute: async (toolName: string, params: Record<string, unknown>) => {
			const tool = child.getRegisteredTool(toolName)
			return tool.execute("call", params, undefined, undefined, createToolContext())
		},
	}
}

function previousFinding(response?: FindingResponse): OpenFinding {
	return {
		id: "F1",
		clause: "F1 must pass",
		observed: "F1 failed",
		expected: "F1 passes",
		why: "the objective requires F1 to pass",
		...(response ? { response } : {}),
	}
}

describe("carried finding retraction", () => {
	it("rejects retraction after still_failing and keeps met blocked", async () => {
		const harness = makeHarness([previousFinding()])
		await harness.execute("resolve_finding", {
			id: "F1",
			resolution: "still_failing",
			evidence: ["e1"],
			observed: "F1 still fails",
			reason: "the re-run failed",
		})

		const retraction = await harness.execute("retract_finding", { id: "F1", reason: "ignore it" })
		expect(retraction.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("cannot be retracted"),
		})
		const submitted = await harness.execute("submit_verdict", { verdict: "met", summary: "" })
		expect(submitted.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("active findings F1 contradict met"),
		})
	})

	it("rejects retraction after dispute_rejected", async () => {
		const harness = makeHarness([previousFinding({ status: "disputed", evidence: "the objective excludes F1" })])
		await harness.execute("resolve_finding", {
			id: "F1",
			resolution: "dispute_rejected",
			evidence: [],
			reason: "the quoted text supports F1",
		})

		const retraction = await harness.execute("retract_finding", { id: "F1", reason: "ignore it" })
		expect(retraction.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("cannot be retracted"),
		})
	})

	it("still allows an ordinary new finding to be retracted", async () => {
		const harness = makeHarness()
		await harness.execute("report_finding", {
			clause: "F1 must pass",
			evidence: ["e1"],
			observed: "F1 failed",
			expected: "F1 passes",
			why: "the objective requires F1 to pass",
		})

		const retraction = await harness.execute("retract_finding", {
			id: "F1",
			reason: "the expectation came from an invalid test assumption",
		})
		expect(retraction.content[0]).toMatchObject({ type: "text", text: "Retracted finding F1." })
		const submitted = await harness.execute("submit_verdict", { verdict: "met", summary: "" })
		expect(submitted.content[0]).toMatchObject({ type: "text", text: "Verdict submitted. The review is complete." })
	})

	it("does not instruct the verifier to retract carried findings", () => {
		const finding = {
			id: "F1",
			attempt: 1,
			clause: "F1 must pass",
			evidence: ["e1"],
			observed: "F1 failed",
			expected: "F1 passes",
			why: "objective",
			status: "active" as const,
			carried: true as const,
		}
		const text = formatCarriedFindings([finding])
		expect(text).toContain("carried from an earlier review; retraction is not allowed")
		expect(text).toContain("Retract only a non-carried finding")
	})
})
