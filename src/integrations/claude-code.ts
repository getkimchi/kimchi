import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { log } from "@clack/prompts"
import { readJson, writeJson } from "../config/json.js"
import { resolveScopePath } from "../config/scope.js"
import type { ConfigScope } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { confirm } from "../setup-wizard/prompt.js"
import { ANTHROPIC_BASE_URL } from "./constants.js"
import { detectBinaryFactory } from "./detect.js"
import { register } from "./registry.js"
import type { ToolDefinition } from "./types.js"

const CLAUDE_CONFIG_PATH = "~/.claude/settings.json"

const TELEMETRY_LOGS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest"
const TELEMETRY_METRICS_ENDPOINT = "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest"

/**
 * Build the env-var map Claude Code reads from `~/.claude/settings.json`'s
 * `env` block. Setting ANTHROPIC_API_KEY to "" is important — Claude Code
 * picks the first non-empty of (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN)
 * and we want it to use AUTH_TOKEN with our key.
 */
export function claudeCodeEnv(
	apiKey: string,
	baseUrl: string = ANTHROPIC_BASE_URL,
	options?: { telemetryEnabled?: boolean },
): Record<string, string> {
	const env: Record<string, string> = {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "",
		ANTHROPIC_AUTH_TOKEN: apiKey,
		CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
	}
	if (options?.telemetryEnabled) {
		env.CLAUDE_CODE_ENABLE_TELEMETRY = "1"
		env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = TELEMETRY_LOGS_ENDPOINT
		env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = `Authorization=Bearer ${apiKey}`
		env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"
		env.OTEL_LOGS_EXPORTER = "otlp"
		env.OTEL_LOGS_EXPORT_INTERVAL = "15000"
		env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = TELEMETRY_METRICS_ENDPOINT
		env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = `Authorization=Bearer ${apiKey}`
		env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json"
		env.OTEL_METRICS_EXPORTER = "otlp"
		env.OTEL_METRIC_EXPORT_INTERVAL = "15000"
		env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "cumulative"
		env.OTEL_LOG_TOOL_DETAILS = "1"
	}
	return env
}

/**
 * Merge the Claude Code env-var pairs into an existing settings.json `env`
 * object in-place, used both by the writer below and by callers that want
 * to compute the env block without writing to disk (e.g. the inject-mode
 * launcher in `kimchi claude`).
 */
function removeCastAiOtelVar(
	env: Record<string, unknown>,
	endpointKey: string,
	expectedEndpoint: string,
	headerKey: string,
): void {
	if (env[endpointKey] !== expectedEndpoint) return
	env[endpointKey] = undefined
	const headers = env[headerKey]
	if (typeof headers === "string" && headers.startsWith("Authorization=Bearer ")) {
		env[headerKey] = undefined
	}
}

export function injectClaudeCodeEnv(
	env: Record<string, unknown>,
	baseUrl: string,
	apiKey: string,
	options?: { telemetryEnabled?: boolean },
): void {
	const pairs = claudeCodeEnv(apiKey, baseUrl, options)
	for (const [k, v] of Object.entries(pairs)) {
		env[k] = v
	}
	if (!options?.telemetryEnabled) {
		removeCastAiOtelVar(
			env,
			"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
			TELEMETRY_LOGS_ENDPOINT,
			"OTEL_EXPORTER_OTLP_LOGS_HEADERS",
		)
		removeCastAiOtelVar(
			env,
			"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
			TELEMETRY_METRICS_ENDPOINT,
			"OTEL_EXPORTER_OTLP_METRICS_HEADERS",
		)
	}
}

interface EnvDiff {
	kind: "add" | "remove" | "change"
	key: string
	old?: string
	new?: string
}

function envDiff(before: Record<string, unknown>, after: Record<string, unknown>): EnvDiff[] {
	const diffs: ReturnType<typeof envDiff> = []
	const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
	for (const key of allKeys) {
		const a = String(before[key] ?? "")
		const b = String(after[key] ?? "")
		if (a === b) continue

		if (before[key] === undefined || !(key in before)) {
			diffs.push({ kind: "add", key, new: b })
		} else if (after[key] === undefined || !(key in after)) {
			diffs.push({ kind: "remove", key, old: a })
		} else {
			diffs.push({ kind: "change", key, old: a, new: b })
		}
	}
	return diffs
}

function formatDiff(diffs: EnvDiff[]): string {
	if (diffs.length === 0) return "No changes."

	const lines: string[] = []
	for (const d of diffs) {
		if (d.kind === "add") lines.push(`  + ${d.key}: ${d.new}`)
		else if (d.kind === "remove") lines.push(`  - ${d.key}: ${d.old}`)
		else lines.push(`  ~ ${d.key}: ${d.old} → ${d.new}`)
	}
	return lines.join("\n")
}

async function writeClaudeCode(
	scope: ConfigScope,
	apiKey: string,
	_models: readonly ModelMetadata[],
	options?: { telemetryEnabled?: boolean },
): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}

	const path = resolveScopePath(scope, CLAUDE_CONFIG_PATH)
	mkdirSync(dirname(path), { recursive: true })

	const existing = readJson(path)
	const envBlock =
		existing.env && typeof existing.env === "object" && !Array.isArray(existing.env)
			? structuredClone
				? (structuredClone(existing.env) as Record<string, unknown>)
				: (JSON.parse(JSON.stringify(existing.env)) as Record<string, unknown>)
			: {}

	const before = structuredClone
		? structuredClone(envBlock)
		: (JSON.parse(JSON.stringify(envBlock)) as Record<string, unknown>)
	injectClaudeCodeEnv(envBlock, ANTHROPIC_BASE_URL, apiKey, options)
	const diffs = envDiff(before, envBlock)

	if (diffs.length > 0 && process.stdin?.isTTY) {
		log.message(`Claude Code environment variable changes (${path}):`)
		log.message(formatDiff(diffs))

		const answer = await confirm({
			message: "Apply these changes to Claude Code environment variables?",
			initialValue: true,
			backable: false,
		})

		if (answer.kind === "cancel") {
			throw new Error("User cancelled the settings update.")
		}
		if (answer.kind === "next" && !answer.value) {
			throw new Error("User declined the settings update.")
		}
	}

	existing.env = envBlock
	writeJson(path, existing)
}

register({
	id: "claudecode",
	name: "Claude Code",
	description: "Anthropic's Claude Code CLI",
	configPath: CLAUDE_CONFIG_PATH,
	binaryName: "claude",
	isInstalled: detectBinaryFactory("claude"),
	write: writeClaudeCode,
})
