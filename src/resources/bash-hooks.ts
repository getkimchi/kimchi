import { execFileSync } from "node:child_process"
import { discoverBashHookResources } from "./bash-hook-discovery.js"
import { readResourceSettings } from "./store.js"
import type { ResourceId } from "./types.js"

export interface BashHookResult {
	command: string
	block?: boolean
	reason?: string
}

interface HookJsonOutput {
	decision?: string
	reason?: string
	command?: string
	input?: unknown
	updated_input?: unknown
}

export function applyEnabledBashHooks(command: string, cwd = process.cwd()): BashHookResult {
	let current = command
	const settings = readResourceSettings()
	for (const hook of discoverBashHookResources(cwd)) {
		if ((settings.resources[hook.id as ResourceId] ?? hook.defaultEnabled) !== true) continue
		const result = runBashHook(hook.path, current, cwd)
		if (result.block) return result
		current = result.command
	}
	return { command: current }
}

export function parseBashHookOutput(stdout: string, command: string): BashHookResult {
	const trimmed = stdout.trim()
	if (!trimmed) return { command }

	const parsed = parseJson(trimmed)
	if (!parsed) return { command: trimmed }

	const decision = typeof parsed.decision === "string" ? parsed.decision.toLowerCase() : "allow"
	if (decision === "block" || decision === "deny") {
		return { command, block: true, reason: parsed.reason ?? "Bash hook blocked command" }
	}

	const input = parseUpdatedInput(parsed.updated_input ?? parsed.input)
	const next = input?.command ?? parsed.command
	return typeof next === "string" && next.trim() ? { command: next } : { command }
}

function runBashHook(path: string, command: string, cwd: string): BashHookResult {
	const payload = JSON.stringify({ tool_name: "bash", input: { command }, cwd })
	const env = {
		...process.env,
		KIMCHI_HOOK_EVENT: "tool_call",
		KIMCHI_TOOL_NAME: "bash",
		KIMCHI_TOOL_INPUT_COMMAND: command,
		// Compatibility with Crush-style bash hook examples.
		CRUSH_TOOL_INPUT_COMMAND: command,
	}

	try {
		const stdout = execFileSync(bashBinary(), [path], {
			cwd,
			env,
			input: payload,
			encoding: "utf-8",
			timeout: 5000,
		})
		return parseBashHookOutput(stdout, command)
	} catch (err) {
		const execErr = err as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string }
		if (execErr.status === 2) {
			return {
				command,
				block: true,
				reason: firstLine(execErr.stderr) ?? firstLine(execErr.stdout) ?? `${path} blocked command`,
			}
		}
		return { command }
	}
}

function bashBinary(): string {
	return process.platform === "win32" ? "bash.exe" : "bash"
}

function parseJson(value: string): HookJsonOutput | undefined {
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookJsonOutput) : undefined
	} catch {
		return undefined
	}
}

function parseUpdatedInput(value: unknown): { command?: string } | undefined {
	if (typeof value === "string") {
		const parsed = parseJson(value)
		return parsed ? parseUpdatedInput(parsed) : undefined
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	const command = (value as Record<string, unknown>).command
	return typeof command === "string" ? { command } : undefined
}

function firstLine(value: string | undefined): string | undefined {
	const line = value?.trim().split(/\r?\n/).find(Boolean)
	return line || undefined
}
