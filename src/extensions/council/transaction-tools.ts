import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { type TSchema, Type } from "typebox"
import { isReadOnlyBashCommand, isReadOnlyTool } from "../permissions/taxonomy.js"
import type { CandidateCheckOutcome } from "./candidate-check.js"
import { isCouncilVirtualModel } from "./model.js"
import type {
	CouncilPromotionRequest,
	CouncilSettlementRequest,
	CouncilTransactionRuntime,
} from "./transaction-runtime.js"
import type { ValidationCheck } from "./validation.js"

export const COUNCIL_DELETE_TOOL = "council_delete_file"
export const COUNCIL_RENAME_TOOL = "council_rename_file"
export const COUNCIL_CHECK_TOOL = "council_check_candidate"
export const COUNCIL_APPLY_TOOL = "apply_agent_patch"
export const COUNCIL_SETTLE_TOOL = "settle_agent_patch"

const COUNCIL_CUSTOM_TOOLS = [
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_CHECK_TOOL,
	COUNCIL_APPLY_TOOL,
	COUNCIL_SETTLE_TOOL,
] as const
const COUNCIL_INTERNAL_TOOLS = new Set([COUNCIL_APPLY_TOOL, COUNCIL_SETTLE_TOOL])
const COUNCIL_TRANSACTION_AWARE_TOOLS = new Set([
	"edit",
	"write",
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_APPLY_TOOL,
	COUNCIL_SETTLE_TOOL,
])
const COUNCIL_SAFE_CONTROL_TOOLS = new Set(["ask_user", COUNCIL_CHECK_TOOL])

export type CouncilRuntimeLookup = (ctx: ExtensionContext) => CouncilTransactionRuntime | undefined

function councilSelected(model: Model<Api> | undefined): boolean {
	return model !== undefined && isCouncilVirtualModel(model)
}

function runtimeOrThrow(lookup: CouncilRuntimeLookup, ctx: ExtensionContext): CouncilTransactionRuntime {
	const runtime = lookup(ctx)
	if (!runtime) throw new Error("Council transaction route is unavailable")
	return runtime
}

/**
 * Describes the catalog check ids the lead may pass to `council_check_candidate`, so it can pick a
 * valid `check_id` without guessing. Built from the same validation catalog the runtime resolves
 * `checkCandidate()` against, so the two never drift.
 */
function candidateCheckToolDescription(validationCatalog: readonly ValidationCheck[]): string {
	const ids = validationCatalog.map((check) => `${check.id} (${check.kind})`).join(", ")
	return (
		"Run one deterministic validation check from the project's catalog against the staged Council " +
		"candidate. The check runs in an isolated temporary workspace built from the candidate; the real " +
		`workspace is never touched. Pass the exact check id from the validation catalog. Available check ids: ${ids}.`
	)
}

function formatCandidateCheckOutcome(outcome: CandidateCheckOutcome): string {
	const status = outcome.timedOut ? "timed out" : outcome.ok ? "passed" : "failed"
	const header =
		`Check "${outcome.id}" (${outcome.kind}) ${status} against the staged candidate in an isolated workspace ` +
		`(exit ${outcome.exitCode ?? "n/a"}, ${outcome.durationMs}ms). The real workspace was not touched.`
	return outcome.output.trim() ? `${header}\n\n${outcome.output}` : header
}

function wrapDefinition<TParams extends TSchema, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
	createPassThrough: (ctx: ExtensionContext) => ToolDefinition<TParams, TDetails, TState>,
	createCandidate: (
		runtime: CouncilTransactionRuntime,
		ctx: ExtensionContext,
	) => ToolDefinition<TParams, TDetails, TState>,
	lookup: CouncilRuntimeLookup,
): ToolDefinition<TParams, TDetails, TState> {
	return {
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!councilSelected(ctx.model)) {
				return createPassThrough(ctx).execute(toolCallId, params, signal, onUpdate, ctx)
			}
			const runtime = runtimeOrThrow(lookup, ctx)
			return createCandidate(runtime, ctx).execute(toolCallId, params, signal, onUpdate, ctx)
		},
	}
}

