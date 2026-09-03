/**
 * Canonical tool-surface measurement for the context-budget CI.
 *
 * Assembles the tool definitions a default single-model session advertises, without
 * needing a running harness:
 * - Upstream builtins via the exported `create*ToolDefinition` factories.
 * - Kimchi extension tool registrations by instantiating each extension factory with
 *   a permissive capture API (every method is a no-op except registerTool, which
 *   records). Registration-time registration only — tools that need a live session
 *   (worker report tools, ferment runtime tools) cannot be measured this way and are
 *   listed as deliberate exclusions.
 *
 * Tool definitions are never executed here; only description/parameter sizes are read.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
// Import order is load-bearing: resources/definitions.ts embeds
// DEFAULT_BASH_TIMEOUT_SECONDS in a description at module scope, so a headless
// import of bash-control/agents/questionnaire must see the timeout module already
// initialized (otherwise TDZ ReferenceError).
import "./bash-default-timeout.js"
import bashControlExtension from "./bash-background/bash-control-extension.js"
import { BASH_CONTROL_TOOL_NAME } from "./bash-background/bash-control-tool.js"
import { createLayer1Tools, createLayer2Tools, DAP_ALWAYS_VISIBLE_TOOL_NAMES, type DapToolDeps } from "./dap/tools.js"
import { LSP_TOOL_NAMES } from "./lsp.js"

export const CHARS_PER_TOKEN = 4

export interface ToolSurfaceEntry {
	name: string
	source: string
	descriptionChars: number
	schemaChars: number
	tokensEstimated: number
}

export interface ToolSurfaceResult {
	tools: ToolSurfaceEntry[]
	/** Tools deliberately NOT measured, with the reason, from `EXTENSION_SOURCES`. */
	exclusions: Array<{ source: string; reason: string }>
}

const CANONICAL_CWD = "/tmp/kimchi-context-budget"

/** Loose tool-cover type: definitions from various `create*ToolDefinition` factories
 * differ in their `TParams`/`TDetails`/`TState` generics but all we read are
 * `name`/`description`/`parameters`. */
// biome-ignore lint/suspicious/noExplicitAny: deliberate type-erase point — heterogeneous tool defs from many factories
type AnyToolDef = ToolDefinition<any, any, any>

function estimate(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

function entry(source: string, tool: AnyToolDef): ToolSurfaceEntry {
	const schemaChars = tool.parameters === undefined ? 0 : JSON.stringify(tool.parameters).length
	return {
		name: tool.name,
		source,
		descriptionChars: tool.description.length,
		schemaChars,
		tokensEstimated: estimate(tool.description.length + schemaChars),
	}
}

/**
 * Deep no-op: callable object where every property access returns another deep
 * no-op, so factories touching `pi.events.emit(...)`, `pi.getFlag(...)`, etc.
 * never throw. `then` returns undefined so awaiting one does not hang.
 */
function createDeepNoop(): unknown {
	const target = () => deepNoop
	const deepNoop: unknown = new Proxy(target, {
		get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : createDeepNoop()),
		apply: () => createDeepNoop(),
	})
	return deepNoop
}

interface CaptureApi {
	api: unknown
	tools: Map<string, AnyToolDef>
	/** Invoke handlers the factory registered for an event (e.g. `session_start`,
	 *  where several extensions register their tools). Best effort: handler
	 *  errors are swallowed — partial sessions don't block measurement. */
	fire: (event: string) => Promise<void>
}

/** Capture pi that tolerates any call, records `registerTool`, and stores
 *  `on()` handlers so the measurement can trigger registration-time hooks. */
function createCaptureApi(): CaptureApi {
	const tools = new Map<string, AnyToolDef>()
	const handlers = new Map<string, Array<(event: unknown) => unknown>>()
	const api = new Proxy(
		{},
		{
			get: (_target, prop) => {
				if (prop === "registerTool") return (tool: AnyToolDef) => tools.set(tool.name, tool)
				if (prop === "on") {
					return (event: string, handler: (payload: unknown) => unknown) => {
						const list = handlers.get(event) ?? []
						list.push(handler)
						handlers.set(event, list)
					}
				}
				if (prop === "then" || typeof prop === "symbol") return undefined
				return createDeepNoop()
			},
		},
	)
	const fire = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) {
			try {
				await handler({})
			} catch {
				// best effort — see interface docstring
			}
		}
	}
	return { api, tools, fire }
}

interface ExtensionSource {
	/** Module specifier, relative to src/extensions/. */
	module: string
	/** Human label for reporting. */
	source: string
}

export const EXTENSION_SOURCES: ExtensionSource[] = [
	{ module: "./todos/index.js", source: "todos" },
	{ module: "./web-search/index.js", source: "web-search" },
	{ module: "./web-fetch/index.js", source: "web-fetch" },
	{ module: "./questionnaire/questionnaire.js", source: "questionnaire" },
	// lsp registers its five tools unconditionally, but the detection
	// gate hides them at session_start when no language server matches the cwd;
	// LSP_TOOL_NAMES are filtered out of the canonical surface below.
	{ module: "./lsp.js", source: "lsp" },
	{ module: "./agents/index.js", source: "agents" },
	// With zero configured MCP servers, the adapter registers no tools at all.
	// context-budget.test.ts mocks this state, so this module contributes
	// nothing to the canonical measurement.
	{ module: "./mcp-adapter/index.js", source: "mcp-adapter" },
	{ module: "./tags.js", source: "tags(set_phase)" },
	{ module: "./claude-code-skills/index.js", source: "claude-code-skills(skill)" },
]

