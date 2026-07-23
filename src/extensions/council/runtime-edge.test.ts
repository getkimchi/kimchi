import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	type CouncilConfig,
	type CouncilRunRecord,
	type CouncilRuntimeDependencies,
	createCouncilStream as createCouncilRuntimeStream,
	DEFAULT_COUNCIL_CONFIG,
} from "./runtime.js"
import { withStrictCouncilFixtures } from "./runtime-test-fixtures.js"

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const VALID_REVIEW = '{"decision":"accept","findings":[],"recommended_changes":[],"missing_evidence":[]}'
const VALID_JUDGE =
	'{"decision":"accept","consensus":[],"critical_findings":[],"disagreements":[],"unsupported_claims":[],"required_checks":[],"revision_instructions":[],"agreement":"high"}'

type CompleteModel = NonNullable<CouncilRuntimeDependencies["completeModel"]>
type Registry = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">

function createCouncilStream(dependencies: CouncilRuntimeDependencies) {
	return createCouncilRuntimeStream({
		...dependencies,
		completeModel: dependencies.completeModel ? withStrictCouncilFixtures(dependencies.completeModel) : undefined,
	})
}

const TEST_COUNCIL_CONFIG: CouncilConfig = {
	...DEFAULT_COUNCIL_CONFIG,
	reviewPolicy: "always",
	lead: { primary: DEFAULT_COUNCIL_CONFIG.lead.primary, fallbacks: [] },
	reviewers: {
		independent: { primary: DEFAULT_COUNCIL_CONFIG.reviewers.independent.primary, fallbacks: [] },
		critic: { primary: DEFAULT_COUNCIL_CONFIG.reviewers.critic.primary, fallbacks: [] },
		checker: { primary: DEFAULT_COUNCIL_CONFIG.reviewers.checker.primary, fallbacks: [] },
	},
	judge: { primary: DEFAULT_COUNCIL_CONFIG.judge.primary, fallbacks: [] },
	budget: { ...DEFAULT_COUNCIL_CONFIG.budget, maxEstimatedCostUsd: 1_000_000, maxRetriesPerCall: 0 },
}

function reviewerConfig(
	models: string[],
	roles: (keyof CouncilConfig["reviewers"])[] = ["independent", "critic", "checker"],
): Pick<CouncilConfig, "requiredRoles" | "reviewers"> {
	const reviewers = structuredClone(TEST_COUNCIL_CONFIG.reviewers)
	const requiredRoles = roles.slice(0, models.length)
	for (const [index, role] of requiredRoles.entries()) {
		const primary = models[index]
		if (!primary) throw new Error(`Missing reviewer model for ${role}`)
		reviewers[role] = { primary, fallbacks: [] }
	}
	return { requiredRoles, reviewers }
}

function physicalModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 4096,
	}
}

const models = new Map(
	["kimi-k2.7", "glm-5.2-fp8", "deepseek-v4-flash", "minimax-m3"].map((id) => [id, physicalModel(id)]),
)
const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: ZERO_COST,
	contextWindow: 262_144,
	maxTokens: 32_768,
} satisfies Model<Api>

function usage(tokens = 1): Usage {
	return {
		input: tokens,
		output: tokens,
		cacheRead: tokens,
		cacheWrite: tokens,
		totalTokens: tokens * 4,
		cost: { input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, total: tokens * 4 },
	}
}