export function registerCouncilTransactionTools(
	pi: ExtensionAPI,
	cwd: string,
	lookup: CouncilRuntimeLookup,
	validationCatalog: readonly ValidationCheck[] = [],
): void {
	const localRead = createReadToolDefinition(cwd)
	const localEdit = createEditToolDefinition(cwd)
	const localWrite = createWriteToolDefinition(cwd)
	pi.registerTool(
		wrapDefinition(
			localRead,
			(ctx) => createReadToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createReadToolDefinition(ctx.cwd, {
					operations: {
						readFile: (path) => transaction.readBuffer(path),
						access: (path) => transaction.assertAccessible(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		wrapDefinition(
			localEdit,
			(ctx) => createEditToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createEditToolDefinition(ctx.cwd, {
					operations: {
						readFile: (path) => transaction.readBuffer(path),
						writeFile: (path, content) => transaction.stageWrite(path, content),
						access: (path) => transaction.assertAccessible(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		wrapDefinition(
			localWrite,
			(ctx) => createWriteToolDefinition(ctx.cwd),
			(runtime, ctx) => {
				const transaction = runtime.ensure(ctx.cwd)
				return createWriteToolDefinition(ctx.cwd, {
					operations: {
						writeFile: (path, content) => transaction.stageWrite(path, content),
						mkdir: (path) => transaction.stageDirectory(path),
					},
				})
			},
			lookup,
		),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_DELETE_TOOL,
			label: "delete",
			description:
				"Delete a file from the Council candidate. The real workspace is unchanged until review and approval.",
			promptSnippet: "Stage a file deletion in the Council candidate",
			parameters: Type.Object(
				{ path: Type.String({ description: "Workspace-relative or absolute file path" }) },
				{ additionalProperties: false },
			),
			async execute(_toolCallId, { path }, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council candidate tools require a Council model")
				await runtimeOrThrow(lookup, ctx).ensure(ctx.cwd).stageDelete(path)
				return { content: [{ type: "text", text: `Staged deletion: ${path}` }], details: undefined }
			},
		}),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_RENAME_TOOL,
			label: "rename",
			description: "Rename a file in the Council candidate. The real workspace is unchanged until review and approval.",
			promptSnippet: "Stage a file rename in the Council candidate",
			parameters: Type.Object(
				{
					from_path: Type.String({ description: "Existing candidate file path" }),
					to_path: Type.String({ description: "New candidate file path" }),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, { from_path, to_path }, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council candidate tools require a Council model")
				await runtimeOrThrow(lookup, ctx).ensure(ctx.cwd).stageRename(from_path, to_path)
				return {
					content: [{ type: "text", text: `Staged rename: ${from_path} -> ${to_path}` }],
					details: undefined,
				}
			},
		}),
	)
	// A workspace with no catalog checks has nothing council_check_candidate could ever verify, so it
	// is left unregistered rather than advertised as a tool the lead can call but that can never succeed.
	if (validationCatalog.length > 0) {
		pi.registerTool(
			defineTool({
				name: COUNCIL_CHECK_TOOL,
				label: "verify candidate",
				description: candidateCheckToolDescription(validationCatalog),
				promptSnippet: "Verify the staged Council candidate against a catalog check before finishing",
				parameters: Type.Object(
					{ check_id: Type.String({ description: "Validation catalog check id" }) },
					{ additionalProperties: false },
				),
				async execute(_toolCallId, { check_id }, signal, _onUpdate, ctx) {
					if (!councilSelected(ctx.model)) throw new Error("Council candidate verification requires a Council model")
					const outcome = await runtimeOrThrow(lookup, ctx).checkCandidate(check_id, signal)
					return {
						content: [{ type: "text", text: formatCandidateCheckOutcome(outcome) }],
						details: outcome,
					}
				},
			}),
		)
	}
	pi.registerTool(
		defineTool({
			name: COUNCIL_APPLY_TOOL,
			label: "apply reviewed patch",
			description: "Internal Council promotion tool.",
			parameters: Type.Object(
				{
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council promotion requires a Council model")
				const request: CouncilPromotionRequest = {
					transactionId: params.transaction_id,
					patchSha256: params.patch_sha256,
				}
				const receipt = await runtimeOrThrow(lookup, ctx).apply(request)
				return {
					content: [
						{
							type: "text",
							text: `Applied reviewed patch ${receipt.patchSha256}. Continue Council settlement.`,
						},
					],
					details: receipt,
				}
			},
		}),
	)
	pi.registerTool(
		defineTool({
			name: COUNCIL_SETTLE_TOOL,
			label: "settle reviewed patch",
			description: "Internal Council finalization or rollback tool.",
			parameters: Type.Object(
				{
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
					action: Type.Union([Type.Literal("finalize"), Type.Literal("rollback")]),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council settlement requires a Council model")
				const request: CouncilSettlementRequest = {
					transactionId: params.transaction_id,
					patchSha256: params.patch_sha256,
					action: params.action,
				}
				await runtimeOrThrow(lookup, ctx).settle(request)
				return {
					content: [
						{
							type: "text",
							text: request.action === "finalize" ? "Council patch finalized." : "Council patch rolled back.",
						},
					],
					details: undefined,
				}
			},
		}),
	)
}

export function syncCouncilTransactionToolVisibility(pi: ExtensionAPI, model: Model<Api> | undefined): void {
	const councilTools: readonly string[] = COUNCIL_CUSTOM_TOOLS
	const withoutCouncil = pi.getActiveTools().filter((name) => !councilTools.includes(name))
	pi.setActiveTools(councilSelected(model) ? [...withoutCouncil, ...COUNCIL_CUSTOM_TOOLS] : withoutCouncil)
}

export function installCouncilMutationGuard(pi: ExtensionAPI, lookup: CouncilRuntimeLookup): void {
	pi.on("tool_call", (event, ctx) => {
		if (!councilSelected(ctx.model)) return undefined
		const runtime = lookup(ctx)
		const toolName = event.toolName.toLowerCase()
		if (COUNCIL_TRANSACTION_AWARE_TOOLS.has(toolName)) return undefined
		if (COUNCIL_SAFE_CONTROL_TOOLS.has(toolName)) return undefined
		if (isReadOnlyTool(toolName)) return undefined
		if (toolName === "bash") {
			const input = event.input && typeof event.input === "object" ? event.input : undefined
			const command = input && "command" in input ? (input as { command?: unknown }).command : undefined
			if (typeof command === "string" && isReadOnlyBashCommand(command)) return undefined
			const checkId =
				input && "council_check_id" in input ? (input as { council_check_id?: unknown }).council_check_id : undefined
			if (
				runtime?.state === "post_apply_checks" &&
				typeof checkId === "string" &&
				runtime.isExpectedPostApplyCheck(checkId)
			) {
				return undefined
			}
		}
		return {
			block: true,
			reason:
				"Council stages mutations through edit, write, delete, and rename. Other mutating or unknown tools are blocked until the reviewed patch is settled.",
		}
	})
}

export function withoutInternalCouncilTools<T extends { name: string }>(tools: T[]): T[] {
	return tools.filter((tool) => !COUNCIL_INTERNAL_TOOLS.has(tool.name))
}
