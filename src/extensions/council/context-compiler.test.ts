import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

	it("creates strict role packets and hides the lead from the independent reviewer", async () => {
		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Answer", timestamp: 1 }] },
			runId: "run_1",
			leadDraft: "Lead answer",
		})

		expect(buildRoleContext(compiled, "independent")).not.toHaveProperty("lead_draft")
		expect(buildRoleContext(compiled, "critic")).toMatchObject({ role: "critic", lead_draft: { text: "Lead answer" } })
		expect(buildRoleContext(compiled, "checker")).toMatchObject({
			role: "checker",
			lead_draft: { text: "Lead answer" },
		})
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
