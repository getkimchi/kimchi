import { spawn } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai"
import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type SessionEntry,
	type SessionHeader,
	type Theme,
} from "@earendil-works/pi-coding-agent"
import { Container, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { v7 as uuidv7 } from "uuid"
import { ToolBlockView, getTextContent } from "../components/tool-block.js"
import { isBunBinary, isRunningUnderBun } from "../env.js"
import { isToolExpanded, registerToolCall } from "../expand-state.js"
import { findExistingFile, resolveUserPath, stripAtPrefix } from "../fs-paths.js"
import { formatCount, formatDuration } from "./format.js"
import { type SpinnerState, clearSpinner, spinnerFrame, tickSpinner } from "./spinner.js"

const PROMPT_MAX_LENGTH = 60
const FOOTER_STATUS_KEY = "subagent-sessions"
export const RESULT_MAX_CHARS = 8000

let activeSessionCounts: Map<string, number> | null = null

export function getActiveSubagentCount(): number {
	if (!activeSessionCounts) return 0
	let total = 0
	for (const n of activeSessionCounts.values()) total += n
	return total
}
const STDERR_MAX = 8192
const TIMEOUT_MS = 30 * 60 * 1000
const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000
const CHECKPOINT_END_TYPE = "subagent-end"
const RECOVERY_MESSAGE_TYPE = "subagent-recovery"
const INTERRUPTED_MESSAGE_TYPE = "subagent-interrupted"

interface SubagentEndCheckpoint {
	toolCallId: string
	accumulated: string
	exitCode: number
	failureReason: SubagentFailureReason | undefined
}

interface SubagentState extends SpinnerState {
	lastToolCall: string | undefined
	executionStartedAt?: number
}

type SubagentFailureReason = "exit_error" | "timeout" | "token_budget_exceeded" | "aborted" | "output_stalled"

interface SubagentTokenUsage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

interface SubagentResult {
	exitCode: number
	accumulated: string
	stderr: string
	tokenUsage: SubagentTokenUsage
	failureReason: SubagentFailureReason | undefined
	durationMs: number
}

interface SubagentError {
	reason: SubagentFailureReason
	model: string
	tokenUsage: SubagentTokenUsage
	durationMs: number
	detail: string
}

interface ParsedSubagentEvent {
	delta: string | null
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	toolCall: { name: string; args: Record<string, unknown> } | null
}

function findDanglingSubagentCalls(branch: SessionEntry[]): ToolCall[] {
	const toolResultIds = new Set<string>()
	let lastToolUseMessage: AssistantMessage | undefined
	for (const entry of branch) {
		if (entry.type !== "message") continue
		const { message } = entry
		if (message.role === "toolResult") toolResultIds.add(message.toolCallId)
		else if (message.role === "assistant" && message.stopReason === "toolUse")
			lastToolUseMessage = message as AssistantMessage
	}
	if (!lastToolUseMessage) return []
	return lastToolUseMessage.content
		.filter((c): c is ToolCall => c.type === "toolCall" && c.name === "subagent")
		.filter((tc) => !toolResultIds.has(tc.id))
}

function findCheckpointInBranch<T extends { toolCallId: string }>(
	branch: SessionEntry[],
	customType: string,
	toolCallId: string,
): T | undefined {
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== customType) continue
		const data = entry.data as T
		if (data?.toolCallId === toolCallId) return data
	}
	return undefined
}

function isAlreadyRecovered(branch: SessionEntry[]): boolean {
	return branch.some(
		(e) =>
			e.type === "custom_message" &&
			(e.customType === RECOVERY_MESSAGE_TYPE || e.customType === INTERRUPTED_MESSAGE_TYPE),
	)
}

function resolveTsx(): string | undefined {
	let dir = dirname(process.argv[1])
	while (true) {
		const candidate = resolve(dir, "node_modules/.bin/tsx")
		if (existsSync(candidate)) return candidate
		if (existsSync(resolve(dir, "package.json"))) break
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return undefined
}

function collectExtensionArgs(): string[] {
	const result: string[] = []
	const argv = process.argv
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			if (i + 1 < argv.length) {
				result.push("-e", argv[i + 1])
				i++
			}
		} else if (argv[i].startsWith("--extension=")) {
			result.push("-e", argv[i].slice("--extension=".length))
		}
	}
	return result
}

