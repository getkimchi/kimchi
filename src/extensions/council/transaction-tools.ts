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
import {
	bashCommandTokens,
	isHardBlockedBash,
	isReadOnlyBashCommand,
	isReadOnlyTool,
	parseCommandSegments,
	splitLeadingEnv,
} from "../permissions/taxonomy.js"
import { isCouncilVirtualModel } from "./model.js"
import type {
	CouncilPromotionRequest,
	CouncilSettlementRequest,
	CouncilTransactionRuntime,
} from "./transaction-runtime.js"

export const COUNCIL_DELETE_TOOL = "council_delete_file"
export const COUNCIL_RENAME_TOOL = "council_rename_file"
export const COUNCIL_APPLY_TOOL = "apply_agent_patch"
export const COUNCIL_SETTLE_TOOL = "settle_agent_patch"

const COUNCIL_CUSTOM_TOOLS = [
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
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
const COUNCIL_SAFE_CONTROL_TOOLS = new Set(["ask_user"])
const VALIDATION_SCRIPT = /^(?:test|typecheck|check|lint)(?::[a-z0-9_.-]+)*$/i
const DIRECT_VALIDATORS = new Set(["vitest", "jest", "pytest", "ruff", "mypy"])
const UNSAFE_VALIDATION_SHORT_FLAGS = new Set(["-b", "-c", "-f", "-i", "-o", "-p", "-u", "-w"])
const UNSAFE_VALIDATION_FLAG_NAMES = new Set([
	"buildfile",
	"confcutdir",
	"dir",
	"html",
	"initscript",
	"junitxml",
	"manifestpath",
	"project",
	"projectdir",
	"resultsdirectory",
	"settings",
	"settingsfile",
	"targetdir",
	"testadapterpath",
	"workspace",
])
const UNSAFE_VALIDATION_FLAG_FRAGMENTS = [
	"cache",
	"config",
	"coverage",
	"fix",
	"output",
	"plugin",
	"profile",
	"root",
	"temp",
	"trace",
	"update",
	"watch",
	"workdir",
	"workingdirectory",
	"write",
] as const

function hasUnsafeValidationFlag(tokens: string[]): boolean {
	return tokens.some((token) => {
		if (!token.startsWith("-")) return false
		const flag = token.split("=", 1)[0]?.toLowerCase() ?? ""
		if (UNSAFE_VALIDATION_SHORT_FLAGS.has(flag)) return true
		const normalized = flag.replace(/^-+/, "").replace(/[._-]/g, "")
		return (
			UNSAFE_VALIDATION_FLAG_NAMES.has(normalized) ||
			UNSAFE_VALIDATION_FLAG_FRAGMENTS.some((fragment) => normalized.includes(fragment))
		)
	})
}

function isDirectValidator(tokens: string[]): boolean {
	const [program, subcommand, ...rest] = tokens
	if (!program || hasUnsafeValidationFlag(tokens)) return false
	if (DIRECT_VALIDATORS.has(program)) return program !== "ruff" || subcommand === "check"
	if (program === "biome") return subcommand === "check"
	if (program === "eslint") return true
	if (program === "tsc") return tokens.includes("--noEmit")
	if (program === "go") return subcommand === "test"
	if (program === "cargo") return subcommand === "test" || subcommand === "check" || subcommand === "clippy"
	if (program === "dotnet") return subcommand === "test"
	if (program === "mvn" || program === "mvnw" || program === "./mvnw") {
		return tokens.slice(1).some((token) => token === "test" || token === "verify")
	}
	if (program === "gradle" || program === "gradlew" || program === "./gradlew") {
		return rest.concat(subcommand ?? []).some((token) => token === "test" || token === "check")
	}
	return false
}

export function isCouncilPostApplyValidationCommand(command: string): boolean {
	if (isHardBlockedBash(command) || command.includes("`") || command.includes("$(")) return false
	if (splitLeadingEnv(command).env.length > 0) return false
	const segments = parseCommandSegments(command)
	if (segments.length !== 1 || segments[0]?.ops.length !== 0) return false
	const tokens = bashCommandTokens(command)
	const [program, subcommand] = tokens
	if (!program || hasUnsafeValidationFlag(tokens)) return false
	if (program === "pnpm" || program === "npm" || program === "yarn" || program === "bun") {
		if (subcommand === "test") return true
		if (subcommand === "run") return VALIDATION_SCRIPT.test(tokens[2] ?? "")
		if ((program === "pnpm" || program === "bun") && (subcommand === "exec" || subcommand === "x")) {
			return isDirectValidator(tokens.slice(2))
		}
		return false
	}
	if (program === "npx") return isDirectValidator(tokens.slice(1))
	return isDirectValidator(tokens)
}

export type CouncilRuntimeLookup = (ctx: ExtensionContext) => CouncilTransactionRuntime | undefined

function councilSelected(model: Model<Api> | undefined): boolean {
	return model !== undefined && isCouncilVirtualModel(model)
}

function runtimeOrThrow(lookup: CouncilRuntimeLookup, ctx: ExtensionContext): CouncilTransactionRuntime {
	const runtime = lookup(ctx)
	if (!runtime) throw new Error("Council transaction route is unavailable")
	return runtime
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

export function registerCouncilTransactionTools(pi: ExtensionAPI, cwd: string, lookup: CouncilRuntimeLookup): void {
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
	pi.registerTool(
		defineTool({
			name: COUNCIL_APPLY_TOOL,
			label: "apply reviewed patch",
			description: "Internal Council promotion tool.",
			parameters: Type.Object(
				{
					token: Type.String(),
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council promotion requires a Council model")
				const request: CouncilPromotionRequest = {
					token: params.token,
					transactionId: params.transaction_id,
					patchSha256: params.patch_sha256,
				}
				const receipt = await runtimeOrThrow(lookup, ctx).apply(request)
				return {
					content: [
						{
							type: "text",
							text: `Applied reviewed patch ${receipt.patchSha256}. Run one focused post-apply check.`,
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
					token: Type.String(),
					transaction_id: Type.String(),
					patch_sha256: Type.String(),
					action: Type.Union([Type.Literal("finalize"), Type.Literal("rollback")]),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!councilSelected(ctx.model)) throw new Error("Council settlement requires a Council model")
				const request: CouncilSettlementRequest = {
					token: params.token,
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
			const command =
				event.input && typeof event.input === "object" && "command" in event.input
					? (event.input as { command?: unknown }).command
					: undefined
			if (typeof command === "string" && isReadOnlyBashCommand(command)) return undefined
			if (
				runtime?.state === "post_apply_checks" &&
				typeof command === "string" &&
				isCouncilPostApplyValidationCommand(command)
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
