import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChangeSet } from "../../agent-patch/index.js"

const { redactObjectStrings } = vi.hoisted(() => ({ redactObjectStrings: vi.fn() }))
vi.mock("../pii-redaction/redactor.js", () => ({ redactObjectStrings }))

import {
	buildRoleContext,
	type ContextCompilerError,
	compileCouncilContext,
	fitContextToModel,
	fitCouncilContextToModel,
} from "./context-compiler.js"

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const model = (contextWindow: number): Pick<Model<Api>, "provider" | "id" | "contextWindow"> => ({
	provider: "physical",
	id: `model-${contextWindow}`,
	contextWindow,
})

const candidatePatch = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1 +1 @@",
	"-before",
	"+after",
	"",
].join("\n")

const candidate: ChangeSet = {
	transactionId: "transaction_1",
	operations: [
		{
			kind: "update",
			path: "src/a.ts",
			baseSha256: "a".repeat(64),
			content: "after\n",
		},
	],
	base: [{ path: "src/a.ts", exists: true, sha256: "a".repeat(64), mode: 0o644 }],
	patch: candidatePatch,
	patchSha256: "b".repeat(64),
	stats: { files: 1, addedLines: 1, removedLines: 1, patchBytes: Buffer.byteLength(candidatePatch) },
}

const candidateValidation = {
	checks: [{ name: "base verification", status: "passed" as const, detail: "Base is unchanged." }],
	limitations: ["Candidate tests run only after promotion."],
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "physical",
		model: "lead",
		usage,
		stopReason: content.some(({ type }) => type === "toolCall") ? "toolUse" : "stop",
		timestamp: Number.NaN,
	}
}

beforeEach(() => {
	redactObjectStrings.mockReset()
	redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => structuredClone(value))
})

