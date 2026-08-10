import type { Api, Context, Model } from "@earendil-works/pi-ai"
import { type AnalystInput, type AnalystPacket, analystPacket, FUSION_ANALYST_RESULT_SCHEMA } from "./adjudicator.js"
import type { CouncilCacheKey } from "./cache.js"
import { CANDIDATE_PATCH_SCHEMA, type CandidatePatch } from "./patch.js"
import {
	COUNCIL_ANSWER_SCHEMA,
	type CombinedFusion,
	type CouncilAnswer,
	CouncilAnswerSchema,
	type FusionAnalysis,
	parseCombinedFusionArtifact,
	parseCouncilAnswer,
	parseSynthesisResult,
	type SynthesisResult,
	SynthesisResultSchema,
} from "./schemas.js"
import {
	type CouncilStageRuntime,
	runStructuredStage,
	type StructuredStageOptions,
	type StructuredStageResult,
	structuredStageContext,
	versionedStructuredStageCacheKey,
} from "./stage-runner.js"
import type { CouncilModelPool } from "./types.js"

export const SYNTHESIS_PROMPT_VERSION = "lead-synthesis-v4"
export const SYNTHESIS_SCHEMA_VERSION = "synthesis-result-v4"
const COMBINED_PROMPT_VERSION = "lead-combined-fusion-v4"
const COMBINED_SCHEMA_VERSION = "combined-fusion-v4"

export const SYNTHESIS_RESULT_SCHEMA = `{"type":"object","additionalProperties":false,"required":["summary","patch"],"properties":{"summary":{"type":"string","description":"One short paragraph in plain prose describing the change for the user, written as if reporting the result directly"},"patch":${CANDIDATE_PATCH_SCHEMA}}}`
export const COMBINED_RESULT_SCHEMA = `{"type":"object","additionalProperties":false,"required":["analysis","summary","patch"],"properties":{"analysis":${FUSION_ANALYST_RESULT_SCHEMA},"summary":{"type":"string","description":"One short paragraph in plain prose describing the change for the user, written as if reporting the result directly"},"patch":${CANDIDATE_PATCH_SCHEMA}}}`

const SYNTHESIS_SYSTEM_PROMPT = `You are the Council lead. Write the final patch for the objective from the comparison and candidate patches. Consensus is the safe core. Where candidates contradict, choose the approach that best satisfies the objective and constraints and briefly justify that choice in your reasoning. Fold in unique insights when they are sound. Write one coherent complete patch with full new file text; never produce a union or concatenation of candidate patches. Also write a short user-facing summary of what the patch actually changes and why, in the plain prose you would use to report the result to the user. Return only JSON: ${SYNTHESIS_RESULT_SCHEMA}.`

const COMBINED_SYSTEM_PROMPT = `You are the Council lead. Compare the supplied solutions and write the final patch in this one call. Agreement is the confidence signal. Put agreement in consensus, conflicts in contradictions, partial work in partial_coverage, useful individual ideas in unique_insights, and uncovered risks in blind_spots. Use consensus as the safe core, choose deliberately where solutions contradict and briefly justify the choice in your reasoning, and fold in sound unique insights. Do not merge solutions or rewrite code as a comparison artifact; write one coherent complete patch in patch. Also write a short user-facing summary of what the patch actually changes and why, in the plain prose you would use to report the result to the user. Return only JSON: ${COMBINED_RESULT_SCHEMA}.`

export interface SynthesisInput {
	objective: string
	constraints: unknown
	analysis: FusionAnalysis
	candidates: readonly CandidatePatch[]
}

export type SynthesisStageRequest = Pick<
	StructuredStageOptions<CandidatePatch>,
	"maxTokens" | "repairMaxTokens" | "deadline"
> & {
	leadPool: CouncilModelPool
	cacheKeyFor: (modelRef: string) => CouncilCacheKey
	input: SynthesisInput
}

export interface CombinedStageRequest
	extends Pick<StructuredStageOptions<CombinedFusion>, "maxTokens" | "repairMaxTokens" | "deadline"> {
	leadPool: CouncilModelPool
	cacheKeyFor: (modelRef: string) => CouncilCacheKey
	input: AnalystInput
}

interface SynthesisPacket {
	objective: string
	constraints: unknown
	analysis: FusionAnalysis
	candidate_patches: Array<{ label: string; patch: CandidatePatch }>
}

function label(index: number): string {
	return index < 26 ? `Solution ${String.fromCharCode(65 + index)}` : `Solution ${index + 1}`
}

export function synthesisSystemPrompt(): string {
	return SYNTHESIS_SYSTEM_PROMPT
}

