import type { Api, Context, Model } from "@earendil-works/pi-ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChangeSet } from "../../agent-patch/index.js"
import { boundCompiledContext, compileCouncilContext, fitContextToModel } from "./context-compiler.js"
import { redactObjectStringsMock as redactObjectStrings } from "./council-test-harness.js"

// Self-hoisting registration for the shared redactor spy: see the comment on `redactObjectStringsMock`
// in `council-test-harness.js` for why this file needs its own `vi.mock` rather than relying on the
// import above.
vi.mock("../pii-redaction/redactor.js", async () => {
	const { redactObjectStringsMock } = await import("./council-test-harness.js")
	return { redactObjectStrings: redactObjectStringsMock }
})

const candidate: ChangeSet = {
	transactionId: "transaction_1",
	operations: [{ kind: "update", path: "src/a.ts", baseSha256: "a".repeat(64), content: "after\n" }],
	base: [{ path: "src/a.ts", exists: true, sha256: "a".repeat(64), mode: 0o644 }],
	patch: "candidate patch",
	patchSha256: "b".repeat(64),
	stats: { files: 1, addedLines: 1, removedLines: 1, patchBytes: 15 },
}

const model = (contextWindow: number): Pick<Model<Api>, "provider" | "id" | "contextWindow"> => ({
	provider: "physical",
	id: `model-${contextWindow}`,
	contextWindow,
})

beforeEach(() => {
	redactObjectStrings.mockReset()
	redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => structuredClone(value))
})

describe("compileCouncilContext", () => {
	it("preserves the objective, typed evidence, and exact candidate", async () => {
		const context: Context = {
			systemPrompt: "## Guidelines\nUse evidence.\n## Project Guidelines\nUse pnpm.",
			messages: [
				{ role: "user", content: "Fix the failing test", timestamp: Number.NaN },
				{
					role: "assistant",
					content: [{ type: "text", text: "I will fix it." }],
					api: "x",
					provider: "x",
					model: "x",
					usage: {} as never,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		}
		const compiled = await compileCouncilContext({ context, runId: "run_1", leadDraft: "Lead answer", candidate })

		expect(compiled.objective.text).toBe("Fix the failing test")
		expect(compiled.lead_draft?.text).toBe("Lead answer")
		expect(compiled.artifacts.find((artifact) => artifact.kind === "candidate_patch")).toMatchObject({
			candidate_patch: {
				transaction_id: candidate.transactionId,
				patch_sha256: candidate.patchSha256,
				patch: candidate.patch,
			},
		})
	})

	it("fails closed when redaction fails", async () => {
		redactObjectStrings.mockRejectedValue(new Error("redactor unavailable"))
		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Fix it", timestamp: 1 }] },
				runId: "run_1",
			}),
		).rejects.toMatchObject({ code: "redaction_failed" })
	})

	it("bounds compiled evidence without removing the candidate", async () => {
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Fix it", timestamp: 1 }] },
			runId: "run_1",
			candidate,
			maxEvidenceBytes: 4_096,
		})
		const bounded = boundCompiledContext(compiled, 2_048)
		expect(bounded.artifacts.some((artifact) => artifact.kind === "candidate_patch")).toBe(true)
		expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2_048)
	})
})

describe("fitContextToModel", () => {
	it("keeps the newest user/tool chain and reports truncation", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(20_000) }],
					api: "x",
					provider: "x",
					model: "x",
					usage: {} as never,
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "new", timestamp: 3 },
			],
		}
		const fitted = fitContextToModel(context, {
			model: model(512),
			requestedMaxOutputTokens: 64,
			overheadTokens: 1,
			safetyMargin: 0.8,
		})
		expect(fitted.truncated).toBe(true)
		expect(fitted.context.messages.at(-1)).toMatchObject({ role: "user", content: "new" })
	})
})