describe("compileCouncilContext", () => {
	it("preserves typed conversation and tool evidence without timestamp filtering", async () => {
		const context: Context = {
			systemPrompt: "Follow the repository rules.",
			messages: [
				{ role: "user", content: "Fix the failing test", timestamp: Number.NaN },
				assistant([
					{ type: "text", text: "I will inspect it." },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pnpm test", path: "src/a.ts" } },
				]),
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "2 passed, 1 skipped" }],
					details: { exitCode: 0 },
					isError: false,
					timestamp: Number.NaN,
				},
			],
		}

		const compiled = await compileCouncilContext({ context, runId: "run_1", leadDraft: "Draft" })

		expect(compiled.artifacts.map(({ kind }) => kind)).toEqual([
			"system_instruction",
			"user_text",
			"assistant_text",
			"tool_call",
			"tool_result",
		])
		expect(compiled.artifacts.map(({ trust }) => trust)).toEqual([
			"trusted_system_instruction",
			"trusted_user_instruction",
			"untrusted_assistant_output",
			"untrusted_assistant_output",
			"untrusted_tool_output",
		])
		const call = compiled.artifacts.find(({ kind }) => kind === "tool_call")
		expect(call).toMatchObject({ tool_call: { id: "call_1", name: "bash", arguments: { command: "pnpm test" } } })
		const result = compiled.artifacts.find(({ kind }) => kind === "tool_result")
		expect(result).toMatchObject({
			tool_result: {
				id: "call_1",
				name: "bash",
				is_error: false,
				content: [{ type: "text", text: "2 passed, 1 skipped" }],
				metadata: {
					path: "src/a.ts",
					command: "pnpm test",
					exit: { code: 0 },
					test: { status: "passed", passed: 2, skipped: 1 },
				},
			},
		})
	})

	it("uses fail-closed redaction and never returns the raw packet after failure", async () => {
		redactObjectStrings.mockRejectedValueOnce(new Error("scanner offline"))
		const context: Context = { messages: [{ role: "user", content: "secret", timestamp: 1 }] }

		await expect(compileCouncilContext({ context, runId: "run_1" })).rejects.toMatchObject({
			code: "redaction_failed",
		})
		expect(redactObjectStrings).toHaveBeenCalledWith(expect.anything(), { failClosed: true })
	})

	it("hides the lead and candidate from the independent reviewer but gives critics the exact candidate", async () => {
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Answer", timestamp: 1 }] },
			runId: "run_1",
			leadDraft: "Lead answer",
			candidate,
			candidateValidation,
		})

		const independent = buildRoleContext(compiled, "independent")
		expect(independent).not.toHaveProperty("lead_draft")
		expect(independent.evidence.map(({ kind }) => kind)).not.toContain("candidate_patch")
		expect(independent.evidence.map(({ kind }) => kind)).not.toContain("candidate_validation")

		for (const role of ["critic", "checker"] as const) {
			const roleContext = buildRoleContext(compiled, role)
			expect(roleContext).toMatchObject({ role, lead_draft: { text: "Lead answer" } })
			expect(roleContext.evidence.find(({ kind }) => kind === "candidate_patch")).toMatchObject({
				candidate_patch: {
					transaction_id: candidate.transactionId,
					patch_sha256: candidate.patchSha256,
					patch: candidatePatch,
				},
			})
			expect(roleContext.evidence.find(({ kind }) => kind === "candidate_validation")).toMatchObject({
				candidate_validation: candidateValidation,
			})
		}
	})

	it("gives the independent reviewer only the latest turn and its completed base reads", async () => {
		const context: Context = {
			systemPrompt: "Follow the repository rules.",
			messages: [
				{ role: "user", content: "Old objective", timestamp: 1 },
				assistant([{ type: "text", text: "Old lead analysis" }]),
				{ role: "user", content: "Fix src/a.ts", timestamp: 2 },
				assistant([{ type: "toolCall", id: "base_read", name: "read", arguments: { path: "src/a.ts" } }]),
				{
					role: "toolResult",
					toolCallId: "base_read",
					toolName: "read",
					content: [{ type: "text", text: "before\n" }],
					isError: false,
					timestamp: 3,
				},
			],
		}

		const compiled = await compileCouncilContext({ context, runId: "run_1", leadDraft: "Lead answer" })
		const independent = buildRoleContext(compiled, "independent")

		expect(independent.evidence.map(({ kind }) => kind)).toEqual([
			"system_instruction",
			"user_text",
			"tool_call",
			"tool_result",
		])
		expect(independent.evidence.find(({ kind }) => kind === "user_text")).toMatchObject({ text: "Fix src/a.ts" })
		expect(independent.evidence.find(({ kind }) => kind === "tool_call")).toMatchObject({
			tool_call: { id: "base_read", name: "read", arguments: { path: "src/a.ts" } },
		})
		expect(independent.evidence.find(({ kind }) => kind === "tool_result")).toMatchObject({
			tool_result: { id: "base_read", content: [{ type: "text", text: "before\n" }] },
		})
		expect(JSON.stringify(independent)).not.toContain("Old objective")
		expect(JSON.stringify(independent)).not.toContain("Old lead analysis")
	})

	it("cuts independent evidence before staged mutation arguments and overlay-backed reads", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Fix src/a.ts", timestamp: 1 },
				assistant([{ type: "toolCall", id: "base_read", name: "read", arguments: { path: "src/a.ts" } }]),
				{
					role: "toolResult",
					toolCallId: "base_read",
					toolName: "read",
					content: [{ type: "text", text: "base contents" }],
					isError: false,
					timestamp: 2,
				},
				assistant([
					{ type: "text", text: "I will stage the fix." },
					{
						type: "toolCall",
						id: "mutation",
						name: "edit",
						arguments: { path: "src/a.ts", oldText: "base contents", newText: "secret staged contents" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "mutation",
					toolName: "edit",
					content: [{ type: "text", text: "staged" }],
					isError: false,
					timestamp: 3,
				},
				assistant([{ type: "toolCall", id: "overlay_read", name: "read", arguments: { path: "src/a.ts" } }]),
				{
					role: "toolResult",
					toolCallId: "overlay_read",
					toolName: "read",
					content: [{ type: "text", text: "secret staged contents" }],
					isError: false,
					timestamp: 4,
				},
			],
		}

		const compiled = await compileCouncilContext({
			context,
			runId: "run_1",
			leadDraft: "Lead answer",
			candidate,
			candidateValidation,
		})
		const independent = buildRoleContext(compiled, "independent")
		const serialized = JSON.stringify(independent)

		expect(independent.evidence.filter(({ kind }) => kind === "tool_call")).toMatchObject([
			{ tool_call: { id: "base_read", name: "read" } },
		])
		expect(serialized).not.toContain("mutation")
		expect(serialized).not.toContain("secret staged contents")
		expect(serialized).not.toContain("overlay_read")
		expect(serialized).not.toContain("candidate_patch")
		expect(serialized).not.toContain("candidate_validation")
		expect(independent).not.toHaveProperty("lead_draft")

		const critic = buildRoleContext(compiled, "critic")
		expect(JSON.stringify(critic)).toContain("secret staged contents")
		expect(JSON.stringify(critic)).toContain("candidate_patch")
	})

	it("retains explicit truncation evidence when the packet is bounded", async () => {
		const messages: Context["messages"] = [{ role: "user", content: "Objective", timestamp: 1 }]
		for (let index = 0; index < 10; index++)
			messages.push(assistant([{ type: "text", text: `${index}:${"x".repeat(2000)}` }]))

		const compiled = await compileCouncilContext({
			context: { messages },
			runId: "run_1",
			leadDraft: "draft",
			maxEvidenceBytes: 4096,
		})

		expect(Buffer.byteLength(JSON.stringify(compiled))).toBeLessThanOrEqual(4096)
		expect(compiled.truncation.truncated).toBe(true)
		expect(compiled.truncation.omitted_artifact_ids.length).toBeGreaterThan(0)
		expect(compiled.artifacts.some(({ artifact_id }) => artifact_id === compiled.objective.artifact_id)).toBe(true)
	})

	it("never truncates or omits the candidate while bounding optional evidence", async () => {
		const messages: Context["messages"] = [{ role: "user", content: "Objective", timestamp: 1 }]
		for (let index = 0; index < 10; index++)
			messages.push(assistant([{ type: "text", text: `${index}:${"x".repeat(2000)}` }]))

		const compiled = await compileCouncilContext({
			context: { messages },
			runId: "run_1",
			leadDraft: "draft",
			candidate,
			candidateValidation,
			maxEvidenceBytes: 4096,
		})
		const candidateArtifact = compiled.artifacts.find(({ kind }) => kind === "candidate_patch")
		const validationArtifact = compiled.artifacts.find(({ kind }) => kind === "candidate_validation")

		expect(compiled.truncation.truncated).toBe(true)
		expect(candidateArtifact).toMatchObject({
			artifact_id: "artifact_candidate_patch",
			candidate_patch: { patch_sha256: candidate.patchSha256, patch: candidatePatch },
		})
		expect(candidateArtifact).not.toHaveProperty("truncated")
		expect(validationArtifact).toMatchObject({ candidate_validation: candidateValidation })
		expect(validationArtifact).not.toHaveProperty("truncated")
		expect(compiled.truncation.omitted_artifact_ids).not.toContain("artifact_candidate_patch")
		expect(compiled.truncation.omitted_artifact_ids).not.toContain("artifact_candidate_validation")
	})

	it("rejects the packet instead of truncating an oversized candidate", async () => {
		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Objective", timestamp: 1 }] },
				runId: "run_1",
				leadDraft: "draft",
				candidate: {
					...candidate,
					patch: "x".repeat(5000),
					stats: { ...candidate.stats, patchBytes: 5000 },
				},
				candidateValidation,
				maxEvidenceBytes: 4096,
			}),
		).rejects.toMatchObject({ code: "evidence_limit" })
	})
})

