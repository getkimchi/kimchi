import { randomUUID } from "node:crypto"
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ToolCall,
} from "@earendil-works/pi-ai"
import type { ChangeSet } from "../../agent-patch/index.js"
import { validateCouncilConfig } from "./config.js"
import {
	type CompiledCouncilContext,
	ContextCompilerError,
	compileCouncilContext,
	councilConstraints,
} from "./context-compiler.js"
import { runFusionPipeline } from "./fusion-pipeline.js"
import { type CandidatePatch, stagePatch } from "./patch.js"
import {
	type CompletePhysicalModel,
	type CouncilModelRegistry,
	canResolvePhysicalModel,
	debugLog,
	PhysicalInvocationError,
	PhysicalModelInvoker,
	validatePhysicalModelPools,
} from "./physical-invoker.js"
import { createCouncilProgressEmitter } from "./progress-ui.js"
import { dispatchResumedTransaction } from "./resume-dispatch.js"
import {
	mayDeliberateCouncilAnswer,
	shouldDeliberateCouncilAnswer,
	shouldReviewCouncilCandidate,
	shouldReviewCouncilTurn,
} from "./review-policy.js"
import {
	addUsage,
	type CouncilCacheKey,
	CouncilRunContext,
	CouncilSessionCache,
	cacheStatsDelta,
	hashCouncilCacheValue,
	type RunBudgetLimits,
	RunFailure,
	safeDegradedReason,
	safeFailureReason,
	sanitizeRunRecord,
	toCouncilBudgetUsage,
	ZERO_USAGE,
} from "./run-context.js"
import {
	type CouncilConfig,
	type CouncilDegradedReason,
	type CouncilModelPool,
	type CouncilProgressEvent,
	type CouncilRunRecord,
	CouncilSchemaError,
	type CouncilStage,
	type CouncilStageRecord,
	type SafeCouncilFailureReason,
} from "./schemas.js"
import { MAX_REPAIRS_PER_RUN, RepairBudget } from "./stage-runner.js"
import {
	ANALYST_PROMPT_VERSION,
	ANALYST_SCHEMA_VERSION,
	type AnalystInput,
	dropUnrenderableCandidates,
	runAnalystStage,
	runCombinedStage,
	runSolverStage,
	runSynthesisStage,
	runTextAnalystStage,
	runTextSolverStage,
	runTextSynthesisStage,
	SYNTHESIS_PROMPT_VERSION,
	SYNTHESIS_SCHEMA_VERSION,
	solverSystemPrompt,
	synthesisSystemPrompt,
	TEXT_ANALYST_PROMPT_VERSION,
	TEXT_ANALYST_SCHEMA_VERSION,
	TEXT_SYNTHESIS_PROMPT_VERSION,
	TEXT_SYNTHESIS_SCHEMA_VERSION,
	type TextAnalystInput,
	textSolverSystemPrompt,
	textSynthesisSystemPrompt,
} from "./stages.js"
import { CouncilStreamWriter, virtualizePublicMessage as virtualize } from "./stream.js"
import {
	COUNCIL_APPLY_TOOL,
	COUNCIL_CHECK_TOOL,
	type CouncilTransactionRuntime,
	withoutInternalCouncilTools,
} from "./transaction.js"

export const LEAD_OUTPUT_SYSTEM_PROMPT =
	"Finish this turn with either a normal user-facing answer or a valid tool call. Do not return only internal reasoning."
export const LEAD_RETRY_SYSTEM_PROMPT =
	"The previous attempt ended without a user-facing answer or tool call. Correct that now."
export const LEAD_VERIFY_STAGED_SYSTEM_PROMPT =
	"Before finishing this turn, verify your staged changes: call council_check_candidate with a catalog check id. " +
	"If the check fails, fix the staged files and check again."
const SERIALIZED_TOOL_CALL_MARKERS = [
	"<|tool_calls_section_begin|>",
	"<|tool_call_begin|>",
	"<|tool_call_argument_begin|>",
] as const

export function publicContent(message: AssistantMessage): (TextContent | ToolCall)[] {
	return message.content.filter((block): block is TextContent | ToolCall => block.type !== "thinking")
}

export function hasInvalidToolCalls(blocks: readonly (TextContent | ToolCall)[], context: Context): boolean {
	const ids = new Set<string>()
	const allowedNames = new Set(context.tools?.map((tool) => tool.name) ?? [])
	for (const block of blocks) {
		if (block.type !== "toolCall") continue
		if (
			typeof block.id !== "string" ||
			!block.id.trim() ||
			typeof block.name !== "string" ||
			!block.name.trim() ||
			!allowedNames.has(block.name) ||
			block.arguments === null ||
			typeof block.arguments !== "object" ||
			Array.isArray(block.arguments)
		) {
			return true
		}
		if (ids.has(block.id)) return true
		ids.add(block.id)
	}
	return false
}

export function hasSerializedToolCallMarkup(text: string): boolean {
	return SERIALIZED_TOOL_CALL_MARKERS.some((marker) => text.includes(marker))
}

const CHANGE_OPERATION_KIND_ORDER = ["create", "update", "delete", "rename"] as const
type ChangeOperationKind = (typeof CHANGE_OPERATION_KIND_ORDER)[number]
const CHANGE_OPERATION_VERB: Record<ChangeOperationKind, string> = {
	create: "created",
	update: "updated",
	delete: "deleted",
	rename: "renamed",
}
const MAX_LISTED_CHANGED_FILES = 3
const GENERIC_CHANGE_SET_MESSAGE = "Applied the staged change."