export type ValidateAttachmentsResult =
	| { kind: "ok"; resolved: string[] }
	| { kind: "empty" }
	| { kind: "invalid"; missing: string[]; notFile: string[] }

/** Checks that every attachment path supplied by a subagent call points to an existing regular file, reporting which ones are missing and which exist but aren't files. The `findExistingFileFn` and `pathExistsFn` callbacks are exposed for test injection; production callers rely on the defaults. */
export function validateAttachments(
	attachments: string[] | undefined,
	cwd: string,
	findExistingFileFn: (filePath: string, cwd: string) => string | null = findExistingFile,
	pathExistsFn: (absPath: string) => boolean = existsSync,
): ValidateAttachmentsResult {
	if (!attachments || attachments.length === 0) return { kind: "ok", resolved: [] }
	// Empty / whitespace-only entries are almost certainly an LLM formatting bug (e.g. a trailing comma). Fail loudly rather than bucketing into "missing", where the resulting error message would render as "not found: ," and be unreadable.
	if (attachments.some((a) => stripAtPrefix(a).trim().length === 0)) return { kind: "empty" }
	const missing: string[] = []
	const notFile: string[] = []
	const resolved: string[] = []
	const seen = new Set<string>()
	for (const raw of attachments) {
		const abs = findExistingFileFn(raw, cwd)
		if (abs !== null) {
			// Dedupe on the resolved absolute so "./foo" and "foo" collapse to a single @-arg.
			if (!seen.has(abs)) {
				seen.add(abs)
				resolved.push(abs)
			}
			continue
		}
		// findExistingFileFn tried every variant and none was a regular file. pathExistsFn has intentionally looser semantics (returns true for directories, sockets, etc.), so we can distinguish "non-file at that path" (e.g. the user passed a directory) from "nothing at that path" and surface an actionable error.
		if (pathExistsFn(resolveUserPath(raw, cwd))) notFile.push(raw)
		else missing.push(raw)
	}
	if (missing.length > 0 || notFile.length > 0) return { kind: "invalid", missing, notFile }
	return { kind: "ok", resolved }
}

export function buildSubagentArgs(
	params: { provider: string; model: string; prompt: string },
	resolvedAttachments: string[],
	extensionArgs: string[],
	childSessionFile?: string,
): string[] {
	const sessionArgs = childSessionFile !== undefined ? ["--session", childSessionFile] : ["--no-session"]
	return [
		"--mode",
		"json",
		"-p",
		...sessionArgs,
		"--provider",
		params.provider,
		"--model",
		params.model,
		...extensionArgs,
		...resolvedAttachments.map((p) => `@${p}`),
		params.prompt,
	]
}

export interface ChildSessionHandle {
	sessionId: string
	sessionFile: string
}

/** Pre-writes a header-only .jsonl session file for a subagent child so pi-mono's `--session <path>` opens it and preserves the back-reference to the parent. Returns undefined when the parent has no persistent session to link to (in-memory / --no-session parent, or empty session dir). Throws on I/O errors so callers can surface them as subagent failures. Exposed for testing. */
export function prepareChildSessionFile(
	parentSessionDir: string,
	parentSessionFile: string | undefined,
	cwd: string,
	generateId: () => string = uuidv7,
	now: () => Date = () => new Date(),
): ChildSessionHandle | undefined {
	// Parent is in-memory (--no-session) or has no resolvable session dir: there's nothing to back-reference, so skip the pre-write and let the child run with --no-session too. No broken links, no orphan files.
	if (parentSessionFile === undefined || parentSessionDir.length === 0) return undefined
	const sessionId = generateId()
	const timestamp = now().toISOString()
	const sessionFile = join(parentSessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: parentSessionFile,
	}
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 })
	return { sessionId, sessionFile }
}