function combinedSystemPrompt(): string {
	return COMBINED_SYSTEM_PROMPT
}

function synthesisPacket(input: SynthesisInput): SynthesisPacket {
	return {
		objective: input.objective,
		constraints: input.constraints,
		analysis: input.analysis,
		candidate_patches: input.candidates.map((patch, index) => ({ label: label(index), patch })),
	}
}

export function synthesisContext(input: SynthesisInput): Context {
	return structuredStageContext(synthesisSystemPrompt(), synthesisPacket(input))
}

function validSynthesisResult(value: unknown): boolean {
	return SynthesisResultSchema.safeParse(value).success
}

// --- Text-answer synthesis ------------------------------------------------------------------
// The lead pool writes the final answer from the analysis and the candidate answers: consensus is
// the safe core, contradictions are where it must choose, and unique insights are what it folds
// in. Unlike the code path there is no separate patch to stage alongside a summary — the answer
// itself is both the artifact and the message returned to the user.

export const TEXT_SYNTHESIS_PROMPT_VERSION = "lead-text-synthesis-v1"
export const TEXT_SYNTHESIS_SCHEMA_VERSION = "council-answer-synthesis-v1"

export const TEXT_SYNTHESIS_RESULT_SCHEMA = COUNCIL_ANSWER_SCHEMA

const TEXT_SYNTHESIS_SYSTEM_PROMPT = `You are the Council lead. Write the final answer for the objective from the comparison and candidate answers. Consensus is the safe core. Where candidates contradict, choose the position that best satisfies the objective and constraints and briefly justify that choice in your reasoning. Fold in unique insights when they are sound. Write one coherent standalone answer in your own voice; never produce a union or concatenation of the candidate answers. Return only JSON: ${TEXT_SYNTHESIS_RESULT_SCHEMA}.`

export interface TextSynthesisInput {
	objective: string
	constraints: unknown
	analysis: FusionAnalysis
	answers: readonly string[]
}

export type TextSynthesisStageRequest = Pick<
	StructuredStageOptions<CouncilAnswer>,
	"maxTokens" | "repairMaxTokens" | "deadline"
> & {
	leadPool: CouncilModelPool
	cacheKeyFor: (modelRef: string) => CouncilCacheKey
	input: TextSynthesisInput
}

interface TextSynthesisPacket {
	objective: string
	constraints: unknown
	analysis: FusionAnalysis
	candidate_answers: Array<{ label: string; answer: string }>
}

export function textSynthesisSystemPrompt(): string {
	return TEXT_SYNTHESIS_SYSTEM_PROMPT
}

function textSynthesisPacket(input: TextSynthesisInput): TextSynthesisPacket {
	return {
		objective: input.objective,
		constraints: input.constraints,
		analysis: input.analysis,
		candidate_answers: input.answers.map((answer, index) => ({ label: label(index), answer })),
	}
}

export function textSynthesisContext(input: TextSynthesisInput): Context {
	return structuredStageContext(textSynthesisSystemPrompt(), textSynthesisPacket(input))
}

function validTextSynthesisResult(value: unknown): boolean {
	return CouncilAnswerSchema.safeParse(value).success
}

// --- Shared stage plumbing ------------------------------------------------------------------
// The two synthesis stages differ only in their packet shape (patch candidates vs. answer
// candidates), their result type, and their own prompt/schema versions; the cache-key
// derivation and the structured-stage call are one function parameterized by a small
// per-artifact descriptor.

interface SynthesisStageDescriptor<TInput, TResult> {
	systemPrompt: string
	promptVersion: string
	schemaVersion: string
	resultSchema: string
	buildContext: (input: TInput) => Context
	parse: (raw: string) => TResult
	validate: (value: unknown) => boolean
}

function runSynthesisLikeStage<TInput, TResult>(
	descriptor: SynthesisStageDescriptor<TInput, TResult>,
	rt: CouncilStageRuntime,
	request: Pick<StructuredStageOptions<TResult>, "maxTokens" | "repairMaxTokens" | "deadline"> & {
		leadPool: CouncilModelPool
		cacheKeyFor: (modelRef: string) => CouncilCacheKey
		input: TInput
	},
): Promise<StructuredStageResult<TResult> | undefined> {
	const context = descriptor.buildContext(request.input)
	const promptVersion = `${descriptor.promptVersion}:${descriptor.systemPrompt}`
	const schemaVersion = `${descriptor.schemaVersion}:${descriptor.resultSchema}`
	return runStructuredStage(rt, {
		stage: "synthesis",
		pool: request.leadPool,
		schema: schemaVersion,
		maxTokens: request.maxTokens,
		repairMaxTokens: request.repairMaxTokens,
		deadline: request.deadline,
		cacheKeyFor: (modelRef) =>
			versionedStructuredStageCacheKey(request.cacheKeyFor, modelRef, "synthesis", promptVersion, schemaVersion),
		cacheWriteValidate: descriptor.validate,
		cacheReadGuard: descriptor.validate,
		prepareContext: (_model: Model<Api>, requestedMaxTokens: number) => ({ context, requestedMaxTokens }),
		parse: descriptor.parse,
	})
}

