import { type ChildProcessByStdio, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import type { Readable, Writable } from "node:stream"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { bridgeCliPath } from "../../commands/bridge.js"

import { type BridgeCommand, type BridgeFailure, createBridgeDiagnostics } from "./diagnostics.js"

export type { BridgeCommand, BridgeFailure } from "./diagnostics.js"

const BRIDGE_COMMAND_TIMEOUT_MS = 3000
const BRIDGE_SIGTERM_GRACE_MS = 250
const MAX_PENDING_TOOL_EXECUTIONS = 64

/**
 * Mirror native Pi tool execution into the bridge's durable workspace activity
 * queue only when the operator explicitly selects the workspace profile. The
 * bridge owns redaction, storage, batching, and delivery. This extension emits
 * no user/ACP messages and performs no uploads itself; inactive profiles or a
 * missing CLI make it inert. Calls remain sequential to preserve Action before
 * Observation, and are bounded per invocation rather than creating an
 * unbounded fire-and-forget process queue.
 */

export interface ToolActivityInput {
	stage: "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
	sessionId: string
	cwd: string
	toolCallId: string
	toolName: string
	args: unknown
	result?: unknown
	errorMessage?: string
	durationMs?: number
	parentToolCallId?: string
}

interface PendingToolActivity {
	toolCallId: string
	sessionId: string
	cwd: string
	toolName: string
	args: unknown
	startedAt: number
	parentToolCallId?: string
}

export interface WorkspaceActivityOptions {
	runCommand?: BridgeCommand
}

export function workspaceActivityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.KIMCHI_BRIDGE_PROFILE === "workspace"
}

function resultErrorMessage(result: unknown): string | undefined {
	if (typeof result === "string") return result || undefined
	if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
	const value = result as { error?: unknown; content?: unknown }
	if (typeof value.error === "string" && value.error) return value.error
	if (!Array.isArray(value.content)) return undefined
	const text = value.content
		.map((part) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return ""
			const block = part as { type?: unknown; text?: unknown }
			return block.type === "text" && typeof block.text === "string" ? block.text : ""
		})
		.filter(Boolean)
		.join("\n")
	return text || undefined
}

/** Pi does not declare parent identity on every execution event version. */
function parentToolCallId(event: object): string | undefined {
	return "parentToolCallId" in event && typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined
}

/** Translate native execution data without mutating the result owned by Pi. */
export function toolActivityEvent(input: ToolActivityInput): Record<string, unknown> {
	const isError = input.stage === "PostToolUseFailure"
	let response = input.result
	if (isError && input.errorMessage) {
		response =
			response && typeof response === "object" && !Array.isArray(response)
				? { ...(response as Record<string, unknown>), error: input.errorMessage }
				: { content: response, error: input.errorMessage }
	}
	return {
		hook_event_name: input.stage,
		session_id: input.sessionId,
		cwd: input.cwd,
		tool_name: input.toolName,
		tool_use_id: input.toolCallId,
		tool_input: input.args ?? {},
		...(input.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(input.durationMs)) } : {}),
		...(input.parentToolCallId ? { parent_tool_call_id: input.parentToolCallId } : {}),
		...(response !== undefined ? { tool_response: response } : {}),
		...(input.stage === "PreToolUse" ? {} : { is_error: isError }),
		...(isError && input.errorMessage ? { error: input.errorMessage } : {}),
	}
}

type BridgeChildProcess = ChildProcessByStdio<Writable, Readable | null, Readable | null>

type BridgeProcessFactory = () => BridgeChildProcess