function getSubagentInvocation(args: string[]): { command: string; args: string[] } {
	// Bun single-file binary: process.execPath IS the self-contained binary and the entry script is baked in, so we spawn with just the CLI args. Do NOT prepend process.argv[1] — it's a virtual /$bunfs/... path that only exists inside this process's embedded filesystem, and the child would either error or misread it as a positional arg.
	if (isBunBinary) {
		return { command: process.execPath, args }
	}
	// Dev under Bun (`bun run src/entry.ts`): process.execPath is the `bun` interpreter, so we must prepend the on-disk entry script as argv[1] for Bun to know what to run. Reusing the same interpreter keeps .md.template imports (Bun-native) working in the child.
	if (isRunningUnderBun) {
		return { command: process.execPath, args: [process.argv[1], ...args] }
	}
	if (process.argv[1].endsWith(".ts")) {
		const tsx = resolveTsx()
		if (tsx !== undefined) {
			return { command: tsx, args: [process.argv[1], ...args] }
		}
		throw new Error(
			"Dev mode requires tsx to spawn subagents, but node_modules/.bin/tsx was not found. Run `pnpm install`.",
		)
	}
	return { command: process.execPath, args: [process.argv[1], ...args] }
}

// Parses a single JSON line from the subagent's --mode json stdout stream.
// Returns text delta from message_update/text_delta events, and separate
// input/output token counts from message_end events.
// The event shapes are internal to pi-coding-agent and may change across versions.
export function parseSubagentEvent(line: string): ParsedSubagentEvent {
	const empty = {
		delta: null,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolCall: null,
	}
	if (!line.trim()) return empty
	let event: Record<string, unknown>
	try {
		event = JSON.parse(line)
	} catch {
		return empty
	}

	if (event.type === "message_update") {
		const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			return { ...empty, delta: assistantEvent.delta }
		}
		return empty
	}

	if (event.type === "message_end") {
		const message = event.message as Record<string, unknown> | undefined
		const usage = message?.usage as Record<string, unknown> | undefined
		if (usage) {
			const inputTokens = typeof usage.input === "number" ? usage.input : 0
			const outputTokens = typeof usage.output === "number" ? usage.output : 0
			const cacheReadTokens = typeof usage.cacheRead === "number" ? usage.cacheRead : 0
			const cacheWriteTokens = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0
			return { ...empty, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
		}
	}

	if (event.type === "tool_execution_start") {
		const name = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : null
		const args = event.args !== null && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {}
		if (name !== null) {
			return { ...empty, toolCall: { name, args } }
		}
	}

	return empty
}

function spawnSubagent(
	invocation: { command: string; args: string[] },
	cwd: string,
	signal: AbortSignal | undefined,
	tokenBudget: number | undefined,
	inactivityTimeoutMs: number,
	onToken: (accumulated: string) => void,
	onToolCall: (name: string, args: Record<string, unknown>, accumulated: string) => void,
): Promise<SubagentResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now()

		const timeoutController = new AbortController()
		const timeoutHandle = setTimeout(() => timeoutController.abort(), TIMEOUT_MS)

		const combinedSignal =
			signal !== undefined ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, KIMCHI_SUBAGENT: "1" },
		})

		let buffer = ""
		let accumulated = ""
		let stderr = ""
		let inputTokens = 0
		let outputTokens = 0
		let cacheReadTokens = 0
		let cacheWriteTokens = 0
		let failureReason: SubagentFailureReason | undefined
		let closed = false

		let inactivityHandle = setTimeout(() => kill("output_stalled"), inactivityTimeoutMs)
		const resetInactivity = () => {
			if (closed) return
			clearTimeout(inactivityHandle)
			inactivityHandle = setTimeout(() => kill("output_stalled"), inactivityTimeoutMs)
		}

		const finish = (exitCode: number) => {
			if (closed) return
			closed = true
			clearTimeout(timeoutHandle)
			clearTimeout(inactivityHandle)
			combinedSignal.removeEventListener("abort", onAbort)
			resolve({
				exitCode,
				accumulated,
				stderr,
				tokenUsage: {
					input: inputTokens,
					output: outputTokens,
					cacheRead: cacheReadTokens,
					cacheWrite: cacheWriteTokens,
				},
				failureReason,
				durationMs: Date.now() - startedAt,
			})
		}

		const kill = (reason: SubagentFailureReason) => {
			if (failureReason === undefined) {
				failureReason = reason
			}
			proc.kill("SIGTERM")
			setTimeout(() => {
				if (!closed) proc.kill("SIGKILL")
			}, 5000)
		}

		const processLine = (line: string) => {
			const {
				delta,
				inputTokens: lineInput,
				outputTokens: lineOutput,
				cacheReadTokens: lineCacheRead,
				cacheWriteTokens: lineCacheWrite,
				toolCall,
			} = parseSubagentEvent(line)
			if (delta !== null) {
				accumulated += delta
				onToken(accumulated)
			}
			if (lineInput > 0 || lineOutput > 0) {
				inputTokens += lineInput
				outputTokens += lineOutput
				if (tokenBudget !== undefined && tokenBudget > 0 && inputTokens + outputTokens > tokenBudget) {
					kill("token_budget_exceeded")
				}
			}
			cacheReadTokens += lineCacheRead
			cacheWriteTokens += lineCacheWrite
			if (toolCall !== null) {
				onToolCall(toolCall.name, toolCall.args, accumulated)
			}
		}

		proc.stdout.on("data", (data: Buffer) => {
			resetInactivity()
			buffer += data.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) processLine(line)
		})

		proc.stderr.on("data", (data: Buffer) => {
			resetInactivity()
			stderr += data.toString()
			if (stderr.length > STDERR_MAX) {
				stderr = stderr.slice(0, STDERR_MAX)
			}
		})

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer)
			finish(code ?? 0)
		})

		proc.on("error", (err) => {
			if (failureReason === undefined) failureReason = "exit_error"
			stderr = stderr || err.message
			finish(1)
		})

		const onAbort = () => {
			if (timeoutController.signal.aborted) {
				kill("timeout")
			} else if (failureReason === undefined) {
				kill("aborted")
			}
		}

		if (combinedSignal.aborted) {
			onAbort()
		} else {
			combinedSignal.addEventListener("abort", onAbort, { once: true })
		}
	})
}