describe("per-model context fitting", () => {
	it("fits the same role packet independently to each physical model", async () => {
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: `Objective ${"x".repeat(12_000)}`, timestamp: 1 }] },
			runId: "run_1",
			leadDraft: "Lead answer",
		})
		const small = fitCouncilContextToModel(compiled, "critic", {
			model: model(4_096),
			requestedMaxOutputTokens: 512,
			overheadTokens: 128,
		})
		const large = fitCouncilContextToModel(compiled, "critic", {
			model: model(16_384),
			requestedMaxOutputTokens: 512,
			overheadTokens: 128,
		})

		expect(small.modelRef).toBe("physical/model-4096")
		expect(small.estimatedInputTokens).toBeLessThan(large.estimatedInputTokens)
		expect(small.truncated).toBe(true)
		expect(large.maxOutputTokens).toBe(512)
	})

	it("fits Pi history by order and preserves the newest user/tool chain regardless of timestamps", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				assistant([{ type: "text", text: "x".repeat(12_000) }]),
				{ role: "user", content: "new", timestamp: Number.NaN },
				assistant([{ type: "toolCall", id: "call_new", name: "read", arguments: { path: "a.ts" } }]),
				{
					role: "toolResult",
					toolCallId: "call_new",
					toolName: "read",
					content: [{ type: "text", text: "latest evidence" }],
					isError: false,
					timestamp: Number.NaN,
				},
			],
		}

		const fitted = fitContextToModel(context, {
			model: model(2_048),
			requestedMaxOutputTokens: 256,
			overheadTokens: 64,
		})

		expect(fitted.truncated).toBe(true)
		expect(JSON.stringify(fitted.context.messages)).toContain("new")
		expect(JSON.stringify(fitted.context.messages)).toContain("latest evidence")
		expect(JSON.stringify(fitted.context.messages)).not.toContain('"old"')
	})

	it("does not retain a tool result after truncating its assistant tool call", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				assistant([{ type: "toolCall", id: "call_old", name: "read", arguments: { path: "x".repeat(12_000) } }]),
				{
					role: "toolResult",
					toolCallId: "call_old",
					toolName: "read",
					content: [{ type: "text", text: "orphaned evidence" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "new objective", timestamp: 3 },
			],
		}

		const fitted = fitContextToModel(context, {
			model: model(2_048),
			requestedMaxOutputTokens: 256,
			overheadTokens: 64,
		})

		expect(fitted.truncated).toBe(true)
		expect(fitted.context.messages.map(({ role }) => role)).toEqual(["user", "user"])
		expect(JSON.stringify(fitted.context.messages)).not.toContain("orphaned evidence")
	})

	it("rejects a role packet that cannot fit the physical window", async () => {
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Answer", timestamp: 1 }] },
			runId: "run_1",
			leadDraft: "Lead",
		})

		expect(() =>
			fitCouncilContextToModel(compiled, "critic", {
				model: model(64),
				requestedMaxOutputTokens: 32,
			}),
		).toThrowError(expect.objectContaining<Partial<ContextCompilerError>>({ code: "context_limit" }))
	})
})