const SYNTHESIS_DESCRIPTOR: SynthesisStageDescriptor<SynthesisInput, SynthesisResult> = {
	systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
	promptVersion: SYNTHESIS_PROMPT_VERSION,
	schemaVersion: SYNTHESIS_SCHEMA_VERSION,
	resultSchema: SYNTHESIS_RESULT_SCHEMA,
	buildContext: synthesisContext,
	parse: parseSynthesisResult,
	validate: validSynthesisResult,
}

const TEXT_SYNTHESIS_DESCRIPTOR: SynthesisStageDescriptor<TextSynthesisInput, CouncilAnswer> = {
	systemPrompt: TEXT_SYNTHESIS_SYSTEM_PROMPT,
	promptVersion: TEXT_SYNTHESIS_PROMPT_VERSION,
	schemaVersion: TEXT_SYNTHESIS_SCHEMA_VERSION,
	resultSchema: TEXT_SYNTHESIS_RESULT_SCHEMA,
	buildContext: textSynthesisContext,
	parse: parseCouncilAnswer,
	validate: validTextSynthesisResult,
}

export async function runSynthesisStage(
	rt: CouncilStageRuntime,
	request: SynthesisStageRequest,
): Promise<StructuredStageResult<SynthesisResult> | undefined> {
	return runSynthesisLikeStage(SYNTHESIS_DESCRIPTOR, rt, request)
}

export async function runTextSynthesisStage(
	rt: CouncilStageRuntime,
	request: TextSynthesisStageRequest,
): Promise<StructuredStageResult<CouncilAnswer> | undefined> {
	return runSynthesisLikeStage(TEXT_SYNTHESIS_DESCRIPTOR, rt, request)
}

function allowedCheckIds(input: AnalystInput): readonly string[] {
	return [...new Set(input.validationCatalog.map(({ id }) => id))]
}

async function combinedPacket(
	input: AnalystInput,
): Promise<AnalystPacket & { candidate_patches: Array<{ label: string; patch: CandidatePatch }> }> {
	const comparison = await analystPacket(input)
	return {
		...comparison,
		candidate_patches: input.candidates.map((patch, index) => ({ label: label(index), patch })),
	}
}

async function combinedContext(input: AnalystInput): Promise<Context> {
	return structuredStageContext(combinedSystemPrompt(), await combinedPacket(input))
}

function validCombined(value: unknown, allowedIds: readonly string[] | undefined): boolean {
	try {
		parseCombinedFusionArtifact(JSON.stringify(value), allowedIds)
		return true
	} catch {
		return false
	}
}

export async function runCombinedStage(
	rt: CouncilStageRuntime,
	request: CombinedStageRequest,
): Promise<StructuredStageResult<CombinedFusion> | undefined> {
	const context = await combinedContext(request.input)
	const allowedIds = allowedCheckIds(request.input)
	const promptVersion = `${COMBINED_PROMPT_VERSION}:${combinedSystemPrompt()}`
	const schemaVersion = `${COMBINED_SCHEMA_VERSION}:${COMBINED_RESULT_SCHEMA}`
	return runStructuredStage(rt, {
		stage: "combined",
		pool: request.leadPool,
		schema: schemaVersion,
		maxTokens: request.maxTokens,
		repairMaxTokens: request.repairMaxTokens,
		deadline: request.deadline,
		cacheKeyFor: (modelRef) =>
			versionedStructuredStageCacheKey(request.cacheKeyFor, modelRef, "combined", promptVersion, schemaVersion),
		cacheWriteValidate: (value) => validCombined(value, allowedIds),
		cacheReadGuard: (value) => validCombined(value, allowedIds),
		prepareContext: (_model: Model<Api>, requestedMaxTokens: number) => ({ context, requestedMaxTokens }),
		parse: (text) => parseCombinedFusionArtifact(text, allowedIds),
		repairAllowed: () => (allowedIds === undefined ? {} : { validationCheckIds: [...allowedIds] }),
	})
}