interface SubagentResponse {
	summary: string
	files: string[]
}

export function parseSubagentResponse(text: string): SubagentResponse | null {
	const trimmed = text.trim()

	const tryParse = (s: string): SubagentResponse | null => {
		try {
			const parsed = JSON.parse(s)
			if (typeof parsed?.summary === "string") {
				return {
					summary: parsed.summary,
					files: Array.isArray(parsed.files)
						? (parsed.files as unknown[]).filter((f): f is string => typeof f === "string")
						: [],
				}
			}
		} catch {
			// fall through
		}
		return null
	}

	const direct = tryParse(trimmed)
	if (direct !== null) return direct

	const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
	if (fenceMatch) {
		const fromFence = tryParse(fenceMatch[1].trim())
		if (fromFence !== null) return fromFence
	}

	// Walk backwards through candidate `{` positions, trying each as the
	// start of the JSON object. This handles cases where the accumulated
	// text contains brace patterns like Go route placeholders
	// (e.g. `/tasks/{id}`) that precede the actual JSON response.
	const lastClose = trimmed.lastIndexOf("}")
	if (lastClose !== -1) {
		let searchFrom = lastClose
		while (searchFrom >= 0) {
			const openIdx = trimmed.lastIndexOf("{", searchFrom)
			if (openIdx === -1) break
			const fromBlock = tryParse(trimmed.slice(openIdx, lastClose + 1))
			if (fromBlock !== null) return fromBlock
			searchFrom = openIdx - 1
		}
	}

	return null
}

function truncatePrompt(prompt: string): string {
	if (prompt.length <= PROMPT_MAX_LENGTH) return prompt
	return `${prompt.slice(0, PROMPT_MAX_LENGTH)}...`
}

export function truncateSubagentResult(text: string, sessionFile: string | undefined): string {
	if (text.length <= RESULT_MAX_CHARS) return text
	const half = Math.floor(RESULT_MAX_CHARS / 2)
	const head = text.slice(0, half)
	const tail = text.slice(-half)
	const sessionRef = sessionFile ? ` Full output in: ${sessionFile}` : ""
	return `${head}\n\n[… middle elided.${sessionRef}]\n\n${tail}`
}

function formatFooterStatus(counts: Map<string, number>, theme: Theme): string {
	const entries = [...counts.entries()].map(([model, n]) => `${model} [${n}]`).join(" | ")
	return theme.fg("dim", `subagents: ${entries}`)
}

interface SubagentStats {
	durationMs: number
	tokenUsage: SubagentTokenUsage
	sessionId?: string
	sessionFile?: string
}