async function measureBuiltinTools(out: Map<string, ToolSurfaceEntry>): Promise<void> {
	const builtins: Array<[string, () => AnyToolDef]> = [
		["read", () => createReadToolDefinition(CANONICAL_CWD)],
		["bash", () => createBashToolDefinition(CANONICAL_CWD)],
		["edit", () => createEditToolDefinition(CANONICAL_CWD)],
		["write", () => createWriteToolDefinition(CANONICAL_CWD)],
		["grep", () => createGrepToolDefinition(CANONICAL_CWD)],
		["find", () => createFindToolDefinition(CANONICAL_CWD)],
		["ls", () => createLsToolDefinition(CANONICAL_CWD)],
	]
	for (const [name, factory] of builtins) {
		out.set(name, entry("upstream:builtin", factory()))
	}
	// bash-control registers in a normal default-export factory *inside*
	// `session_start`; capture it here rather than via EXTENSION_SOURCES so its
	// tool appears alongside builtins/dap in deterministic order.
	const { api: bashControlApi, tools: bashTools, fire: fireBashControl } = createCaptureApi()
	bashControlExtension(bashControlApi as never)
	await fireBashControl("session_start")
	for (const tool of bashTools.values()) {
		// bash_control is registered but hidden at session start until the first
		// background bash handle exists, so it is not part of the canonical
		// surface.
		if (tool.name === BASH_CONTROL_TOOL_NAME) continue
		out.set(tool.name, entry("extension:bash-control", tool))
	}
}

async function measureExtensionTools(
	out: Map<string, ToolSurfaceEntry>,
	exclusions: ToolSurfaceResult["exclusions"],
): Promise<void> {
	for (const { module, source } of EXTENSION_SOURCES) {
		try {
			const imported = (await import(module)) as { default?: (api: unknown) => unknown }
			if (typeof imported.default !== "function") throw new Error("no default factory export")
			const { api, tools, fire } = createCaptureApi()
			await imported.default(api)
			await fire("session_start")
			for (const tool of tools.values()) out.set(tool.name, entry(`extension:${source}`, tool))
		} catch (error) {
			exclusions.push({
				source,
				reason: `factory could not render a tool definition headlessly: ${(error as Error).message}`,
			})
		}
	}
}

/**
 * Factories the canonical measurement is NOT expected to render, and why. If any
 * of these starts rendering headlessly, `measureCanonicalToolSurface` must be
 * updated (re-measure, un-exclude, re-record budgets) — the CI test enforces
 * this as drift detection instead of silently swallowing new tools.
 */
export const EXPECTED_UNRENDERABLE: ReadonlyArray<{ source: string; reason: string }> = [
	{
		source: "ferment",
		reason: "ferment suite tools are registered by the ferment manager with runtime state and do not render headlessly",
	},
	{
		source: "daemon",
		reason: "experimental-gated (cli.ts:598) — out of scope for the default surface by design",
	},
	{
		source: "worker-report",
		reason: "workflow_submit_result/workflow_submit_questions are registered per report step, not at extension load",
	},
	{
		source: "context-assembly/cache-summary",
		reason: "instrumentation extensions register no tools",
	},
]

/** DapToolDeps stubs — layer factories only read deps inside execute(). */
function dapDeps(): DapToolDeps {
	return {
		cwd: CANONICAL_CWD,
		getSession: () => undefined,
		removeSession: () => undefined,
		launchSession: async () => {
			throw new Error("headless measurement never executes launchSession")
		},
	}
}

export async function measureCanonicalToolSurface(): Promise<ToolSurfaceResult> {
	const tools = new Map<string, ToolSurfaceEntry>()
	const exclusions = [...EXPECTED_UNRENDERABLE]
	await measureBuiltinTools(tools)
	await measureExtensionTools(tools, exclusions)
	// DAP tools are measured at their session-start surface: with the Phase 1
	// DAP tools are measured at their session-start surface: only the always-visible
	// set (debug_launch + one-shots) is advertised until a debug session becomes
	// active. The 11 session tools are registered but hidden, so they are not part
	// of the canonical surface.
	for (const tool of [...createLayer1Tools(dapDeps()), ...createLayer2Tools(dapDeps())]) {
		if ((DAP_ALWAYS_VISIBLE_TOOL_NAMES as readonly string[]).includes(tool.name)) {
			tools.set(tool.name, entry("extension:dap", tool))
		}
	}
	// The five lsp_* tools are registered but hidden at session_start when no
	// language server matches the session cwd. The canonical surface assumes the
	// no-server state (a session in a directory without project markers/PATH
	// binaries), so filter them out. A buffer that surfaces them locally (for
	// example, this repo's dev sessions, which match typescript-language-server)
	// exceeds the canonical measurement by exactly their estimate, recorded in the
	// budget test's LSP slice.
	for (const name of LSP_TOOL_NAMES) {
		tools.delete(name)
	}
	return {
		tools: [...tools.values()].sort((a, b) => b.tokensEstimated - a.tokensEstimated),
		exclusions,
	}
}