function changedFileName(path: string): string {
	const segments = path.split("/")
	return segments[segments.length - 1] || path
}

function describeChangeGroup(kind: ChangeOperationKind, paths: readonly string[]): string {
	if (paths.length === 0) return ""
	const verb = CHANGE_OPERATION_VERB[kind]
	if (paths.length > MAX_LISTED_CHANGED_FILES) return `${verb} ${paths.length} files`
	if (paths.length === 1) return `${verb} ${changedFileName(paths[0])}`
	return `${verb} ${paths.map(changedFileName).join(", ")}`
}

function joinChangeGroupPhrases(phrases: readonly string[]): string {
	if (phrases.length === 0) return ""
	if (phrases.length === 1) return phrases[0]
	return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`
}

export function describeChangeSet(changeSet: ChangeSet): string {
	const grouped = new Map<ChangeOperationKind, string[]>()
	for (const operation of changeSet.operations) {
		const paths = grouped.get(operation.kind) ?? []
		paths.push(operation.path)
		grouped.set(operation.kind, paths)
	}
	const phrases = CHANGE_OPERATION_KIND_ORDER.map((kind) => describeChangeGroup(kind, grouped.get(kind) ?? [])).filter(
		Boolean,
	)
	if (phrases.length === 0) {
		const fileCount = changeSet.stats.files
		return fileCount > 0 ? `Updated ${fileCount} file${fileCount === 1 ? "" : "s"}.` : GENERIC_CHANGE_SET_MESSAGE
	}
	const sentence = joinChangeGroupPhrases(phrases)
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

function safeDescribeChangeSet(changeSet: ChangeSet): string {
	try {
		const description = describeChangeSet(changeSet)
		return description.trim() ? description : GENERIC_CHANGE_SET_MESSAGE
	} catch {
		return GENERIC_CHANGE_SET_MESSAGE
	}
}

export function resolvePublicMessage(
	leadProse: string | undefined,
	synthesisSummary: string | undefined,
	changeSet: ChangeSet,
): string {
	if (leadProse?.trim()) return leadProse
	if (synthesisSummary?.trim()) return synthesisSummary
	return safeDescribeChangeSet(changeSet)
}

const NO_CHANGES_NEEDED_MESSAGE = "No changes were needed."

function resolveNoOpPublicMessage(leadProse: string | undefined, synthesisSummary: string | undefined): string {
	if (leadProse?.trim()) return leadProse
	if (synthesisSummary?.trim()) return synthesisSummary
	return NO_CHANGES_NEEDED_MESSAGE
}

function candidatePatchFromChangeSet(candidate: ChangeSet): CandidatePatch {
	return {
		operations: candidate.operations.map((operation) => {
			switch (operation.kind) {
				case "create":
					return { op: "create", path: operation.path, content: operation.content }
				case "update":
					return { op: "update", path: operation.path, content: operation.content }
				case "delete":
					return { op: "delete", path: operation.path }
				case "rename":
					return { op: "rename", path: operation.fromPath, new_path: operation.path }
				default:
					throw new Error("Council candidate contains an unsupported operation")
			}
		}),
	}
}

const STRUCTURED_STAGE_MAX_TOKENS: Record<Exclude<CouncilStage, "lead">, number> = {
	solver: 6_000,
	analyst: 8_000,
	synthesis: 8_000,
	combined: 12_000,
	repair: 8_000,
}

function structuredStageMaxTokens(stage: Exclude<CouncilStage, "lead">, configuredMaximum: number): number {
	return Math.min(configuredMaximum, STRUCTURED_STAGE_MAX_TOKENS[stage])
}

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
}

function withoutEphemeralRunId(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutEphemeralRunId)
	if (!value || typeof value !== "object") return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "run_id")
			.map(([key, item]) => [key, withoutEphemeralRunId(item)]),
	)
}

function councilCacheKey({
	context,
	candidate,
	draft,
	packet,
	role,
	modelId,
	prompt,
	schema,
}: {
	context: CompiledCouncilContext
	candidate?: ChangeSet
	draft: string
	packet: unknown
	role: string
	modelId: string
	prompt: string
	schema: string
}): CouncilCacheKey {
	const baseIdentity = candidate
		? [...candidate.base]
				.sort((left, right) => left.path.localeCompare(right.path))
				.map(({ path, exists, sha256, mode }) => ({ path, exists, sha256, mode }))
		: context.artifacts.filter(({ kind }) => kind !== "assistant_text" && kind !== "candidate_patch")
	return {
		patchHash: candidate?.patchSha256 ?? hashCouncilCacheValue(draft),
		baseSnapshotHash: hashCouncilCacheValue(baseIdentity),
		objectiveHash: hashCouncilCacheValue(context.objective.text),
		constraintsHash: hashCouncilCacheValue(councilConstraints(context)),
		evidenceHash: hashCouncilCacheValue(withoutEphemeralRunId(packet)),
		role,
		modelId,
		promptVersion: hashCouncilCacheValue(prompt),
		schemaVersion: hashCouncilCacheValue(schema),
	}
}

/** Binds a run's context/candidate/draft once, returning a factory for per-stage cache-key builders. */
function cacheKeyForContext(
	context: CompiledCouncilContext,
	candidate: ChangeSet | undefined,
	draft: string,
): (role: string, packet: unknown, prompt: string, schema: string) => (modelId: string) => CouncilCacheKey {
	return (role, packet, prompt, schema) => (modelId) =>
		councilCacheKey({ context, candidate, draft, packet, role, modelId, prompt, schema })
}

function internalToolUse(
	virtualModel: Model<Api>,
	usage: AssistantMessage["usage"],
	name: string,
	arguments_: Record<string, unknown>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `council_tool_${randomUUID()}`, name, arguments: arguments_ }],
		api: virtualModel.api,
		provider: virtualModel.provider,
		model: virtualModel.id,
		usage: structuredClone(usage),
		stopReason: "toolUse",
		timestamp: Date.now(),
	}
}

function assistantTextMessage(virtualModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: virtualModel.api,
		provider: virtualModel.provider,
		model: virtualModel.id,
		usage: structuredClone(ZERO_USAGE),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function boundedStructuredText(message: AssistantMessage, maxBytes: number): string {
	if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) {
		throw new Error("Council stage returned non-final structured output")
	}
	const text = textFromAssistant(message)
	if (!text.trim()) throw new Error("Council stage returned no structured output")
	if (Buffer.byteLength(text) > maxBytes) throw new Error("Council structured output exceeds its byte limit")
	return text
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error(`${label} aborted`))
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error(`${label} aborted`))
		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}

function councilPreset(modelId: string): "fast" | "normal" | "deep" {
	if (modelId === "council-fast") return "fast"
	if (modelId === "council-deep") return "deep"
	return "normal"
}

export interface CouncilRuntimeDependencies {
	config: CouncilConfig
	getModelRegistry: () => CouncilModelRegistry | undefined
	completeModel?: CompletePhysicalModel
	recordRun?: (record: CouncilRunRecord) => void
	onProgress?: (event: CouncilProgressEvent) => void
	shouldReviewTurn?: () => boolean
	transaction?: CouncilTransactionRuntime
}

export function createCouncilStream({
	config,
	getModelRegistry,
	completeModel,
	recordRun,
	onProgress,
	shouldReviewTurn,
	transaction,
}: CouncilRuntimeDependencies): (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (virtualModel, context, options = {}) => {
		const stream = createAssistantMessageEventStream()
		const writer = new CouncilStreamWriter(stream)
		const started = Date.now()
		queueMicrotask(async () => {
			let aggregate = structuredClone(ZERO_USAGE)
			const stages: CouncilStageRecord[] = []
			const runId = `council_${randomUUID()}`
			const registry = getModelRegistry()
			const cache = transaction?.cache ?? new CouncilSessionCache()
			const cacheBefore = cache.snapshot()
			const overallTimeoutMs = config.overallTimeoutMs
			const stageTimeoutMs = config.stageTimeoutMs
			const leadMaxTokens = config.leadMaxTokens
			const internalMaxTokens = config.internalMaxTokens
			const configuredMaxEvidenceBytes = config.maxEvidenceBytes
			const configuredMaxStructuredBytes = config.maxStructuredBytes
			const requestedRunLimits: RunBudgetLimits = {
				overallTimeoutMs,
				maxLogicalCalls: config.budget.maxLogicalCalls,
				maxPhysicalAttempts: config.budget.maxPhysicalAttempts,
				maxConcurrentCalls: config.budget.maxConcurrentCalls,
				maxAggregateInputTokens: config.budget.maxAggregateInputTokens,
				maxAggregateOutputTokens: config.budget.maxAggregateOutputTokens,
				maxEvidenceBytes: configuredMaxEvidenceBytes,
				maxStructuredBytes: configuredMaxStructuredBytes,
			}
			const savedRunBudget = transaction?.savedRunBudget
			const runLimits = savedRunBudget?.limits ?? requestedRunLimits
			const maxEvidenceBytes = runLimits.maxEvidenceBytes
			const maxStructuredBytes = runLimits.maxStructuredBytes
			const run = new CouncilRunContext(runLimits, {
				callerSignal: options.signal,
				...(!savedRunBudget && options.timeoutMs ? { callerTimeoutMs: options.timeoutMs } : {}),
				...(savedRunBudget
					? {
							startedAt: savedRunBudget.startedAt,
							deadlineAt: savedRunBudget.deadlineAt,
							initialSnapshot: savedRunBudget.snapshot,
						}
					: {}),
			})
			const repairBudget = new RepairBudget(
				MAX_REPAIRS_PER_RUN,
				savedRunBudget?.repairsUsed ?? 0,
				savedRunBudget?.repairedStages ?? [],
			)
			let outcome: CouncilRunRecord["outcome"] = "error"
			let degradedReason: CouncilDegradedReason | undefined
			const setDegradedReason = (reason?: CouncilDegradedReason): void => {
				if (!reason) return
				if (!degradedReason || degradedReason === "self_fusion" || reason !== "self_fusion") degradedReason = reason
			}
			const leadPool = (): CouncilModelPool => config.lead
			const rolePoolOrSelfFusion = (pool: CouncilModelPool): CouncilModelPool => {
				if (!registry) throw new Error("Council model registry is unavailable")
				const configuredRefs = [pool.primary, ...pool.fallbacks]
				if (configuredRefs.some((modelRef) => canResolvePhysicalModel(registry, modelRef))) return pool
				setDegradedReason("self_fusion")
				return leadPool()
			}

			const parentAborted = () => options.signal?.aborted === true
			const {
				emitProgress,
				emitTransactionProgress,
				startStage,
				completeStage,
				failStage,
				failActiveStages,
				emitRunCompleted,
				emitRunFailure,
			} = createCouncilProgressEmitter({
				runId,
				startedAt: started,
				hasTransaction: transaction !== undefined,
				onProgress,
				getEstimatedCostUsd: () => aggregate.cost.total,
				expectedSolverCount: Math.max(1, config.panelSize - 1),
			})
			const terminalFailureCode = (error: unknown): RunFailure["code"] | undefined => {
				if (error instanceof RunFailure) return error.code
				if (
					error instanceof PhysicalInvocationError &&
					(error.code === "aborted" || error.code === "budget_exceeded" || error.code === "deadline_exceeded")
				) {
					return error.code
				}
				return run.signal.reason instanceof RunFailure ? run.signal.reason.code : undefined
			}
			const rethrowTerminalFailure = (error: unknown): void => {
				if (terminalFailureCode(error)) throw error
			}
			const markStageError = (stage: CouncilStage, error: string, cause?: unknown) => {
				for (let index = stages.length - 1; index >= 0; index--) {
					const record = stages[index]
					if (record.stage !== stage || record.status !== "ok") continue
					record.status = "error"
					record.error = error
					if (cause instanceof CouncilSchemaError) record.schemaErrorCode = cause.code
					return
				}
			}

			emitProgress({ type: "run_started", runId, preset: councilPreset(virtualModel.id), startedAt: started })

			const invoker = registry
				? new PhysicalModelInvoker({
						registry,
						completeModel,
						maxRetriesPerCall: config.budget.maxRetriesPerCall,
						onStage: (record) => {
							stages.push(record)
							if (record.usage) aggregate = addUsage(aggregate, record.usage)
						},
					})
				: undefined
			const invokePhysical = async (
				stage: CouncilStage,
				pool: CouncilConfig["lead"],
				childContext: Context,
				maxTokens: number,
				timeoutMs = stageTimeoutMs,
				prepareContext?: NonNullable<Parameters<PhysicalModelInvoker["invoke"]>[0]["prepareContext"]>,
				fallback = false,
				onTextDelta?: NonNullable<Parameters<PhysicalModelInvoker["invoke"]>[0]["onTextDelta"]>,
			) => {
				if (!invoker) throw new Error("Council model registry is unavailable")
				return await invoker.invoke({
					run,
					runId,
					virtualModelRef: `${virtualModel.provider}/${virtualModel.id}`,
					stage,
					pool,
					context: childContext,
					requestedMaxTokens: maxTokens,
					stageTimeoutMs: timeoutMs,
					parentOptions: options,
					prepareContext,
					fallback,
					onTextDelta,
				})
			}
			const invoke = async (
				stage: CouncilStage,
				pool: CouncilConfig["lead"],
				childContext: Context,
				maxTokens: number,
				timeoutMs = stageTimeoutMs,
				prepareContext?: NonNullable<Parameters<PhysicalModelInvoker["invoke"]>[0]["prepareContext"]>,
				onTextDelta?: NonNullable<Parameters<PhysicalModelInvoker["invoke"]>[0]["onTextDelta"]>,
			): Promise<AssistantMessage> => {
				return (
					await invokePhysical(stage, pool, childContext, maxTokens, timeoutMs, prepareContext, false, onTextDelta)
				).message
			}
			const structuredText = (stage: CouncilStage, message: AssistantMessage): string => {
				try {
					const text = boundedStructuredText(message, maxStructuredBytes)
					run.reserveStructured(Buffer.byteLength(text))
					return text
				} catch (error) {
					markStageError(stage, "invalid_output", error)
					throw error
				}
			}

			const stageRuntime = {
				run,
				cache,
				repairBudget,
				maxStructuredBytes,
				invoke,
				invokePhysical,
				structuredText,
				markStageError,
				startStage,
				completeStage,
				failStage,
				rethrowTerminalFailure,
				pushStage: (record: CouncilStageRecord) => stages.push(record),
			}

			const finish = (
				message: AssistantMessage,
				finalOutcome: "accepted" | "tool_use" | "degraded",
				reason?: CouncilDegradedReason,
			) => {
				outcome = finalOutcome
				setDegradedReason(reason)
				writer.emit(message)
				emitRunCompleted(finalOutcome)
			}
			const fail = (
				errorMessage: string,
				aborted = false,
				reason?: CouncilDegradedReason,
				progressReason?: SafeCouncilFailureReason,
			) => {
				outcome = aborted ? "aborted" : "error"
				setDegradedReason(reason)
				const safeReason = progressReason ?? (aborted ? "cancelled" : safeDegradedReason(reason))
				failActiveStages(safeReason)
				writer.emit({
					role: "assistant",
					content: [],
					api: virtualModel.api,
					provider: virtualModel.provider,
					model: virtualModel.id,
					usage: aggregate,
					stopReason: aborted ? "aborted" : "error",
					errorMessage,
					timestamp: Date.now(),
				})
				emitRunFailure(aborted, safeReason)
			}
			const promoteCandidate = (patchSha256: string, publicResponse: string, reason?: CouncilDegradedReason): void => {
				if (!transaction) throw new Error("Council transaction is unavailable")
				const promotionReason =
					reason ?? (transaction.validationCatalog.length === 0 ? "no_validation_checks" : undefined)
				emitTransactionProgress("applying")
				const request = transaction.accept(patchSha256, publicResponse, promotionReason)
				finish(
					internalToolUse(virtualModel, aggregate, COUNCIL_APPLY_TOOL, {
						transaction_id: request.transactionId,
						patch_sha256: request.patchSha256,
					}),
					"tool_use",
					promotionReason,
				)
			}
			const discardCandidate = async (): Promise<void> => {
				if (!transaction) return
				await transaction.abandon()
			}
			// A candidate whose staged content is byte-identical to what's already on disk is a
			// legitimate outcome (the panel concluded no change is needed), not a failure: it must
			// finish the turn cleanly with no apply/settle call and nothing written to disk.
			const finishNoOp = (leadProse: string | undefined, synthesisSummary: string | undefined): void => {
				finish(
					assistantTextMessage(virtualModel, resolveNoOpPublicMessage(leadProse, synthesisSummary)),
					"accepted",
					"no_changes_needed",
				)
			}
			const stageCandidate = async (
				patch: CandidatePatch,
				leadProse: string | undefined,
				synthesisSummary: string | undefined,
				reason?: CouncilDegradedReason,
				requiredChecks: readonly string[] = [],
			): Promise<boolean> => {
				if (!transaction) throw new Error("Council transaction is unavailable")
				const staged = await stagePatch(transaction.ensure(), patch)
				if (!staged.ok) {
					debugLog(`stageCandidate failed: ${staged.code} (transaction state=${transaction.state})`, staged.error)
					await discardCandidate()
					fail("Council could not stage the synthesized patch.", false, reason ?? "synthesis_failed")
					return false
				}
				if (staged.changeSet.operations.length === 0) {
					await discardCandidate()
					finishNoOp(leadProse, synthesisSummary)
					return true
				}
				const proposed = transaction.propose()
				const publicResponse = resolvePublicMessage(leadProse, synthesisSummary, proposed)
				transaction.setRequiredPostApplyChecks([...requiredChecks])
				promoteCandidate(
					proposed.patchSha256,
					publicResponse,
					reason ?? (requiredChecks.length === 0 ? "no_validation_checks" : undefined),
				)
				return true
			}

			try {
				const resumed = await dispatchResumedTransaction({
					transaction,
					run,
					virtualModel,
					aggregate,
					finish,
					fail,
					internalToolUse,
					publicResponseMessage: assistantTextMessage,
				})
				if (resumed) return
				if (!registry) throw new Error("Council model registry is unavailable")
				validateCouncilConfig(config)
				validatePhysicalModelPools(registry, { lead: leadPool() })
				emitTransactionProgress("exploring")
				startStage("lead")
				const requestedLeadTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : leadMaxTokens
				const availableLeadTools = context.tools ? withoutInternalCouncilTools(context.tools) : undefined
				// Once anything is staged, bash is withdrawn (the lead can no longer run arbitrary shell
				// commands against the real workspace) and council_check_candidate takes its place: the one
				// window where the lead may run a catalog check, against the candidate, in isolation.
				const stagedLeadTools = transaction?.hasStagedChanges
					? availableLeadTools?.filter(({ name }) => name !== "bash")
					: availableLeadTools?.filter(({ name }) => name !== COUNCIL_CHECK_TOOL)
				let activeLeadContext: Context = {
					...context,
					tools: stagedLeadTools,
					systemPrompt: [
						context.systemPrompt,
						LEAD_OUTPUT_SYSTEM_PROMPT,
						transaction?.hasStagedChanges ? LEAD_VERIFY_STAGED_SYSTEM_PROMPT : undefined,
					]
						.filter(Boolean)
						.join("\n\n"),
				}
				const directTurnNeedsReview = shouldReviewTurn?.() ?? shouldReviewCouncilTurn(context)
				// A request substantial enough that it might end in text deliberation must not have its
				// draft streamed live: `shouldDeliberateCouncilAnswer` can only say yes once the lead has
				// answered, so this is a conservative pre-check on the request alone (the same necessary
				// condition that function checks first). A request below the bar can never deliberate, so
				// streaming it live is always safe.
				const mayDeliberateText = mayDeliberateCouncilAnswer(context)
				let streamedLeadText = false
				const leadTextDelta =
					transaction?.hasStagedChanges === true || directTurnNeedsReview || mayDeliberateText
						? undefined
						: (delta: string) => {
								streamedLeadText = writer.emitTextDelta(assistantTextMessage(virtualModel, ""), delta)
							}
				let lead = await invoke(
					"lead",
					config.lead,
					activeLeadContext,
					Math.min(requestedLeadTokens, leadMaxTokens),
					stageTimeoutMs,
					undefined,
					leadTextDelta,
				)
				let leadContent = publicContent(lead)
				const leadText = textFromAssistant(lead)
				const serializedLeadMarkup = hasSerializedToolCallMarkup(leadText)
				// The lead is advertised a different tool set depending on transaction state (bash while
				// exploring, council_check_candidate once staged), so a well-formed call naming a tool from
				// the other state is expected traffic, not a malformed response: drop it below and keep
				// going rather than let hasInvalidToolCalls treat it as fatal. A call is only ever dropped
				// for this reason when its name is otherwise a valid, non-blank string — anything else
				// (blank name, non-string name) is left for hasInvalidToolCalls to reject as malformed.
				const isUnadvertisedToolCall = (block: (typeof leadContent)[number], advertised: Set<string>): boolean =>
					block.type === "toolCall" &&
					typeof block.name === "string" &&
					block.name.trim().length > 0 &&
					!advertised.has(block.name)
				const withoutUnadvertisedToolCalls = (
					content: typeof leadContent,
					advertised: Set<string>,
				): typeof leadContent => content.filter((block) => !isUnadvertisedToolCall(block, advertised))
				const initialAdvertisedNames = new Set(activeLeadContext.tools?.map(({ name }) => name) ?? [])
				const leadContentWithoutUnadvertised = withoutUnadvertisedToolCalls(leadContent, initialAdvertisedNames)
				const droppedTheOnlyToolCall =
					transaction?.hasStagedChanges !== true &&
					leadContent.some((block) => block.type === "toolCall") &&
					!leadContentWithoutUnadvertised.some((block) => block.type === "toolCall")
				if (
					!streamedLeadText &&
					(lead.stopReason === "stop" || droppedTheOnlyToolCall) &&
					!leadContentWithoutUnadvertised.some((block) => block.type === "toolCall") &&
					(!leadText.trim() || serializedLeadMarkup)
				) {
					const forceRetryFinalization = serializedLeadMarkup || transaction?.hasStagedChanges === true
					activeLeadContext = {
						...activeLeadContext,
						tools: forceRetryFinalization ? undefined : stagedLeadTools,
						systemPrompt: [activeLeadContext.systemPrompt, LEAD_RETRY_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
					}
					lead = await invoke("lead", config.lead, activeLeadContext, Math.min(requestedLeadTokens, leadMaxTokens))
					leadContent = publicContent(lead)
				}
				const advertisedLeadToolNames = new Set(activeLeadContext.tools?.map(({ name }) => name) ?? [])
				const droppedUnadvertisedToolCall = leadContent.some((block) =>
					isUnadvertisedToolCall(block, advertisedLeadToolNames),
				)
				if (droppedUnadvertisedToolCall) {
					leadContent = withoutUnadvertisedToolCalls(leadContent, advertisedLeadToolNames)
				}
				if (hasInvalidToolCalls(leadContent, activeLeadContext))
					throw new Error("Council lead returned an invalid tool call")
				if (leadContent.some((block) => block.type === "toolCall")) {
					if (lead.stopReason !== "toolUse") throw new Error("Council lead returned incoherent tool-call termination")
					completeStage("lead")
					finish(virtualize({ ...lead, content: leadContent }, virtualModel, aggregate), "tool_use")
					return
				}
				if (lead.stopReason !== "stop" && !droppedUnadvertisedToolCall)
					throw new Error(`Council lead stopped with ${lead.stopReason}`)
				let draft = textFromAssistant(lead)
				let draftIsPlaceholder = false
				if (transaction?.hasStagedChanges === true && (!draft.trim() || hasSerializedToolCallMarkup(draft))) {
					draft = "Candidate patch staged for review."
					draftIsPlaceholder = true
				}
				if (!draft.trim()) throw new Error("Council lead returned no text")
				if (hasSerializedToolCallMarkup(draft)) throw new Error("Council lead returned serialized tool-call markup")
				completeStage("lead")

				let candidate: ChangeSet | undefined
				if (transaction?.hasStagedChanges) {
					const proposed = transaction.propose()
					if (proposed.operations.length === 0) {
						await discardCandidate()
						finishNoOp(draftIsPlaceholder ? undefined : draft, undefined)
						return
					}
					candidate = proposed
				}
				const reviewCurrentTurn = candidate ? shouldReviewCouncilCandidate(candidate) : false
				if (candidate && !reviewCurrentTurn) {
					const firstCheck = transaction?.validationCatalog[0]?.id
					if (firstCheck) transaction?.setRequiredPostApplyChecks([firstCheck])
					promoteCandidate(
						candidate.patchSha256,
						resolvePublicMessage(draftIsPlaceholder ? undefined : draft, undefined, candidate),
					)
					return
				}
				if (!candidate) {
					if (!shouldDeliberateCouncilAnswer(context, draft)) {
						finish(virtualize({ ...lead, content: leadContent }, virtualModel, aggregate), "accepted")
						return
					}

					// Text fusion: same shape as the code path with no ChangeSet, no ChangeTransaction, and
					// no candidate — the lead's own answer is panel member one, N-1 solvers answer the same
					// frozen packet concurrently, the analyst compares the answers, and the lead pool writes
					// the final answer. Nothing here opens a transaction or runs a validation check.
					const canonicalContext = await raceAbort(
						compileCouncilContext({ context, runId, leadDraft: draft, maxEvidenceBytes }),
						run.signal,
						"Council context compilation",
					)
					run.reserveEvidence(Buffer.byteLength(JSON.stringify(canonicalContext)))
					const frozenInput = {
						objective: canonicalContext.objective.text,
						constraints: councilConstraints(canonicalContext),
						frozenContext: canonicalContext,
					}
					const textCacheKeyFor = cacheKeyForContext(canonicalContext, undefined, draft)
					// Once the lead has answered, no downstream comparison-layer failure (solver, analyst,
					// synthesis, or the whole-run deadline/budget being hit while they run) may lose the
					// turn: fall back to the lead's own answer.
					const promoteLeadAnswer = (reason: CouncilDegradedReason): void => {
						finish(assistantTextMessage(virtualModel, draft), "degraded", reason)
					}

					const pipelineOutcome = await runFusionPipeline<string>(
						{ run, stageRuntime, terminalFailureCode, parentAborted, failActiveStages },
						{
							stageTimeoutMs,
							leadArtifact: draft,
							panel: {
								panelSize: config.panelSize,
								pools: config.panel,
								maxConcurrentCalls: config.budget.maxConcurrentCalls,
								run: async (assignment, deadline) => {
									const result = await runTextSolverStage(stageRuntime, {
										pool: assignment.pool,
										maxTokens: structuredStageMaxTokens("solver", internalMaxTokens),
										repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
										deadline,
										cacheKeyFor: textCacheKeyFor(
											"solver",
											{ ...frozenInput, panel_member: assignment.index },
											textSolverSystemPrompt(),
											"council-answer-v1",
										),
										input: frozenInput,
									})
									return result
										? { value: result.value.answer, modelRef: result.modelRef, cacheHit: result.cacheHit }
										: undefined
								},
							},
							comparison: {
								usable: async (candidates) => candidates,
								runAnalyst: (answers, deadline) => {
									const input: TextAnalystInput = {
										objective: frozenInput.objective,
										constraints: frozenInput.constraints,
										answers,
										shuffleSeed: runId,
									}
									return runTextAnalystStage(stageRuntime, {
										pool: rolePoolOrSelfFusion(config.analyst),
										maxTokens: structuredStageMaxTokens("analyst", internalMaxTokens),
										repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
										deadline,
										cacheKeyFor: textCacheKeyFor(
											"analyst",
											{ objective: input.objective, constraints: input.constraints, answers },
											TEXT_ANALYST_PROMPT_VERSION,
											TEXT_ANALYST_SCHEMA_VERSION,
										),
										input,
									})
								},
								runSynthesis: async (answers, analysis, deadline) => {
									const result = await runTextSynthesisStage(stageRuntime, {
										leadPool: leadPool(),
										maxTokens: structuredStageMaxTokens("synthesis", internalMaxTokens),
										repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
										deadline,
										cacheKeyFor: textCacheKeyFor(
											"synthesis",
											{ analysis, answers },
											`${TEXT_SYNTHESIS_PROMPT_VERSION}:${textSynthesisSystemPrompt()}`,
											TEXT_SYNTHESIS_SCHEMA_VERSION,
										),
										input: {
											objective: frozenInput.objective,
											constraints: frozenInput.constraints,
											analysis,
											answers,
										},
									})
									return result
										? { value: { artifact: result.value.answer }, modelRef: result.modelRef, cacheHit: result.cacheHit }
										: undefined
								},
							},
							promoteLeadArtifact: promoteLeadAnswer,
						},
					)
					if (!pipelineOutcome) return

					finish(assistantTextMessage(virtualModel, pipelineOutcome.artifact), "accepted")
					return
				}

				if (!transaction) throw new Error("Council transaction is unavailable")
				const canonicalContext = await raceAbort(
					compileCouncilContext({
						context,
						runId,
						leadDraft: draft,
						candidate,
						maxEvidenceBytes,
					}),
					run.signal,
					"Council context compilation",
				)
				run.reserveEvidence(Buffer.byteLength(JSON.stringify(canonicalContext)))
				const leadPatch = candidatePatchFromChangeSet(candidate)
				await discardCandidate()
				// Once the lead has a stageable candidate, no downstream comparison-layer failure (panel,
				// analyst, synthesis, combined, or the whole-run deadline/budget being hit while they run)
				// may discard it: promote the lead's own patch instead of losing the turn.
				const promoteLeadPatch = async (reason: CouncilDegradedReason): Promise<void> => {
					const firstCheck = transaction?.validationCatalog[0]?.id
					await stageCandidate(
						leadPatch,
						draftIsPlaceholder ? undefined : draft,
						undefined,
						reason,
						firstCheck ? [firstCheck] : [],
					)
				}
				const comparisonTransaction = transaction.ensure()
				const frozenInput = {
					objective: canonicalContext.objective.text,
					constraints: councilConstraints(canonicalContext),
					frozenContext: canonicalContext,
				}
				const codeCacheKeyFor = cacheKeyForContext(canonicalContext, candidate, draft)
				const buildAnalystInput = (
					patches: readonly CandidatePatch[],
				): { input: AnalystInput; cacheKeyFor: (modelRef: string) => CouncilCacheKey } => {
					const validationCatalog = transaction?.validationCatalogPrompt ?? []
					const input: AnalystInput = {
						objective: frozenInput.objective,
						constraints: frozenInput.constraints,
						candidates: patches,
						transaction: comparisonTransaction,
						shuffleSeed: runId,
						validationCatalog,
					}
					const keyPacket = {
						objective: input.objective,
						constraints: input.constraints,
						candidates: patches,
						validation_catalog: validationCatalog,
					}
					return {
						input,
						cacheKeyFor: codeCacheKeyFor("analyst", keyPacket, ANALYST_PROMPT_VERSION, ANALYST_SCHEMA_VERSION),
					}
				}
				const isFastPreset = councilPreset(virtualModel.id) === "fast"

				const pipelineOutcome = await runFusionPipeline<CandidatePatch>(
					{ run, stageRuntime, terminalFailureCode, parentAborted, failActiveStages, emitTransactionProgress },
					{
						stageTimeoutMs,
						leadArtifact: leadPatch,
						panel: {
							panelSize: config.panelSize,
							pools: config.panel,
							maxConcurrentCalls: config.budget.maxConcurrentCalls,
							run: (assignment, deadline) =>
								runSolverStage(stageRuntime, {
									pool: assignment.pool,
									maxTokens: structuredStageMaxTokens("solver", internalMaxTokens),
									repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
									deadline,
									cacheKeyFor: codeCacheKeyFor(
										"solver",
										{ ...frozenInput, panel_member: assignment.index },
										solverSystemPrompt(),
										"candidate-patch-v2",
									),
									input: frozenInput,
								}),
						},
						comparison: {
							usable: (patches) => dropUnrenderableCandidates(comparisonTransaction, patches),
							runAnalyst: (patches, deadline) => {
								const { input, cacheKeyFor } = buildAnalystInput(patches)
								return runAnalystStage(stageRuntime, {
									pool: rolePoolOrSelfFusion(config.analyst),
									maxTokens: structuredStageMaxTokens("analyst", internalMaxTokens),
									repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
									deadline,
									cacheKeyFor,
									input,
								})
							},
							runSynthesis: async (patches, analysis, deadline) => {
								const result = await runSynthesisStage(stageRuntime, {
									leadPool: leadPool(),
									maxTokens: structuredStageMaxTokens("synthesis", internalMaxTokens),
									repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
									deadline,
									cacheKeyFor: codeCacheKeyFor(
										"synthesis",
										{ analysis, candidates: patches },
										`${SYNTHESIS_PROMPT_VERSION}:${synthesisSystemPrompt()}`,
										SYNTHESIS_SCHEMA_VERSION,
									),
									input: {
										objective: frozenInput.objective,
										constraints: frozenInput.constraints,
										analysis,
										candidates: patches,
									},
								})
								return result
									? {
											value: { artifact: result.value.patch, summary: result.value.summary },
											modelRef: result.modelRef,
											cacheHit: result.cacheHit,
										}
									: undefined
							},
							runCombined: isFastPreset
								? async (patches, deadline) => {
										const { input, cacheKeyFor } = buildAnalystInput(patches)
										const result = await runCombinedStage(stageRuntime, {
											leadPool: leadPool(),
											maxTokens: structuredStageMaxTokens("combined", internalMaxTokens),
											repairMaxTokens: structuredStageMaxTokens("repair", internalMaxTokens),
											deadline,
											cacheKeyFor,
											input,
										})
										return result
											? {
													value: {
														artifact: result.value.patch,
														summary: result.value.summary,
														analysis: result.value.analysis,
													},
													modelRef: result.modelRef,
													cacheHit: result.cacheHit,
												}
											: undefined
									}
								: undefined,
						},
						promoteLeadArtifact: promoteLeadPatch,
					},
				)
				if (!pipelineOutcome) return

				const requiredChecks = [
					...new Set(pipelineOutcome.analysis.required_checks.map((check) => check.trim()).filter(Boolean)),
				]
				await stageCandidate(
					pipelineOutcome.artifact,
					draftIsPlaceholder ? undefined : draft,
					pipelineOutcome.summary,
					undefined,
					requiredChecks,
				)
			} catch (error) {
				let cleanupFailed = false
				if (transaction && ["staging", "proposed", "accepted", "post_apply_checks"].includes(transaction.state)) {
					try {
						await transaction.abandon()
					} catch (cleanupError) {
						cleanupFailed = true
						debugLog("failed to abandon council transaction during error cleanup", cleanupError)
					}
				}
				const stateForLog = transaction?.state ?? "none"
				if (cleanupFailed || transaction?.state === "hard_recovery") {
					debugLog(`council run entered hard recovery (transaction state=${stateForLog})`, error)
					fail("Council could not safely restore the workspace. Manual recovery is required.")
					return
				}
				const failureCode = terminalFailureCode(error)
				const aborted = parentAborted() || failureCode === "aborted"
				if (aborted) {
					debugLog(`council run aborted (transaction state=${stateForLog})`, error)
					fail("Council request aborted", true)
				} else if (failureCode === "deadline_exceeded") {
					debugLog(`council run deadline exceeded (transaction state=${stateForLog})`, error)
					fail("Council whole-run deadline exceeded", false, "deadline_exceeded")
				} else if (failureCode === "budget_exceeded") {
					const budgetSnapshot = run.snapshot()
					debugLog(
						`council run budget exceeded (transaction state=${stateForLog}, ` +
							`logicalCalls=${budgetSnapshot.logicalCalls}/${run.limits.maxLogicalCalls}, ` +
							`physicalAttempts=${budgetSnapshot.physicalAttempts}/${run.limits.maxPhysicalAttempts}, ` +
							`inputTokens=${budgetSnapshot.inputTokens}/${run.limits.maxAggregateInputTokens}, ` +
							`outputTokens=${budgetSnapshot.outputTokens}/${run.limits.maxAggregateOutputTokens})`,
						error,
					)
					fail("Council run budget exceeded", false, "budget_exceeded")
				} else if (error instanceof PhysicalInvocationError) {
					debugLog(`council physical invocation failed (transaction state=${stateForLog}, code=${error.code})`, error)
					fail("Council could not complete the requested response", false, undefined, safeFailureReason(error))
				} else if (error instanceof Error && error.message === "Council model registry is unavailable") {
					debugLog(`council model registry unavailable (transaction state=${stateForLog})`, error)
					fail("Council model registry is unavailable")
				} else if (error instanceof ContextCompilerError) {
					debugLog(`council context compilation failed (transaction state=${stateForLog})`, error)
					fail("Council could not validate the lead response.", false, "context_compilation_failed")
				} else {
					debugLog(`council run failed with an unclassified error (transaction state=${stateForLog})`, error)
					fail("Council could not produce a complete lead response")
				}
			} finally {
				const runBudgetSnapshot = run.snapshot()
				transaction?.saveRunBudget({
					limits: run.limits,
					startedAt: run.startedAt,
					deadlineAt: run.deadlineAt,
					snapshot: runBudgetSnapshot,
					repairsUsed: repairBudget.usedCount,
					repairedStages: repairBudget.stages,
				})
				run.close()
				try {
					const budget = toCouncilBudgetUsage(runBudgetSnapshot, cacheStatsDelta(cacheBefore, cache.snapshot()))
					const transactionSnapshot = transaction?.snapshot()
					recordRun?.(
						sanitizeRunRecord({
							runId,
							virtualModel: `${virtualModel.provider}/${virtualModel.id}`,
							outcome,
							...(degradedReason ? { degradedReason } : {}),
							durationMs: Date.now() - started,
							stages,
							usage: aggregate,
							budget,
							...(transactionSnapshot ? { transaction: transactionSnapshot } : {}),
						}),
					)
				} catch (error) {
					debugLog("failed to record council run telemetry", error)
				}
			}
		})
		return stream
	}
}
