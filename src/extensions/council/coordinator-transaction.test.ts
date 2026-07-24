import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall, Usage } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { applyCouncilPreset, DEFAULT_COUNCIL_CONFIG } from "./config.js"
import { createCouncilStream } from "./coordinator.js"
import { LEAD_RETRY_SYSTEM_PROMPT, RESERVED_CALLS_FINALIZE_SYSTEM_PROMPT, REVISION_SYSTEM_PROMPT } from "./finalizer.js"
import {
	CheckerReviewOutputSchema,
	CriticReviewOutputSchema,
	FinalCheckOutputSchema,
	IndependentReviewOutputSchema,
	JudgeArtifactSchema,
	stableFindingId,
} from "./schemas.js"
import { CouncilTransactionRuntime } from "./transaction-runtime.js"
import { COUNCIL_APPLY_TOOL, COUNCIL_SETTLE_TOOL } from "./transaction-tools.js"
import type { CouncilConfig, CouncilRunRecord } from "./types.js"
import type { ValidationCheck } from "./validation.js"

vi.mock("../pii-redaction/redactor.js", () => ({
	redactObjectStrings: async (value: unknown) => value,
}))

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const roots: string[] = []
const validationChecks: ValidationCheck[] = [
	{
		id: "package.test",
		kind: "test",
		cwd: ".",
		executable: "node",
		args: ["--test"],
		timeoutMs: 30_000,
		mutationPolicy: "read-only",
		expectedOutputs: [],
	},
]

function transactionRuntime(root: string): CouncilTransactionRuntime {
	return new CouncilTransactionRuntime(root, undefined, validationChecks)
}

const physicalModels = new Map(
	[
		"lead",
		"independent",
		"independent-fallback",
		"critic",
		"checker",
		"checker-fallback",
		"judge",
		"judge-fallback",
	].map((id) => [
		id,
		{
			id,
			name: id,
			api: "openai-completions",
			provider: "test",
			baseUrl: "http://localhost.invalid",
			reasoning: false,
			input: ["text"] as const,
			cost: ZERO_COST,
			contextWindow: 262_144,
			maxTokens: 4096,
		} satisfies Model<Api>,
	]),
)

const registry = {
	find: vi.fn((provider: string, id: string) => (provider === "test" ? physicalModels.get(id) : undefined)),
	getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
} satisfies Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">

const councilModel = {
	id: "council",
	name: "Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: ZERO_COST,
	contextWindow: 262_144,
	maxTokens: 32_768,
} satisfies Model<Api>

const config: CouncilConfig = {
	...DEFAULT_COUNCIL_CONFIG,
	reviewPolicy: "always",
	revisionPolicy: "on-issues",
	maxParallelReviewers: 1,
	lead: { primary: "test/lead", fallbacks: [] },
	reviewers: {
		independent: { primary: "test/independent", fallbacks: [] },
		critic: { primary: "test/critic", fallbacks: [] },
		checker: { primary: "test/checker", fallbacks: [] },
	},
	judge: { primary: "test/judge", fallbacks: [] },
	budget: {
		...DEFAULT_COUNCIL_CONFIG.budget,
		maxEstimatedCostUsd: 1_000_000,
		maxRetriesPerCall: 0,
	},
}

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { ...ZERO_COST, total: 0 },
	}
}