/** Every failure is bounded and classified; the hook preserves causal ordering. */
export async function runBridgeCommand(
	cliPath: string,
	command: "hook" | "sync",
	cwd: string,
	payload?: Record<string, unknown>,
	spawnProcess: BridgeProcessFactory = (): BridgeChildProcess =>
		spawn(cliPath, [command, ...(command === "hook" ? ["kimchi"] : [])], {
			cwd,
			env: process.env,
			stdio: ["pipe", "ignore", "ignore"],
		}),
): Promise<BridgeFailure | undefined> {
	let encodedPayload: string | undefined
	try {
		encodedPayload = payload === undefined ? undefined : JSON.stringify(payload)
	} catch {
		return "payload_invalid"
	}
	return new Promise<BridgeFailure | undefined>((resolve) => {
		let child: BridgeChildProcess
		try {
			child = spawnProcess()
		} catch {
			resolve("spawn_error")
			return
		}
		let failure: BridgeFailure | undefined
		let settled = false
		let timeout: NodeJS.Timeout | undefined
		let forceKill: NodeJS.Timeout | undefined
		const finish = (outcome?: BridgeFailure) => {
			if (settled) return
			failure ??= outcome
			settled = true
			if (timeout) clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			resolve(failure)
		}
		const terminate = () => {
			if (settled || forceKill) return
			failure ??= "timeout"
			try {
				child.kill()
			} catch {}
			forceKill = setTimeout(() => {
				try {
					child.kill("SIGKILL")
				} catch {
					child.unref()
				} finally {
					child.unref()
					finish(failure)
				}
			}, BRIDGE_SIGTERM_GRACE_MS)
			forceKill.unref?.()
		}
		timeout = setTimeout(terminate, BRIDGE_COMMAND_TIMEOUT_MS)
		timeout.unref?.()
		child.once("error", (error) => {
			const code = (error as { code?: unknown }).code
			finish(code === "ENOENT" || code === "EACCES" || code === "ENOEXEC" ? "spawn_error" : "io_error")
		})
		child.once("close", (code) => {
			if (failure) finish(failure)
			else if (code !== 0) finish("io_error")
			else finish()
		})
		child.stdin.once("error", () => {
			failure ??= "io_error"
			terminate()
		})
		try {
			child.stdin.end(encodedPayload)
		} catch {
			failure ??= "io_error"
			terminate()
		}
	})
}

export default function workspaceActivityExtension(options: WorkspaceActivityOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (!workspaceActivityEnabled()) return
		const diagnostics = createBridgeDiagnostics()
		const runCommand = options.runCommand ?? runBridgeCommand
		const cliPath = bridgeCliPath()
		if (!options.runCommand && !existsSync(cliPath)) {
			diagnostics.note("bridge_missing")
			return
		}

		const pending = new Map<string, PendingToolActivity>()
		const invoke = async (...args: Parameters<BridgeCommand>) => {
			const result = await runCommand(...args)
			if (result) diagnostics.note(result)
		}

		pi.on("tool_execution_start", async (event, ctx) => {
			if (!pending.has(event.toolCallId) && pending.size >= MAX_PENDING_TOOL_EXECUTIONS) {
				const oldest = pending.keys().next().value
				if (oldest !== undefined) {
					pending.delete(oldest)
					diagnostics.note("pending_capacity")
				}
			}
			const call: PendingToolActivity = {
				toolCallId: event.toolCallId,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				toolName: event.toolName,
				args: event.args,
				startedAt: Date.now(),
				parentToolCallId: parentToolCallId(event),
			}
			pending.set(event.toolCallId, call)
			await invoke(
				cliPath,
				"hook",
				call.cwd,
				toolActivityEvent({
					stage: "PreToolUse",
					sessionId: call.sessionId,
					cwd: call.cwd,
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					args: call.args,
					parentToolCallId: call.parentToolCallId,
				}),
			)
			// The fallback interval excludes the pre-hook's own bridge latency.
			call.startedAt = Date.now()
		})
		pi.on("tool_execution_end", async (event) => {
			const call = pending.get(event.toolCallId)
			if (!call) return
			pending.delete(event.toolCallId)
			const errorMessage = event.isError ? resultErrorMessage(event.result) : undefined
			const durationMs =
				typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
					? event.durationMs
					: Date.now() - call.startedAt
			await invoke(
				cliPath,
				"hook",
				call.cwd,
				toolActivityEvent({
					stage: event.isError ? "PostToolUseFailure" : "PostToolUse",
					sessionId: call.sessionId,
					cwd: call.cwd,
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					args: call.args,
					result: event.result,
					errorMessage,
					durationMs,
					parentToolCallId: parentToolCallId(event) ?? call.parentToolCallId,
				}),
			)
		})
		pi.on("session_shutdown", async (_event, ctx) => {
			pending.clear()
			await invoke(cliPath, "sync", ctx.cwd)
		})
	}
}