function formatStats(stats: SubagentStats, theme: Theme): string {
	const duration = theme.fg("dim", formatDuration(stats.durationMs))
	const input = theme.fg("dim", `↑${formatCount(stats.tokenUsage.input)}`)
	const output = theme.fg("dim", `↓${formatCount(stats.tokenUsage.output)}`)
	return `- ${duration}  ${input}  ${output}`
}

const SubagentParams = Type.Object({
	provider: Type.String({
		description:
			'Provider name for the subagent model (e.g. "kimchi-dev"). Must match the provider registered in models.json.',
	}),
	model: Type.String({ description: "Model ID to use for the subagent (e.g. glm-5-fp8, kimi-k2.5)" }),
	prompt: Type.String({ description: "Prompt to send to the subagent" }),
	attachments: Type.Optional(
		Type.Array(Type.String({ description: "File path to load at subagent startup." }), {
			description:
				"File paths the subagent needs available at startup. Any file type pi's CLI loads via @file works (images, text files, etc.). Do not include the @ prefix — the runtime adds it. Images require a vision-capable model.",
			maxItems: 10,
		}),
	),
	tokenBudget: Type.Optional(
		Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^[1-9][0-9]*$" })], {
			description:
				"Maximum total tokens (input + output) the subagent may consume. Subagent is killed when exceeded. Omit unless you have an explicit reason to cap token usage — do not set this speculatively.",
		}),
	),
	inactivityTimeoutMs: Type.Optional(
		Type.Union([Type.Integer({ minimum: 1000 }), Type.String({ pattern: "^[1-9][0-9]{3,}$" })], {
			description:
				"Milliseconds of silence before the subagent is killed with output_stalled. Defaults to 3 minutes. Increase for planning or research steps where a thinking-heavy model may reason silently for an extended period before producing output.",
		}),
	),
})

