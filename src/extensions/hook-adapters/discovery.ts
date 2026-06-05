import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

export type HookAdapterScope = "user" | "project" | "local"

export type CommandHookEventName =
	| "PreToolUse"
	| "PostToolUse"
	| "SessionStart"
	| "PreCompact"
	| "PostCompact"
	| "UserPromptSubmit"
	| "Stop"
	| "SessionEnd"

export interface CommandHookAdapterDefinition {
	id: string
	label: string
	customType: string
	supportedEvents: readonly CommandHookEventName[]
	sources(cwd?: string): CommandHookSource[]
	defaultTimeoutMs: number
	skipAsyncHandlers?: boolean
	/**
	 * How SessionStart additionalContext reaches the model.
	 * - "nextTurn" (default): sent as a side message before the next turn.
	 * - "systemPrompt": appended to the assembled system prompt on the first
	 *   before_agent_start event, providing a strong steering delivery.
	 */
	sessionStartDelivery?: "nextTurn" | "systemPrompt"
}

export interface CommandHookSource {
	scope: HookAdapterScope
	path: string
	/**
	 * Plugin package root. When set, `${CLAUDE_PLUGIN_ROOT}` (and its Windows
	 * form `%CLAUDE_PLUGIN_ROOT%`) in hook commands are expanded to this value
	 * and the variable is exported into the spawned process environment.
	 */
	pluginRoot?: string
}

export interface CommandHookResource {
	id: string
	adapterId: string
	scope: HookAdapterScope
	path: string
	eventName: CommandHookEventName
	matcher?: string
	command: string
	async: boolean
	timeoutMs: number
	index: number
	env?: Record<string, string>
}

interface HookConfig {
	hooks: Record<string, unknown>
	disableAllHooks?: boolean
}

export function discoverCommandHookResources(
	definition: CommandHookAdapterDefinition,
	cwd = process.cwd(),
): CommandHookResource[] {
	const supported = new Set(definition.supportedEvents)
	const sources = definition.sources(cwd).map((source) => ({
		source,
		config: existsSync(source.path) ? parseHooksConfig(source.path) : undefined,
	}))
	if (sources.some(({ config }) => config?.disableAllHooks)) return []

	const resources: CommandHookResource[] = []

	for (const { source, config } of sources) {
		for (const resource of discoverCommandHooksInFile(definition, source, supported, config)) {
			resources.push(resource)
		}
	}

	return resources.sort((a, b) => a.id.localeCompare(b.id))
}

function discoverCommandHooksInFile(
	definition: CommandHookAdapterDefinition,
	source: CommandHookSource,
	supported: ReadonlySet<CommandHookEventName>,
	config?: HookConfig,
): CommandHookResource[] {
	if (!config) return []

	const resources: CommandHookResource[] = []
	for (const [eventName, entries] of Object.entries(config.hooks)) {
		if (!isSupportedEvent(eventName, supported) || !Array.isArray(entries)) continue
		let eventIndex = 0
		for (const entry of entries) {
			if (!isRecord(entry)) continue
			const matcher = typeof entry.matcher === "string" && entry.matcher.trim() ? entry.matcher : undefined
			const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
			for (const hook of hooks) {
				if (!isRecord(hook)) continue
				if (hook.type !== "command") continue
				const command = selectCommand(hook)
				if (!command) continue
				const async = hook.async === true
				if (async && definition.skipAsyncHandlers) continue
				const index = eventIndex++
				const scopeSegment = source.pluginRoot ? `${source.scope}.${shortHash(source.path)}` : source.scope
				const id = `hooks.${definition.id}.${scopeSegment}.${slug(eventName)}.${index}`
				const resolvedCommand = source.pluginRoot ? expandPluginRoot(command, source.pluginRoot) : command
				const env: Record<string, string> | undefined = source.pluginRoot
					? { CLAUDE_PLUGIN_ROOT: source.pluginRoot }
					: undefined
				resources.push({
					id,
					adapterId: definition.id,
					scope: source.scope,
					path: source.path,
					eventName,
					matcher,
					command: resolvedCommand,
					async,
					timeoutMs: timeoutMs(hook.timeout, definition.defaultTimeoutMs),
					index,
					env,
				})
			}
		}
	}
	return resources
}

function parseHooksConfig(path: string): HookConfig | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"))
		if (!isRecord(parsed)) return undefined
		return {
			hooks: isRecord(parsed.hooks) ? parsed.hooks : {},
			disableAllHooks: parsed.disableAllHooks === true,
		}
	} catch {
		return undefined
	}
}

function selectCommand(hook: Record<string, unknown>): string | undefined {
	const command =
		process.platform === "win32" ? (hook.commandWindows ?? hook.command_windows ?? hook.command) : hook.command
	return typeof command === "string" && command.trim() ? command : undefined
}

function timeoutMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallback
}

function isSupportedEvent(value: string, supported: ReadonlySet<CommandHookEventName>): value is CommandHookEventName {
	return supported.has(value as CommandHookEventName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function slug(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

function expandPluginRoot(command: string, pluginRoot: string): string {
	return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|%CLAUDE_PLUGIN_ROOT%/g, pluginRoot)
}