function response(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function toolResponse(model: Model<Api>, call: ToolCall): AssistantMessage {
	return {
		...response(model, ""),
		content: [call],
		stopReason: "toolUse",
	}
}

const cleanReviews = {
	independent: IndependentReviewOutputSchema.parse({
		schema_version: 1,
		role: "independent",
		decision: "accept",
		findings: [],
		recommended_changes: [],
		missing_evidence: [],
		independent_solution: "The candidate satisfies the request.",
		key_claims: [],
		assumptions: [],
		risks: [],
		required_checks: [],
	}),
	critic: CriticReviewOutputSchema.parse({
		schema_version: 1,
		role: "critic",
		decision: "accept",
		findings: [],
		recommended_changes: [],
		missing_evidence: [],
		challenged_assumptions: [],
		counterexamples: [],
		affected_claims: [],
	}),
	checker: CheckerReviewOutputSchema.parse({
		schema_version: 1,
		role: "checker",
		decision: "accept",
		findings: [],
		recommended_changes: [],
		missing_evidence: [],
		requirement_checks: [],
	}),
}

const cleanJudge = JudgeArtifactSchema.parse({
	schema_version: 1,
	decision: "accept",
	dispositions: [],
	consensus: [],
	contradictions: [],
	partial_coverage: [],
	unique_insights: [],
	blind_spots: [],
	unsupported_claims: [],
	required_checks: ["package.test"],
	revision_instructions: [],
	agreement: "high",
})

const revisionCall: ToolCall = {
	type: "toolCall",
	id: "revision-write",
	name: "write",
	arguments: { path: "file.txt", content: "revised\n" },
}

const evidenceGapFinding = {
	severity: "medium" as const,
	statement: "The candidate needs the deterministic package.test validation before it is final.",
	evidence_refs: ["artifact_candidate_validation"],
	assumptions: ["Pre-apply validation cannot inspect the candidate overlay."],
	suggested_check: "package.test",
}
const evidenceGapFindingId = stableFindingId("critic", evidenceGapFinding)

const upheldFinding = {
	severity: "high" as const,
	statement: "The candidate must be replaced with the revised content.",
	evidence_refs: ["artifact_candidate_patch"],
	assumptions: [],
	suggested_check: "Inspect the revised candidate.",
}
const upheldFindingId = stableFindingId("critic", upheldFinding)

type FinalCheckMode = "accept" | "unresolved" | "malformed"

function createModelDriver(
	options: { needsRevision?: boolean; validationGap?: boolean; finalCheck?: FinalCheckMode } = {},
) {
	let focusedCheckerCalls = 0
	let focusedPayload: {
		candidate_patch_sha256: string
		revision_gate: { obligations: Array<{ id: string }> }
	} | null = null

	const completeModel = vi.fn(
		async (model: Model<Api>, context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => {
			const systemPrompt = context.systemPrompt ?? ""
			const last = context.messages.at(-1)
			const lastText = last?.role === "user" && typeof last.content === "string" ? last.content : ""

			if (systemPrompt.includes("one focused final checker")) {
				focusedCheckerCalls++
				const payload = JSON.parse(lastText) as NonNullable<typeof focusedPayload>
				focusedPayload = payload
				if (options.finalCheck === "malformed") return response(model, '{"schema_version":1,"role":"checker"}')
				const status = options.finalCheck === "unresolved" ? "unresolved" : "resolved"
				const artifact = FinalCheckOutputSchema.parse({
					schema_version: 1,
					role: "checker",
					decision: status === "resolved" ? "accept" : "reject",
					patch_sha256: payload.candidate_patch_sha256,
					resolutions: payload.revision_gate.obligations.map(({ id }) => ({
						obligation_id: id,
						status,
						rationale: status === "resolved" ? "The revised patch satisfies this obligation." : "Still unresolved.",
						evidence_refs: status === "resolved" ? ["artifact_candidate_patch"] : [],
					})),
				})
				return response(model, JSON.stringify(artifact))
			}

			if (systemPrompt.includes("Repair the supplied object")) {
				return response(model, '{"schema_version":1,"role":"checker"}')
			}
			if (model.id === "independent") return response(model, JSON.stringify(cleanReviews.independent))
			if (model.id === "critic") {
				const critic = options.validationGap
					? CriticReviewOutputSchema.parse({
							...cleanReviews.critic,
							decision: "needs_evidence",
							findings: [evidenceGapFinding],
							recommended_changes: ["Wait for package.test validation."],
							missing_evidence: ["package.test"],
						})
					: options.needsRevision
						? CriticReviewOutputSchema.parse({
								...cleanReviews.critic,
								decision: "revise",
								findings: [upheldFinding],
								recommended_changes: ["Replace the candidate with the revised content."],
							})
						: cleanReviews.critic
				return response(model, JSON.stringify(critic))
			}
			if (model.id === "checker") {
				const payload = JSON.parse(lastText) as {
					requirements?: Array<{ id: string }>
					evidence?: Array<{ artifact_id: string }>
				}
				return response(
					model,
					JSON.stringify({
						...cleanReviews.checker,
						requirement_checks: (payload.requirements ?? []).map(({ id }) => ({
							requirement: id,
							status: "satisfied",
							evidence_refs: payload.evidence?.[0]?.artifact_id ? [payload.evidence[0].artifact_id] : [],
						})),
					}),
				)
			}
			if (model.id === "judge") {
				const judge = options.validationGap
					? JudgeArtifactSchema.parse({
							...cleanJudge,
							decision: "needs_evidence",
							dispositions: [
								{
									finding_id: evidenceGapFindingId,
									disposition: "needs_evidence",
									rationale: "The candidate can be proved by the selected deterministic validation.",
									evidence_refs: [],
									revision_instruction: null,
									required_check: "package.test",
								},
							],
							required_checks: ["package.test"],
							agreement: "medium",
						})
					: options.needsRevision
						? JudgeArtifactSchema.parse({
								...cleanJudge,
								decision: "revise",
								dispositions: [
									{
										finding_id: upheldFindingId,
										disposition: "upheld",
										rationale: "The candidate itself must change.",
										evidence_refs: ["artifact_candidate_patch"],
										revision_instruction: "Replace the candidate with the revised content.",
										required_check: null,
									},
								],
								required_checks: ["package.test"],
								revision_instructions: ["Replace the candidate with the revised content."],
							})
						: cleanJudge
				return response(model, JSON.stringify(judge))
			}
			if (lastText.includes("<council_review_data>")) return toolResponse(model, revisionCall)
			if (systemPrompt.includes("continuing the single permitted Council revision")) {
				return response(model, "The staged candidate now resolves every obligation.")
			}
			return response(model, "Lead candidate summary.")
		},
	)

	return {
		completeModel,
		focusedCheckerCalls: () => focusedCheckerCalls,
		focusedPayload: () => focusedPayload,
	}
}

function runCouncil(
	runtime: CouncilTransactionRuntime,
	completeModel: ReturnType<typeof createModelDriver>["completeModel"],
	options?: SimpleStreamOptions,
	runConfig: CouncilConfig = config,
	recordRun?: (record: CouncilRunRecord) => void,
) {
	return createCouncilStream({
		config: runConfig,
		getModelRegistry: () => registry,
		completeModel,
		transaction: runtime,
		recordRun,
	})(
		councilModel,
		{
			messages: [{ role: "user", content: "Make the requested change.", timestamp: 1 }],
			tools: [{ name: "write", description: "Write a file", parameters: { type: "object" } }],
		},
		options,
	)
}

async function fixture(): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "council-coordinator-transaction-"))
	const file = join(root, "file.txt")
	await writeFile(file, "before\n")
	roots.push(root)
	return { root, file }
}