export default function (pi: ExtensionAPI) {
	const sessionCounts = new Map<string, number>()
	activeSessionCounts = sessionCounts

	pi.on("session_start", (event, ctx) => {
		if (ctx.hasUI) {
			sessionCounts.clear()
			ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined)
		}
		if (event.reason === "new") return
		const branch = ctx.sessionManager.getBranch()
		if (isAlreadyRecovered(branch)) return
		const danglingCalls = findDanglingSubagentCalls(branch)
		if (danglingCalls.length === 0) return
		for (const toolCall of danglingCalls) {
			const endCheckpoint = findCheckpointInBranch<SubagentEndCheckpoint>(branch, CHECKPOINT_END_TYPE, toolCall.id)
			const modelName = ((toolCall.arguments as Record<string, unknown>)?.model as string) ?? "unknown"
			if (endCheckpoint) {
				pi.sendMessage(
					{
						customType: RECOVERY_MESSAGE_TYPE,
						content: [
							{
								type: "text",
								text: `[Subagent (${modelName}) completed but the result was not captured due to session interruption. Recovered output:]\n\n${endCheckpoint.accumulated || "(no output)"}`,
							},
						],
						display: true,
					},
					{ triggerTurn: true },
				)
			} else {
				pi.sendMessage({
					customType: INTERRUPTED_MESSAGE_TYPE,
					content: [
						{
							type: "text",
							text: `[Subagent (${modelName}) was interrupted before completing. The tool call did not return a result.]`,
						},
					],
					display: true,
				})
			}
		}
	})

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Spawn an isolated subagent process with the given provider, model, and prompt. Both provider and model are required — provider must match the model's registered provider name (e.g. "kimchi-dev"). The subagent runs in a separate pi process with no shared context and returns its final response. Hard timeout: ${TIMEOUT_MS / 60000} minutes.`,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const validated = validateAttachments(params.attachments, ctx.cwd)
			if (validated.kind === "empty") {
				return {
					content: [
						{
							type: "text",
							text: "Attachments must be non-empty file paths. Remove the blank entry and retry.",
						},
					],
					details: undefined,
					isError: true,
				}
			}
			if (validated.kind === "invalid") {
				const parts: string[] = []
				if (validated.missing.length > 0) {
					const anyRelative = validated.missing.some((p) => {
						const stripped = stripAtPrefix(p)
						return !isAbsolute(stripped) && !stripped.startsWith("~")
					})
					const cwdHint = anyRelative ? ` (relative to ${ctx.cwd})` : ""
					parts.push(`Attachment files not found${cwdHint}: ${validated.missing.join(", ")}`)
				}
				if (validated.notFile.length > 0) {
					parts.push(`Attachment paths are not regular files: ${validated.notFile.join(", ")}`)
				}
				return {
					content: [{ type: "text", text: `${parts.join(". ")}. Check the paths and retry.` }],
					details: undefined,
					isError: true,
				}
			}
			const parentSessionDir = ctx.sessionManager.getSessionDir()
			const parentSessionFile = ctx.sessionManager.getSessionFile()
			let sessionId: string | undefined
			let childSessionFile: string | undefined
			try {
				const prepared = prepareChildSessionFile(parentSessionDir, parentSessionFile, ctx.cwd)
				if (prepared) {
					sessionId = prepared.sessionId
					childSessionFile = prepared.sessionFile
				}
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err)
				const zeroUsage: SubagentTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
				const error: SubagentError = {
					reason: "exit_error",
					model: params.model,
					tokenUsage: zeroUsage,
					durationMs: 0,
					detail: `Failed to pre-write subagent session file under ${parentSessionDir}: ${detail}`,
				}
				return {
					content: [{ type: "text", text: JSON.stringify(error) }],
					details: { durationMs: 0, tokenUsage: zeroUsage },
					isError: true,
				}
			}

			const args = buildSubagentArgs(params, validated.resolved, collectExtensionArgs(), childSessionFile)
			const invocation = getSubagentInvocation(args)

			let lastToolCall: string | undefined
			const tokenBudget = params.tokenBudget !== undefined ? Number(params.tokenBudget) : undefined
			const inactivityTimeoutMs =
				params.inactivityTimeoutMs !== undefined ? Number(params.inactivityTimeoutMs) : INACTIVITY_TIMEOUT_MS
			const { exitCode, accumulated, stderr, tokenUsage, failureReason, durationMs } = await spawnSubagent(
				invocation,
				ctx.cwd,
				signal,
				tokenBudget,
				inactivityTimeoutMs,
				(text) => {
					lastToolCall = undefined
					onUpdate?.({ content: [{ type: "text", text }], details: undefined })
				},
				(name, toolArgs, text) => {
					const firstArg = Object.values(toolArgs)[0]
					const argHint =
						typeof firstArg === "string" ? ` ${firstArg.slice(0, 60)}${firstArg.length > 60 ? "…" : ""}` : ""
					lastToolCall = `${name}${argHint}`
					onUpdate?.({ content: [{ type: "text", text }], details: lastToolCall })
				},
			)

			pi.appendEntry<SubagentEndCheckpoint>(CHECKPOINT_END_TYPE, {
				toolCallId: _toolCallId,
				accumulated,
				exitCode,
				failureReason,
			})

			sessionCounts.set(params.model, (sessionCounts.get(params.model) ?? 0) + 1)
			if (ctx.hasUI) {
				ctx.ui.setStatus(FOOTER_STATUS_KEY, formatFooterStatus(sessionCounts, ctx.ui.theme))
			}

			const stats: SubagentStats = { durationMs, tokenUsage, sessionId, sessionFile: childSessionFile }

			if (failureReason !== undefined || exitCode !== 0) {
				const rawDetail = stderr.trim() || accumulated || "(no output)"
				const error: SubagentError = {
					reason: failureReason ?? "exit_error",
					model: params.model,
					tokenUsage,
					durationMs,
					detail: truncateSubagentResult(rawDetail, childSessionFile),
				}
				return {
					content: [
						{
							type: "text",
							text: `Subagent failed — do NOT attempt to implement or complete this work yourself. Spawn a replacement subagent with a corrected or simplified prompt instead.\n\nError details:\n\n${JSON.stringify(error, null, 2)}`,
						},
					],
					details: stats,
					isError: true,
				}
			}

			const resultText = accumulated || "(no output)"
			const parsed = parseSubagentResponse(resultText)
			if (parsed === null) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent returned an unstructured response (protocol violation). Do NOT attempt to fix or complete this work manually — spawn a new subagent with a simpler or corrected prompt instead.\n\nRaw output:\n\n${truncateSubagentResult(resultText, childSessionFile)}`,
						},
					],
					details: stats,
					isError: true,
				}
			}
			const filesLine = parsed.files.length > 0 ? `\nFiles: ${parsed.files.join(", ")}` : ""
			return {
				content: [{ type: "text", text: `${parsed.summary}${filesLine}` }],
				details: stats,
			}
		},

		renderCall(args, theme, context) {
			const state = context.state as SubagentState

			const running = context.executionStarted && context.isPartial
			if (!running) {
				clearSpinner(state)
			} else {
				tickSpinner(state, context.invalidate)
			}

			if (context.executionStarted && !state.executionStartedAt) {
				state.executionStartedAt = Date.now()
			}

			const view = context.lastComponent instanceof ToolBlockView ? context.lastComponent : new ToolBlockView()

			let icon: string
			if (running) {
				icon = theme.fg("accent", spinnerFrame(state))
			} else if (context.isError) {
				icon = theme.fg("error", "✗")
			} else if (!context.isPartial) {
				icon = theme.fg("success", "✓")
			} else {
				icon = theme.fg("accent", "⟳")
			}

			const name = theme.fg("success", theme.bold("subagent"))
			const model = theme.fg("dim", `${args.provider ?? ""}/${args.model ?? ""}`)
			const left = `${icon} ${name}  ${model}`

			let right = ""
			if (!context.isPartial && state.executionStartedAt) {
				right = theme.fg("dim", formatDuration(Date.now() - state.executionStartedAt))
			}

			view.setHeader(left, right)
			view.hideDivider()
			view.setFooter("", "")
			view.setExtra([`  ${theme.fg("muted", "task:")} ${theme.fg("dim", truncatePrompt(args.prompt ?? ""))}`])
			return view
		},

		renderResult(result, options, theme, context) {
			const state = context.state as SubagentState

			if (options.isPartial) {
				state.lastToolCall = result.details as string | undefined
			} else {
				clearSpinner(state)
				state.lastToolCall = undefined
			}

			const text = getTextContent(result)
			if (!text) return new Text("", 0, 0)

			if (options.isPartial) {
				const toolCall = state.lastToolCall
				let displayText: string
				let displayStyle: "dim" | "toolOutput"
				const terminalWidth = process.stdout.columns ?? 80
				if (toolCall) {
					const truncated = truncateToWidth(`> ${toolCall}`, terminalWidth * 5)
					const toolCallVisualLines = wrapTextWithAnsi(truncated, terminalWidth)
					const paddedLines = [
						...toolCallVisualLines.slice(0, 5),
						...Array(5 - Math.min(toolCallVisualLines.length, 5)).fill(""),
					]
					displayText = paddedLines.join("\n")
					displayStyle = "dim"
				} else {
					const nonEmptyLines = text.split("\n").filter((l: string) => l.trim())
					const visualLines = nonEmptyLines.flatMap((l: string) => wrapTextWithAnsi(l, terminalWidth))
					const last5 = visualLines.slice(-5)
					const paddedLines = [...Array(5 - last5.length).fill(""), ...last5]
					displayText = paddedLines.join("\n")
					displayStyle = "toolOutput"
				}

				const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
				component.clear()
				component.addChild(new Spacer(1))
				component.addChild(new Text(theme.fg(displayStyle, displayText), 0, 0))
				return component
			}

			const view = context.lastComponent instanceof ToolBlockView ? context.lastComponent : new ToolBlockView()
			const stats = result.details as SubagentStats | undefined
			const nonEmptyLines = text.split("\n").filter((l: string) => l.trim())
			const lineCount = nonEmptyLines.length

			registerToolCall(context.toolCallId)
			view.setHeader("", "")
			view.setDivider((s: string) => theme.fg("borderMuted", s))

			if (isToolExpanded(context.toolCallId)) {
				const statsLine = stats !== undefined ? formatStats(stats, theme) : ""
				view.setFooter(theme.fg("toolOutput", text), "")
				view.setExtra(statsLine ? [statsLine] : [])
			} else {
				const outputSummary = theme.fg("dim", `${lineCount} line${lineCount === 1 ? "" : "s"} written`)
				const statsStr = stats !== undefined ? `  ${formatStats(stats, theme)}` : ""
				view.setFooter(`${outputSummary}${statsStr}`, theme.fg("dim", "ctrl+o to expand"))
				view.setExtra([])
			}

			return view
		},
	})
}
