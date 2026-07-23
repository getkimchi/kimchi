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
import type { CandidatePatchArtifact } from "./schemas.js"

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

const baseSha256 = "a".repeat(64)
const patchSha256 = "b".repeat(64)
const candidatePatch = [
	"# kimchi-change-set v1",
	`# update src/a.ts base=${baseSha256} mode=644`,
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
			baseSha256,
			content: "after\n",
		},
	],
	base: [{ path: "src/a.ts", exists: true, sha256: baseSha256, mode: 0o644 }],
	patch: candidatePatch,
	patchSha256,
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

	it("preserves only generated candidate hash metadata through redaction", async () => {
		redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => {
			const serialized = JSON.stringify(value)
				.replace(/[a-f0-9]{64}/g, "[REDACTED-CRYPTO]")
				.replaceAll("person@example.com", "[REDACTED-EMAIL]")
			return JSON.parse(serialized) as T
		})

		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Contact person@example.com", timestamp: 1 }] },
			runId: "run_1",
			candidate,
		})
		const candidateArtifact = compiled.artifacts.find(
			(artifact): artifact is CandidatePatchArtifact => artifact.kind === "candidate_patch",
		)

		expect(compiled.objective.text).toBe("Contact [REDACTED-EMAIL]")
		expect(candidateArtifact?.candidate_patch).toMatchObject({
			patch_sha256: patchSha256,
			operations: [{ base_sha256: baseSha256 }],
			patch: candidatePatch,
		})
	})

	it("fails closed when redaction changes candidate code", async () => {
		redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => {
			return JSON.parse(JSON.stringify(value).replace("+after", "+[REDACTED-SECRET]")) as T
		})

		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Update the code", timestamp: 1 }] },
				runId: "run_1",
				candidate,
			}),
		).rejects.toMatchObject({ code: "redaction_failed" })
	})

	it("does not exempt a base hash repeated inside a code hunk", async () => {
		redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => {
			return JSON.parse(JSON.stringify(value).replace(/[a-f0-9]{64}/g, "[REDACTED-CRYPTO]")) as T
		})
		const patch = candidatePatch.replace("+after", `+${baseSha256}`)

		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Update the code", timestamp: 1 }] },
				runId: "run_1",
				candidate: {
					...candidate,
					operations: [{ ...candidate.operations[0], content: `${baseSha256}\n` }],
					patch,
					stats: { ...candidate.stats, patchBytes: Buffer.byteLength(patch) },
				},
			}),
		).rejects.toMatchObject({ code: "redaction_failed" })
	})

	it("fails closed when redaction changes a candidate path", async () => {
		redactObjectStrings.mockImplementation(async <T>(value: T): Promise<T> => {
			return JSON.parse(JSON.stringify(value).replaceAll("src/a.ts", "[REDACTED-PATH]")) as T
		})

		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Update the code", timestamp: 1 }] },
				runId: "run_1",
				candidate,
			}),
		).rejects.toMatchObject({ code: "redaction_failed" })
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

		const critic = buildRoleContext(compiled, "critic")
		expect(critic).toMatchObject({ role: "critic", lead_draft: { text: "Lead answer" } })
		expect(critic.evidence.find(({ kind }) => kind === "candidate_patch")).toMatchObject({
			candidate_patch: {
				transaction_id: candidate.transactionId,
				patch_sha256: candidate.patchSha256,
				patch: candidatePatch,
			},
		})
		expect(critic.evidence.find(({ kind }) => kind === "candidate_validation")).toMatchObject({
			candidate_validation: candidateValidation,
		})

		const checker = buildRoleContext(compiled, "checker", [
			{
				id: "package.test",
				kind: "test",
				cwd: ".",
				description: "pnpm exec vitest run",
				timeout_ms: 30_000,
				mutation_policy: "read-only",
			},
		])
		expect(checker).not.toHaveProperty("lead_draft")
		expect(checker.validation_catalog).toMatchObject([{ id: "package.test" }])
		for (const roleContext of [critic, checker]) {
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

		expect(independent.evidence.map(({ kind }) => kind)).toEqual(["tool_call", "tool_result"])
		expect(independent.objective.text).toBe("Fix src/a.ts")
		expect(independent.constraints).toEqual([expect.objectContaining({ text: "Follow the repository rules." })])
		expect(independent.requirements).toEqual([
			expect.objectContaining({ id: expect.stringMatching(/^requirement_[a-f0-9]{16}$/), text: "Fix src/a.ts" }),
		])
		expect(independent.evidence.find(({ kind }) => kind === "tool_call")).toMatchObject({
			tool_call: { id: "base_read", name: "read", arguments: { path: "src/a.ts" } },
		})
		expect(independent.evidence.find(({ kind }) => kind === "tool_result")).toMatchObject({
			tool_result: { id: "base_read", content: [{ type: "text", text: "before\n" }] },
		})
		expect(JSON.stringify(independent)).not.toContain("Old objective")
		expect(JSON.stringify(independent)).not.toContain("Old lead analysis")
	})

	it("caps generated requirements at the checker schema cardinality", async () => {
		const objective = Array.from({ length: 21 }, (_, index) => `Requirement ${index + 1}`).join("\n")
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: objective, timestamp: 1 }] },
			runId: "run_1",
			leadDraft: "Draft",
		})

		const checker = buildRoleContext(compiled, "checker")

		expect(checker.requirements).toHaveLength(20)
		expect(checker.requirements.map(({ text }) => text)).toEqual(
			Array.from({ length: 20 }, (_, index) => `Requirement ${index + 1}`),
		)
	})

	it("keeps only bounded task-relevant system constraint sections in role packets", async () => {
		const irrelevantTools = `TOOL_SCHEMA_CANARY_${"x".repeat(20_000)}`
		const irrelevantEnvironment = `ENVIRONMENT_CANARY_${"y".repeat(4_000)}`
		const context: Context = {
			systemPrompt: [
				"Single-model metadata.",
				"## Guidelines",
				"Never invent test results.",
				"## Factual Accuracy",
				"Use concrete evidence.",
				"## Available Tools",
				irrelevantTools,
				"## Environment",
				irrelevantEnvironment,
				"## Project Guidelines",
				"Use pnpm and preserve the transaction architecture.",
			].join("\n"),
			messages: [{ role: "user", content: "Fix the transaction", timestamp: 1 }],
		}

		const compiled = await compileCouncilContext({ context, runId: "run_1", leadDraft: "Lead answer" })
		const packet = buildRoleContext(compiled, "independent")
		const serialized = JSON.stringify(packet.constraints)

		expect(serialized).toContain("Never invent test results.")
		expect(serialized).toContain("Use concrete evidence.")
		expect(serialized).toContain("Use pnpm and preserve the transaction architecture.")
		expect(serialized).not.toContain("TOOL_SCHEMA_CANARY")
		expect(serialized).not.toContain("ENVIRONMENT_CANARY")
		expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(12 * 1024 + 512)
	})

	it("cuts independent evidence before staged mutation arguments and overlay-backed reads", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Fix src/a.ts", timestamp: 1 },
				assistant([{ type: "toolCall", id: "other_read", name: "read", arguments: { path: "src/b.ts" } }]),
				{
					role: "toolResult",
					toolCallId: "other_read",
					toolName: "read",
					content: [{ type: "text", text: "irrelevant contents" }],
					isError: false,
					timestamp: 2,
				},
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
			{ tool_call: { id: "other_read", name: "read" } },
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
		expect(JSON.stringify(critic)).not.toContain("other_read")
		expect(JSON.stringify(critic)).not.toContain("irrelevant contents")
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
		const oversizedPatch = `${candidatePatch}${"x".repeat(5000)}`
		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Objective", timestamp: 1 }] },
				runId: "run_1",
				leadDraft: "draft",
				candidate: {
					...candidate,
					patch: oversizedPatch,
					stats: { ...candidate.stats, patchBytes: Buffer.byteLength(oversizedPatch) },
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