async function advanceToRevision(
	runtime: CouncilTransactionRuntime,
	driver: ReturnType<typeof createModelDriver>,
): Promise<NonNullable<CouncilTransactionRuntime["pendingRevisionGate"]>> {
	await runtime.ensure().stageWrite("file.txt", "candidate\n")
	const result = await runCouncil(runtime, driver.completeModel).result()
	expect(result.content).toEqual([revisionCall])
	expect(runtime.state).toBe("revision")
	const gate = runtime.pendingRevisionGate
	if (!gate || gate.obligations.length === 0) throw new Error("missing revision obligations")
	return gate
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Council coordinator transactions", () => {
	it("reuses only schema-valid structured results for identical transaction inputs", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver()
		const records: CouncilRunRecord[] = []

		await runCouncil(runtime, driver.completeModel, undefined, config, (record) => records.push(record)).result()
		await runCouncil(runtime, driver.completeModel, undefined, config, (record) => records.push(record)).result()

		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual([
			"lead",
			"independent",
			"critic",
			"checker",
			"judge",
			"lead",
		])
		expect(records).toHaveLength(2)
		expect(records[1]?.budget).toMatchObject({ cacheHits: 4, physicalAttempts: 6 })
		expect(records[1]?.stages.filter(({ cacheHit }) => cacheHit)).toHaveLength(4)
	})

	it("keeps a clean candidate staged and emits the exact hidden apply capability after one full review", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const candidate = runtime.current?.changeSet()
		if (!candidate) throw new Error("missing candidate")
		const driver = createModelDriver()

		const result = await runCouncil(runtime, driver.completeModel).result()
		const call = result.content[0]

		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(call).toMatchObject({
			type: "toolCall",
			name: COUNCIL_APPLY_TOOL,
			arguments: {
				transaction_id: candidate.transactionId,
				patch_sha256: candidate.patchSha256,
			},
		})
		expect(result.stopReason).toBe("toolUse")
		expect(runtime.state).toBe("accepted")
		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual([
			"lead",
			"independent",
			"critic",
			"checker",
			"judge",
		])
		const checkerMessage = driver.completeModel.mock.calls
			.find(([model]) => model.id === "checker")?.[1]
			.messages.at(-1)
		if (checkerMessage?.role !== "user" || typeof checkerMessage.content !== "string")
			throw new Error("missing checker input")
		const checkerInput = JSON.parse(checkerMessage.content) as {
			allowed_evidence_refs: string[]
			required_requirement_ids: string[]
		}
		expect(checkerInput.allowed_evidence_refs).toContain("artifact_candidate_patch")
		expect(checkerInput.required_requirement_ids.length).toBeGreaterThan(0)
		expect(checkerInput.required_requirement_ids.every((id) => id.startsWith("requirement_"))).toBe(true)
		expect(
			Object.fromEntries(
				driver.completeModel.mock.calls.map(([model, _context, options]) => [model.id, options?.maxTokens]),
			),
		).toEqual({
			lead: 4096,
			independent: 2500,
			critic: 4000,
			checker: 4096,
			judge: 4096,
		})
		expect(
			driver.completeModel.mock.calls.some(([, context]) =>
				context.tools?.some(({ name }) => name === COUNCIL_APPLY_TOOL),
			),
		).toBe(false)

		const promotion = runtime.promotionRequest()
		if (!promotion) throw new Error("missing promotion capability")
		await runtime.apply(promotion)
		driver.completeModel.mockClear()
		const validation = await runCouncil(runtime, driver.completeModel).result()
		expect(validation.content[0]).toMatchObject({
			type: "toolCall",
			name: "bash",
			arguments: { command: "node --test", timeout: 30 },
		})
		expect(driver.completeModel).not.toHaveBeenCalled()
		const prepared = await runtime.preparePostApplyCheck()
		if (!prepared) throw new Error("missing deterministic validation check")
		await runtime.recordPostApplyCheck("bash", prepared.command, true)
		const settlement = runtime.settlementRequest("finalize")
		if (!settlement) throw new Error("missing settlement capability")
		await runtime.settle(settlement)
		driver.completeModel.mockClear()

		const final = await runCouncil(runtime, driver.completeModel).result()
		expect(final.content).toEqual([{ type: "text", text: "Lead candidate summary." }])
		expect(final.stopReason).toBe("stop")
		expect(driver.completeModel).not.toHaveBeenCalled()
		expect(await readFile(file, "utf8")).toBe("candidate\n")
	})

	it("promotes judge-selected validation gaps without asking for a source revision", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver({ validationGap: true })
		let record: CouncilRunRecord | undefined

		const result = await runCouncil(runtime, driver.completeModel, undefined, config, (value) => {
			record = value
		}).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual([
			"lead",
			"independent",
			"critic",
			"checker",
			"judge",
		])
		expect(
			driver.completeModel.mock.calls.some(([, context]) => context.systemPrompt?.includes(REVISION_SYSTEM_PROMPT)),
		).toBe(false)
		expect(runtime.pendingRevisionGate).toBeUndefined()
		expect(runtime.pendingPostApplyCheck?.id).toBe("package.test")
		expect(record?.unresolvedFindingCount).toBe(1)
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("clamps deterministic validation to the remaining whole-run deadline", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		await runCouncil(runtime, driver.completeModel).result()
		const promotion = runtime.promotionRequest()
		if (!promotion) throw new Error("missing promotion capability")
		await runtime.apply(promotion)
		const saved = runtime.savedRunBudget
		if (!saved) throw new Error("missing saved Council run budget")
		runtime.saveRunBudget({ ...saved, deadlineAt: Date.now() + 1_500 })

		const validation = await runCouncil(runtime, driver.completeModel).result()
		const call = validation.content[0]
		const timeout =
			call?.type === "toolCall" && typeof call.arguments.timeout === "number" ? call.arguments.timeout : undefined

		expect(timeout).toBeGreaterThan(0)
		expect(timeout).toBeLessThanOrEqual(1.5)
	})

	it("rolls back instead of validating after the whole-run deadline", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		await runCouncil(runtime, driver.completeModel).result()
		const promotion = runtime.promotionRequest()
		if (!promotion) throw new Error("missing promotion capability")
		await runtime.apply(promotion)
		const saved = runtime.savedRunBudget
		if (!saved) throw new Error("missing saved Council run budget")
		runtime.saveRunBudget({ ...saved, deadlineAt: Date.now() - 1 })

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Council whole-run deadline exceeded",
		})
		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("tries the checker fallback after structured output and repair both fail", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		let record: CouncilRunRecord | undefined
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				const systemPrompt = context.systemPrompt ?? ""
				if (model.id === "checker" && !systemPrompt.includes("Repair the supplied object")) {
					return response(model, "not json")
				}
				if (model.id === "checker-fallback") {
					const checker = physicalModels.get("checker")
					if (!checker) throw new Error("missing checker model")
					const valid = await driver.completeModel(checker, context, options)
					const text = valid.content.find((block) => block.type === "text")?.text ?? ""
					return response(model, text)
				}
				return driver.completeModel(model, context, options)
			},
		)
		const fallbackConfig: CouncilConfig = {
			...config,
			reviewers: {
				...config.reviewers,
				checker: { primary: "test/checker", fallbacks: ["test/checker-fallback"] },
			},
		}

		const result = await runCouncil(runtime, completeModel, undefined, fallbackConfig, (value) => {
			record = value
		}).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(completeModel.mock.calls.filter(([model]) => model.id === "checker-fallback")).toHaveLength(1)
		expect(record?.missingReviewerRoles).not.toContain("checker")
		expect(runtime.state).toBe("accepted")
	})

	it("tries the independent fallback after structured output and repair both fail", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		let record: CouncilRunRecord | undefined
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "independent") return response(model, "not json")
				if (model.id === "independent-fallback") {
					const independent = physicalModels.get("independent")
					if (!independent) throw new Error("missing independent model")
					const valid = await driver.completeModel(independent, context, options)
					const text = valid.content.find((block) => block.type === "text")?.text ?? ""
					return response(model, text)
				}
				return driver.completeModel(model, context, options)
			},
		)
		const fallbackConfig: CouncilConfig = {
			...config,
			reviewers: {
				...config.reviewers,
				independent: { primary: "test/independent", fallbacks: ["test/independent-fallback"] },
			},
		}

		const result = await runCouncil(runtime, completeModel, undefined, fallbackConfig, (value) => {
			record = value
		}).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(completeModel.mock.calls.filter(([model]) => model.id === "independent-fallback")).toHaveLength(1)
		expect(record?.missingReviewerRoles).not.toContain("independent")
		expect(runtime.state).toBe("accepted")
	})

	it("tries one judge fallback after the primary output and repair both fail", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		let record: CouncilRunRecord | undefined
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "judge") return response(model, "not json")
				if (model.id === "judge-fallback") {
					const judge = physicalModels.get("judge")
					if (!judge) throw new Error("missing judge model")
					const valid = await driver.completeModel(judge, context, options)
					const text = valid.content.find((block) => block.type === "text")?.text ?? ""
					return response(model, text)
				}
				return driver.completeModel(model, context, options)
			},
		)
		const fallbackConfig: CouncilConfig = {
			...config,
			judge: { primary: "test/judge", fallbacks: ["test/judge-fallback"] },
		}

		const result = await runCouncil(runtime, completeModel, undefined, fallbackConfig, (value) => {
			record = value
		}).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(completeModel.mock.calls.filter(([model]) => model.id === "judge-fallback")).toHaveLength(1)
		expect(
			completeModel.mock.calls.filter(([, context]) => context.systemPrompt?.includes("Repair the supplied object")),
		).toHaveLength(1)
		expect(record?.stages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "judge", error: "invalid_output", schemaErrorCode: "missing_json" }),
				expect.objectContaining({ stage: "repair", error: "invalid_output", schemaErrorCode: "missing_json" }),
			]),
		)
		expect(record?.stages.some(({ stage, fallback }) => stage === "judge" && fallback)).toBe(true)
		expect(runtime.state).toBe("accepted")
	})

	it("repairs the primary judge output before trying an alternate judge", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		let repairPayload: { allowed_validation_check_ids?: string[] } | undefined
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				const systemPrompt = context.systemPrompt ?? ""
				if (systemPrompt.includes("Repair the supplied object")) {
					const last = context.messages.at(-1)
					const text = last && typeof last.content === "string" ? last.content : ""
					repairPayload = JSON.parse(text) as typeof repairPayload
					return response(model, JSON.stringify(cleanJudge))
				}
				if (model.id === "judge") return response(model, "not json")
				if (model.id === "judge-fallback") throw new Error("fallback unavailable")
				return driver.completeModel(model, context, options)
			},
		)
		const fallbackConfig: CouncilConfig = {
			...config,
			judge: { primary: "test/judge", fallbacks: ["test/judge-fallback"] },
		}

		const result = await runCouncil(runtime, completeModel, undefined, fallbackConfig).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(repairPayload?.allowed_validation_check_ids).toEqual(["package.test"])
		expect(completeModel.mock.calls.filter(([model]) => model.id === "judge-fallback")).toHaveLength(0)
		expect(runtime.state).toBe("accepted")
	})

	it("adjudicates and promotes a fast-mode candidate even though fast text responses skip the judge", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()

		const result = await runCouncil(
			runtime,
			driver.completeModel,
			undefined,
			applyCouncilPreset(config, "fast"),
		).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual(["lead", "critic", "judge"])
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("returns needs-evidence failure when no deterministic validation check exists", async () => {
		const { root, file } = await fixture()
		const runtime = new CouncilTransactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.stopReason).toBe("error")
		expect(result.errorMessage).toContain("no safe deterministic validation checks")
		expect(driver.completeModel.mock.calls.map(([model]) => model.id)).toEqual(["lead"])
		expect(runtime.state).toBe("discarded")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("preserves revision obligations and promotes only after one focused checker resolves all of them", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver({ needsRevision: true, finalCheck: "accept" })
		const gate = await advanceToRevision(runtime, driver)
		expect(gate.obligations).toEqual([
			{
				id: upheldFindingId,
				kind: "finding",
				statement: upheldFinding.statement,
				severity: "high",
			},
			expect.objectContaining({
				kind: "requirement",
				statement: "Replace the candidate with the revised content.",
			}),
		])
		expect(() => runtime.markFullReview()).toThrow("one full review")
		expect(() => runtime.reopenForRevision(gate.reviewedPatchSha256)).toThrow("only one lead revision")

		await runtime.ensure().stageWrite("file.txt", "revised\n")
		const revised = runtime.current?.changeSet()
		if (!revised) throw new Error("missing revised candidate")
		expect(runtime.pendingRevisionGate).toEqual(gate)
		expect(await readFile(file, "utf8")).toBe("before\n")

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: COUNCIL_APPLY_TOOL,
			arguments: {
				transaction_id: revised.transactionId,
				patch_sha256: revised.patchSha256,
			},
		})
		expect(driver.focusedCheckerCalls()).toBe(1)
		expect(driver.focusedPayload()?.revision_gate).toEqual(gate)
		expect(runtime.pendingRevisionGate).toBeUndefined()
		expect(runtime.pendingPostApplyCheck?.id).toBe("package.test")
		expect(runtime.state).toBe("accepted")
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it("tries the checker fallback after a malformed focused-check result cannot be repaired", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver({ needsRevision: true, finalCheck: "malformed" })
		await advanceToRevision(runtime, driver)
		await runtime.ensure().stageWrite("file.txt", "revised\n")
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "checker-fallback" && context.systemPrompt?.includes("one focused final checker")) {
					const checker = physicalModels.get("checker")
					if (!checker) throw new Error("missing checker model")
					const valid = await createModelDriver({ finalCheck: "accept" }).completeModel(checker, context, options)
					const text = valid.content.find((block) => block.type === "text")?.text ?? ""
					return response(model, text)
				}
				return driver.completeModel(model, context, options)
			},
		)
		const fallbackConfig: CouncilConfig = {
			...config,
			reviewers: {
				...config.reviewers,
				checker: { primary: "test/checker", fallbacks: ["test/checker-fallback"] },
			},
		}

		const result = await runCouncil(runtime, completeModel, undefined, fallbackConfig).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(completeModel.mock.calls.filter(([model]) => model.id === "checker-fallback")).toHaveLength(1)
		expect(runtime.state).toBe("accepted")
	})

	it("discards a revision when its continuation response is serialized tool markup", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver({ needsRevision: true })
		await advanceToRevision(runtime, driver)
		await runtime.ensure().stageWrite("file.txt", "revised\n")
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (context.systemPrompt?.includes("continuing the single permitted Council revision")) {
					return response(model, "<|tool_calls_section_begin|><|tool_call_begin|>functions.grep")
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result.stopReason).toBe("error")
		expect(runtime.state).toBe("discarded")
		expect(runtime.acceptedResponse).toBeUndefined()
		expect(await readFile(file, "utf8")).toBe("before\n")
	})

	it.each(["unresolved", "malformed"] as const)("fails closed and discards a %s focused-check result", async (mode) => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver({ needsRevision: true, finalCheck: mode })
		await advanceToRevision(runtime, driver)
		await runtime.ensure().stageWrite("file.txt", "revised\n")

		const result = await runCouncil(runtime, driver.completeModel).result()

		expect(result.stopReason).toBe("error")
		expect(result.content).toEqual([])
		expect(runtime.state).toBe("discarded")
		expect(runtime.promotionRequest()).toBeUndefined()
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(driver.focusedCheckerCalls()).toBe(1)
	})

	it.each([
		["one repair per stage", 1, ["checker"] as const],
		["two repairs per run", 2, ["critic", "judge"] as const],
	])("keeps the %s budget across transaction tool rounds", async (_label, repairsUsed, repairedStages) => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver({ needsRevision: true, finalCheck: "malformed" })
		await advanceToRevision(runtime, driver)
		const saved = runtime.savedRunBudget
		if (!saved) throw new Error("missing saved Council run budget")
		runtime.saveRunBudget({ ...saved, repairsUsed, repairedStages: [...repairedStages] })
		await runtime.ensure().stageWrite("file.txt", "revised\n")

		const result = await runCouncil(runtime, driver.completeModel).result()
		const repairCalls = driver.completeModel.mock.calls.filter(([, context]) =>
			context.systemPrompt?.includes("Repair the supplied object"),
		)

		expect(result.stopReason).toBe("error")
		expect(repairCalls).toHaveLength(0)
		expect(runtime.savedRunBudget).toMatchObject({
			repairsUsed,
			repairedStages,
		})
	})

	it("discards a staged candidate without touching the workspace when the client is already aborted", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		const client = new AbortController()
		client.abort()

		const result = await runCouncil(runtime, driver.completeModel, { signal: client.signal }).result()

		expect(result.stopReason).toBe("aborted")
		expect(runtime.state).toBe("discarded")
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(driver.completeModel).not.toHaveBeenCalled()
	})

	it("enforces one cumulative call budget across successive tool rounds", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		const driver = createModelDriver()
		const constrained: CouncilConfig = {
			...config,
			maxCalls: 5,
			budget: { ...config.budget, maxLogicalCalls: 5, maxPhysicalAttempts: 5 },
		}

		const first = await runCouncil(runtime, driver.completeModel, undefined, constrained).result()
		expect(first.stopReason).toBe("stop")
		expect(driver.completeModel).toHaveBeenCalledTimes(5)
		expect(runtime.savedRunBudget?.snapshot.logicalCalls).toBe(5)

		const second = await runCouncil(runtime, driver.completeModel, undefined, constrained).result()
		expect(second.stopReason).toBe("error")
		expect(second.errorMessage).toBe("Council run budget exceeded")
		expect(driver.completeModel).toHaveBeenCalledTimes(5)
		expect(runtime.savedRunBudget?.snapshot.logicalCalls).toBe(5)
	})

	it("keeps lead tools available after a staged edit while review capacity remains", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					return toolResponse(model, {
						type: "toolCall",
						id: "lead-follow-up",
						name: "write",
						arguments: { path: "file.txt", content: "candidate follow-up\n" },
					})
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result).toMatchObject({ stopReason: "toolUse" })
		expect(result.content[0]).toMatchObject({ type: "toolCall", id: "lead-follow-up", name: "write" })
		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(completeModel.mock.calls[0]?.[1].tools).toHaveLength(1)
		expect(runtime.state).toBe("staging")
	})

	it("reserves enough calls for review after repeated lead tool rounds", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		runtime.ensure()
		const driver = createModelDriver()
		let toolCalls = 0
		let forcedLeadAttempts = 0
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.tools?.length) {
					toolCalls++
					return toolResponse(model, {
						type: "toolCall",
						id: `lead-tool-${toolCalls}`,
						name: "write",
						arguments: { path: "file.txt", content: "candidate\n" },
					})
				}
				if (model.id === "lead" && context.systemPrompt?.includes(RESERVED_CALLS_FINALIZE_SYSTEM_PROMPT)) {
					forcedLeadAttempts++
					if (forcedLeadAttempts === 1) {
						return {
							...response(model, ""),
							content: [{ type: "thinking", thinking: "Finished internally without a public answer." }],
						}
					}
				}
				return driver.completeModel(model, context, options)
			},
		)
		const constrained: CouncilConfig = {
			...config,
			maxCalls: 16,
			budget: {
				...config.budget,
				maxLogicalCalls: 16,
				maxPhysicalAttempts: 20,
			},
		}
		for (let round = 0; round < 6; round++) {
			expect((await runCouncil(runtime, completeModel, undefined, constrained).result()).stopReason).toBe("toolUse")
		}
		const result = await runCouncil(runtime, completeModel, undefined, constrained).result()
		const leadCalls = completeModel.mock.calls.filter(([model]) => model.id === "lead")
		const finalLeadContext = leadCalls.at(-1)?.[1]

		expect(result.stopReason).toBe("stop")
		expect(leadCalls).toHaveLength(8)
		expect(forcedLeadAttempts).toBe(2)
		expect(finalLeadContext?.tools).toBeUndefined()
		expect(finalLeadContext?.systemPrompt).toContain("Call budget is reserved for review")
		expect(finalLeadContext?.systemPrompt).toContain("previous attempt ended")
		expect(runtime.savedRunBudget?.snapshot.logicalCalls).toBe(12)
	})

	it("reviews a staged candidate after repeated serialized lead tool markup", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver()
		let leadAttempts = 0
		let revisionCalls = 0
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (model.id === "lead" && context.systemPrompt?.includes(REVISION_SYSTEM_PROMPT)) {
					revisionCalls++
					return response(model, "Implemented the requested change and preserved the validated behavior.")
				}
				if (model.id === "lead") {
					leadAttempts++
					if (leadAttempts === 2) {
						expect(context.tools).toBeUndefined()
						expect(context.systemPrompt).toContain(LEAD_RETRY_SYSTEM_PROMPT)
					}
					return response(model, "I'll inspect it. <|tool_calls_section_begin|><|tool_call_begin|>functions.grep")
				}
				return driver.completeModel(model, context, options)
			},
		)

		const result = await runCouncil(runtime, completeModel).result()

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(leadAttempts).toBe(2)
		expect(revisionCalls).toBe(1)
		expect(runtime.state).toBe("accepted")
		expect(runtime.acceptedResponse).toBe("Implemented the requested change and preserved the validated behavior.")
	})

	it("reserves focused-check capacity when revising in the same run", async () => {
		const { root } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const driver = createModelDriver({ needsRevision: true })
		const completeModel = vi.fn(
			async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
				if (context.systemPrompt?.includes(REVISION_SYSTEM_PROMPT) && context.tools === undefined) {
					return response(model, "Revised within the reserved call budget.")
				}
				return driver.completeModel(model, context, options)
			},
		)
		const constrained: CouncilConfig = {
			...config,
			maxCalls: 9,
			budget: { ...config.budget, maxLogicalCalls: 9, maxPhysicalAttempts: 13 },
		}

		const result = await runCouncil(runtime, completeModel, undefined, constrained).result()
		const revisionContext = completeModel.mock.calls.find(([, context]) =>
			context.systemPrompt?.includes(REVISION_SYSTEM_PROMPT),
		)?.[1]

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_APPLY_TOOL })
		expect(revisionContext?.tools).toBeUndefined()
		expect(revisionContext?.systemPrompt).toContain(RESERVED_CALLS_FINALIZE_SYSTEM_PROMPT)
	})

	it("rolls back once when an emitted settlement tool is not executed", async () => {
		const { root, file } = await fixture()
		const runtime = transactionRuntime(root)
		await runtime.ensure().stageWrite("file.txt", "candidate\n")
		const candidate = runtime.propose()
		await runtime.apply(runtime.accept(candidate.patchSha256))
		runtime.recordPostApplyCheck("bash", "pnpm test", true)
		const driver = createModelDriver()

		const first = await runCouncil(runtime, driver.completeModel).result()
		expect(first.content[0]).toMatchObject({ type: "toolCall", name: COUNCIL_SETTLE_TOOL })
		expect(await readFile(file, "utf8")).toBe("candidate\n")

		const second = await runCouncil(runtime, driver.completeModel).result()
		expect(second.stopReason).toBe("error")
		expect(second.errorMessage).toContain("rolled back")
		expect(runtime.state).toBe("rolled_back")
		expect(await readFile(file, "utf8")).toBe("before\n")
		expect(driver.completeModel).not.toHaveBeenCalled()
	})
})