function response(model: Model<Api>, text: string, tokens = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(tokens),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function registry(
	auth: Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>> = {
		ok: true,
		apiKey: "physical-key",
		headers: { authorization: "physical" },
		env: { API_SCOPE: "physical" },
	},
): Registry {
	return {
		find: vi.fn((provider: string, id: string) => (provider === "kimchi-dev" ? models.get(id) : undefined)),
		getApiKeyAndHeaders: vi.fn(async () => auth),
	}
}

function stage(context: Context): "lead" | "review" | "judge" | "repair" | "revision" {
	const system = context.systemPrompt ?? ""
	const last = context.messages.at(-1)
	const lastText = last?.role === "user" && typeof last.content === "string" ? last.content : ""
	if (system.includes("Repair the supplied object")) return "repair"
	if (system.includes("Council reviewer")) return "review"
	if (system.includes("Council judge")) return "judge"
	if (lastText.includes("<council_review_data>")) return "revision"
	return "lead"
}

async function runCouncil({
	completeModel,
	config,
	context,
	options,
	modelRegistry = registry(),
}: {
	completeModel: CompleteModel
	config?: Partial<CouncilConfig>
	context?: Context
	options?: SimpleStreamOptions
	modelRegistry?: Registry
}): Promise<{ result: AssistantMessage; record: CouncilRunRecord | undefined }> {
	let record: CouncilRunRecord | undefined
	const stream = createCouncilStream({
		config: { ...TEST_COUNCIL_CONFIG, ...config },
		getModelRegistry: () => modelRegistry,
		completeModel,
		recordRun: (value) => {
			record = value
		},
	})(councilModel, context ?? { messages: [{ role: "user", content: "Answer", timestamp: 1 }] }, options)
	const result = await stream.result()
	await Promise.resolve()
	return { result, record }
}

describe("Council runtime adversarial edges", () => {
	it("does not leak virtual auth, headers, or env into a physical tool call", async () => {
		const toolCall = {
			type: "toolCall" as const,
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "opaque",
		}
		const completeModel = vi.fn<CompleteModel>(async (model) => ({
			...response(model, "unused"),
			content: [{ type: "thinking", thinking: "private" }, toolCall],
			stopReason: "toolUse",
		}))
		const modelRegistry = registry({
			ok: true,
			apiKey: "physical-key",
			headers: { authorization: "physical", "x-physical": "kept" },
			env: { API_SCOPE: "physical", PHYSICAL_ONLY: "kept" },
		})
		const { result } = await runCouncil({
			completeModel,
			modelRegistry,
			context: {
				messages: [{ role: "user", content: "Read the file", timestamp: 1 }],
				tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			},
			options: {
				apiKey: "virtual-key",
				headers: { authorization: "virtual", "x-virtual": "must-not-leak" },
				env: { API_SCOPE: "virtual", VIRTUAL_ONLY: "must-not-leak" },
			},
		})
		const child = completeModel.mock.calls[0]?.[2]

		expect(result).toMatchObject({ content: [toolCall], stopReason: "toolUse" })
		expect(child).toMatchObject({
			apiKey: "physical-key",
			headers: { authorization: "physical", "x-physical": "kept" },
			env: { API_SCOPE: "physical", PHYSICAL_ONLY: "kept" },
		})
		expect(child?.headers).not.toHaveProperty("x-virtual")
		expect(child?.env).not.toHaveProperty("VIRTUAL_ONLY")
	})

	it("hides internal output and aggregates every physical call's usage", async () => {
		let call = 0
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			const tokens = ++call
			switch (stage(context)) {
				case "review":
					return response(
						model,
						JSON.stringify({ ...JSON.parse(VALID_REVIEW), recommended_changes: ["REVIEW_SECRET"] }),
						tokens,
					)
				case "judge":
					return response(
						model,
						JSON.stringify({
							...JSON.parse(VALID_JUDGE),
							decision: "revise",
							revision_instructions: ["JUDGE_SECRET"],
						}),
						tokens,
					)
				case "revision":
					return {
						...response(model, "Public answer", tokens),
						content: [
							{ type: "thinking", thinking: "THINKING_SECRET" },
							{ type: "text", text: "Public answer" },
						],
					}
				default:
					return response(model, "Lead draft", tokens)
			}
		})

		const { result, record } = await runCouncil({ completeModel })
		const publicState = JSON.stringify({ result, record })

		expect(completeModel).toHaveBeenCalledTimes(6)
		expect(result.content).toEqual([{ type: "text", text: "Public answer" }])
		expect(publicState).not.toMatch(/REVIEW_SECRET|JUDGE_SECRET|THINKING_SECRET/)
		expect(result.usage).toMatchObject({ input: 21, output: 21, cacheRead: 21, cacheWrite: 21, totalTokens: 84 })
		expect(record?.usage).toEqual(result.usage)
	})

	it("rejects oversized structured reviews without attempting repair", async () => {
		const oversized = JSON.stringify({ ...JSON.parse(VALID_REVIEW), recommended_changes: ["x".repeat(2048)] })
		const completeModel = vi.fn<CompleteModel>(async (model, context) =>
			response(model, stage(context) === "review" ? oversized : "Lead survives"),
		)
		const { result, record } = await runCouncil({ completeModel, config: { maxStructuredBytes: 1024 } })

		expect(result.content).toEqual([{ type: "text", text: "Lead survives" }])
		expect(result.stopReason).toBe("stop")
		expect(completeModel.mock.calls.filter(([, context]) => stage(context) === "repair")).toHaveLength(0)
		expect(record).toMatchObject({ outcome: "degraded", degradedReason: "reviewers_unavailable" })
		expect(record?.stages).toContainEqual(
			expect.objectContaining({ stage: "independent", status: "error", error: "invalid_output" }),
		)
	})

	it("forces revision and exposes a missing reviewer role to the judge", async () => {
		let judgePayload = ""
		let revisionPayload = ""
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			switch (stage(context)) {
				case "review":
					return response(model, model.id === "glm-5.2-fp8" ? "x".repeat(2048) : VALID_REVIEW)
				case "judge":
					judgePayload = String(context.messages[0]?.content)
					return response(model, VALID_JUDGE)
				case "revision":
					revisionPayload = String(context.messages.at(-1)?.content)
					return response(model, "Revised after partial review")
				default:
					return response(model, "Lead")
			}
		})

		const { result, record } = await runCouncil({
			completeModel,
			config: {
				...reviewerConfig(["kimchi-dev/glm-5.2-fp8", "kimchi-dev/deepseek-v4-flash"], ["independent", "critic"]),
				maxParallelReviewers: 2,
				maxStructuredBytes: 1024,
				revisionPolicy: "on-issues",
			},
		})

		expect(result.content).toEqual([{ type: "text", text: "Revised after partial review" }])
		expect(JSON.parse(judgePayload)).toMatchObject({ missing_reviewers: ["independent"] })
		expect(revisionPayload).toContain('"missing_reviewers":["independent"]')
		expect(record?.outcome).toBe("revised")
	})

	it("passes the configured structured-output budget to repair", async () => {
		const malformed = `{"broken":"${"x".repeat(20_000)}REPAIR_TAIL`
		let repairRaw = ""
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			switch (stage(context)) {
				case "review":
					return response(model, malformed)
				case "repair": {
					const payload = JSON.parse(String(context.messages[0]?.content)) as { raw: string }
					repairRaw = payload.raw
					return response(model, VALID_REVIEW)
				}
				case "judge":
					return response(model, VALID_JUDGE)
				case "revision":
					return response(model, "Revised")
				default:
					return response(model, "Lead")
			}
		})

		await runCouncil({
			completeModel,
			config: {
				...reviewerConfig(["kimchi-dev/glm-5.2-fp8"]),
				maxParallelReviewers: 1,
			},
		})

		expect(Buffer.byteLength(repairRaw)).toBeGreaterThan(16_384)
		expect(repairRaw).toContain("REPAIR_TAIL")
	})

	it("does not accept a resolved disagreement without a resolution", async () => {
		const emptyResolution = JSON.stringify({
			...JSON.parse(VALID_JUDGE),
			disagreements: [{ topic: "Unverified claim", impact: "medium", resolved: true, resolution: "" }],
		})
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			switch (stage(context)) {
				case "review":
					return response(
						model,
						JSON.stringify({
							...JSON.parse(VALID_REVIEW),
							decision: "revise",
							findings: [
								{
									severity: "medium",
									statement: "Unverified claim",
									evidence_refs: ["artifact_1"],
									assumptions: [],
									suggested_check: "Verify claim",
								},
							],
						}),
					)
				case "judge":
				case "repair":
					return response(model, emptyResolution)
				case "revision":
					return response(model, "Revised after invalid verdict")
				default:
					return response(model, "Lead")
			}
		})

		const { result, record } = await runCouncil({ completeModel, config: { revisionPolicy: "on-issues" } })

		expect(result.content).toEqual([{ type: "text", text: "Revised after invalid verdict" }])
		expect(record).toMatchObject({ outcome: "degraded", degradedReason: "judge_failed" })
		expect(record?.stages).toContainEqual(
			expect.objectContaining({ stage: "judge", status: "error", error: "invalid_output" }),
		)
	})

	it("fits revision history against the lead model context window", async () => {
		const priorToolCall = { type: "toolCall" as const, id: "call_old", name: "read", arguments: { path: "a.txt" } }
		let leadContext: Context | undefined
		let leadOptions: SimpleStreamOptions | undefined
		let revisionContext: Context | undefined
		let revisionOptions: SimpleStreamOptions | undefined
		const modelRegistry = registry()
		modelRegistry.find = vi.fn((provider: string, id: string) => {
			const found = provider === "kimchi-dev" ? models.get(id) : undefined
			return found && id === "kimi-k2.7" ? { ...found, contextWindow: 12_000 } : found
		})
		const completeModel = vi.fn<CompleteModel>(async (model, context, options) => {
			switch (stage(context)) {
				case "review":
					return response(model, VALID_REVIEW)
				case "judge":
					return response(model, VALID_JUDGE)
				case "revision":
					revisionContext = context
					revisionOptions = options
					return response(model, "Bounded revision")
				default:
					leadContext = context
					leadOptions = options
					return response(model, "Lead", 2000)
			}
		})

		await runCouncil({
			completeModel,
			modelRegistry,
			config: { leadMaxTokens: 4096 },
			context: {
				systemPrompt: "SYSTEM_CONSTRAINT",
				tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
				messages: [
					{ role: "user", content: `OLDEST_REVISION_MARKER ${"}{".repeat(2500)}`, timestamp: 1 },
					{ role: "user", content: "CURRENT_OBJECTIVE", timestamp: 2 },
					{
						role: "assistant",
						content: [priorToolCall],
						api: "openai-completions",
						provider: "kimchi-dev",
						model: "kimi-k2.7",
						usage: usage(),
						stopReason: "toolUse",
						timestamp: 3,
					},
					{
						role: "toolResult",
						toolCallId: "call_old",
						toolName: "read",
						content: [{ type: "text", text: "file evidence" }],
						isError: false,
						timestamp: 4,
					},
				],
			},
		})
		const serializedLeadMessages = JSON.stringify(leadContext?.messages)
		const serializedMessages = JSON.stringify(revisionContext?.messages)
		const revisionPayload = String(revisionContext?.messages.at(-1)?.content)
		const leadRequestUpperBound =
			Math.ceil(
				(Buffer.byteLength(serializedLeadMessages) +
					Buffer.byteLength(leadContext?.systemPrompt ?? "") +
					Buffer.byteLength(JSON.stringify(leadContext?.tools ?? []))) /
					4,
			) +
			1024 +
			(leadOptions?.maxTokens ?? 0)
		const revisionRequestUpperBound =
			Math.ceil(
				(Buffer.byteLength(serializedMessages) +
					Buffer.byteLength(revisionContext?.systemPrompt ?? "") +
					Buffer.byteLength(JSON.stringify(revisionContext?.tools ?? []))) /
					4,
			) +
			1024 +
			(revisionOptions?.maxTokens ?? 0)

		expect(serializedLeadMessages).toContain("OLDEST_REVISION_MARKER")
		expect(leadRequestUpperBound).toBeLessThanOrEqual(12_000)
		expect(serializedMessages).toContain("OLDEST_REVISION_MARKER")
		expect(serializedMessages).toContain("CURRENT_OBJECTIVE")
		expect(revisionContext?.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: "CURRENT_OBJECTIVE" }),
		)
		const currentObjectiveIndex =
			revisionContext?.messages.findIndex(
				(message) => message.role === "user" && message.content === "CURRENT_OBJECTIVE",
			) ?? -1
		expect(currentObjectiveIndex).toBeGreaterThanOrEqual(0)
		expect(
			revisionContext?.messages.slice(currentObjectiveIndex, currentObjectiveIndex + 3).map(({ role }) => role),
		).toEqual(["user", "assistant", "toolResult"])
		expect(revisionPayload).toContain(
			'"objective":{"artifact_id":"artifact_message_1_block_0_user_text","text":"CURRENT_OBJECTIVE"}',
		)
		expect(revisionRequestUpperBound).toBeLessThanOrEqual(12_000)
	})

	it("keeps newest bounded evidence and injection strings inside untrusted data", async () => {
		const taskInjection = "TASK_DATA_IGNORE_ROOT"
		const reviewInjection = "REVIEW_DATA_IGNORE_ROOT"
		const captured = new Map<string, Context[]>()
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			const kind = stage(context)
			captured.set(kind, [...(captured.get(kind) ?? []), context])
			if (kind === "review") {
				return response(model, JSON.stringify({ ...JSON.parse(VALID_REVIEW), recommended_changes: [reviewInjection] }))
			}
			if (kind === "judge") {
				return response(model, JSON.stringify({ ...JSON.parse(VALID_JUDGE), revision_instructions: [reviewInjection] }))
			}
			return response(model, kind === "revision" ? "Hierarchy preserved" : "Lead")
		})

		await runCouncil({
			completeModel,
			context: {
				systemPrompt: `ROOT_HEAD ${"😀".repeat(5000)} ROOT_TAIL`,
				messages: [
					{ role: "user", content: `OLDEST_MARKER ${"o".repeat(60_000)}`, timestamp: 1 },
					{ ...response(physicalModel("old"), "m".repeat(60_000)), timestamp: 2 },
					{ role: "user", content: `middle ${"m".repeat(60_000)}`, timestamp: 3 },
					{ role: "user", content: `NEWEST_MARKER ${taskInjection} ${"n".repeat(60_000)}`, timestamp: 4 },
				],
			},
		})
		const reviewer = captured.get("review")?.[0]
		const judge = captured.get("judge")?.[0]
		const revision = captured.get("revision")?.[0]
		const reviewerData = reviewer?.messages[0]?.content
		const reviewerPacket = JSON.parse(String(reviewerData)) as {
			evidence: Array<{ kind: string; text?: string }>
		}
		const judgeData = judge?.messages[0]?.content
		const revisionData = revision?.messages.at(-1)?.content

		expect(Buffer.byteLength(String(reviewerData))).toBeLessThanOrEqual(DEFAULT_COUNCIL_CONFIG.maxEvidenceBytes)
		expect(reviewerData).toEqual(expect.stringContaining("NEWEST_MARKER"))
		expect(reviewerData).not.toEqual(expect.stringContaining("OLDEST_MARKER"))
		expect(reviewerData).toEqual(expect.stringContaining("ROOT_HEAD"))
		expect(reviewerData).toEqual(expect.stringContaining("ROOT_TAIL"))
		expect(
			Buffer.byteLength(reviewerPacket.evidence.find(({ kind }) => kind === "system_instruction")?.text ?? ""),
		).toBeLessThanOrEqual(16_384)
		expect(reviewer?.systemPrompt).toContain("untrusted evidence")
		expect(reviewer?.systemPrompt).not.toContain(taskInjection)
		expect(judge?.systemPrompt).not.toContain(reviewInjection)
		expect(judgeData).toEqual(expect.stringContaining(reviewInjection))
		expect(revision?.systemPrompt).not.toContain(reviewInjection)
		expect(revisionData).toEqual(expect.stringContaining(reviewInjection))
	})

	it("keeps concurrent repair budgets independent", async () => {
		const records: CouncilRunRecord[] = []
		const packets: string[] = []
		const completeModel = vi.fn<CompleteModel>(async (model, context) => {
			const kind = stage(context)
			if (kind === "review") {
				const content = context.messages[0]?.content
				if (typeof content === "string") packets.push(content)
				return response(model, "bad-json")
			}
			if (kind === "repair") return response(model, VALID_REVIEW)
			if (kind === "judge") return response(model, VALID_JUDGE)
			const original = context.messages.find((message) => message.role === "user")
			return response(model, `${kind}:${original?.role === "user" ? original.content : "missing"}`)
		})
		const handler = createCouncilStream({
			config: TEST_COUNCIL_CONFIG,
			getModelRegistry: () => registry(),
			completeModel,
			recordRun: (record) => records.push(record),
		})

		const [a, b] = await Promise.all([
			handler(councilModel, { messages: [{ role: "user", content: "A", timestamp: 1 }] }).result(),
			handler(councilModel, { messages: [{ role: "user", content: "B", timestamp: 1 }] }).result(),
		])
		await Promise.resolve()
		const parsed = packets.map((packet) => JSON.parse(packet) as { run_id: string; objective: { text: string } })

		expect(a.content).toEqual([{ type: "text", text: "revision:A" }])
		expect(b.content).toEqual([{ type: "text", text: "revision:B" }])
		expect(completeModel.mock.calls.filter(([, context]) => stage(context) === "repair")).toHaveLength(2)
		expect(new Set(parsed.map((packet) => packet.run_id))).toHaveLength(2)
		expect(new Set(records.map((record) => record.runId))).toHaveLength(2)
		expect(new Set(parsed.map((packet) => packet.objective.text))).toEqual(new Set(["A", "B"]))
	})

	it("aborts while physical authentication is still pending", async () => {
		let markAuthStarted: (() => void) | undefined
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve
		})
		const modelRegistry = {
			find: vi.fn((provider: string, id: string) => (provider === "kimchi-dev" ? models.get(id) : undefined)),
			getApiKeyAndHeaders: vi.fn(async () => {
				markAuthStarted?.()
				return await new Promise<never>(() => {})
			}),
		} satisfies Registry
		const completeModel = vi.fn<CompleteModel>()
		const controller = new AbortController()
		const pending = runCouncil({ completeModel, modelRegistry, options: { signal: controller.signal } })
		await authStarted

		controller.abort()
		const { result, record } = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("abort was not observed")), 100)),
		])

		expect(result).toMatchObject({ stopReason: "aborted", content: [] })
		expect(completeModel).not.toHaveBeenCalled()
		expect(record).toMatchObject({ outcome: "aborted", stages: [{ stage: "lead", error: "aborted" }] })
	})
})
