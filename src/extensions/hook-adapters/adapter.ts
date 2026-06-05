import { spawn } from "node:child_process"
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { deferExtensionAction } from "../deferred-action.js"
import {
	type CommandHookAdapterDefinition,
	type CommandHookEventName,
	type CommandHookResource,
	discoverCommandHookResources,
} from "./discovery.js"

interface HookCommandResult {
	block?: boolean
	reason?: string
	updatedInput?: Record<string, unknown>
	updatedOutput?: string
	additionalContext?: string
}

interface HookJsonOutput {
	decision?: unknown
	reason?: unknown
	continue?: unknown
	stopReason?: unknown
	systemMessage?: unknown
	hookSpecificOutput?: unknown
	permissionDecision?: unknown
	permissionDecisionReason?: unknown
	updatedInput?: unknown
	updated_input?: unknown
	updatedToolOutput?: unknown
	updatedMCPToolOutput?: unknown
	additionalContext?: unknown
}

type HookToolResultEventResult = {
	content?: ToolResultEvent["content"]
	details?: unknown
	isError?: boolean
}

export function createCommandHookAdapter(definition: CommandHookAdapterDefinition): (pi: ExtensionAPI) => void {
	return (pi) => {
		let stopHookFollowUpPending = false
		const pendingSystemPrompt: { context?: string } = {}

		if (definition.sessionStartDelivery === "systemPrompt") {
			pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined => {
				const c = pendingSystemPrompt.context
				if (!c) return undefined
				pendingSystemPrompt.context = undefined
				return { systemPrompt: `${event.systemPrompt}\n\n${c}` }
			})
		}

		pi.on("tool_call", (event, ctx) => runPreToolUse(definition, pi, event, ctx))
		pi.on("tool_result", (event, ctx) => runPostToolUse(definition, pi, event, ctx))
		pi.on("session_start", async (event, ctx) => {
			await runSessionStart(definition, pi, event, ctx, pendingSystemPrompt)
		})
		pi.on("session_compact", async (event, ctx) => {
			await runPostCompact(definition, pi, event, ctx)
			await runSessionStart(definition, pi, { ...event, type: "session_compact" }, ctx, pendingSystemPrompt)
		})
		pi.on("session_before_compact", (event, ctx) => runPreCompact(definition, pi, event, ctx))
		pi.on("input", (event, ctx) => {
			return runUserPromptSubmit(definition, pi, event, ctx)
		})
		pi.on("turn_end", async (event, ctx) => {
			const stopHookActive = stopHookFollowUpPending
			const result = await runStop(definition, event, ctx, stopHookActive)
			if (stopHookActive) stopHookFollowUpPending = false
			if (result?.block && result.reason && !stopHookActive) {
				stopHookFollowUpPending = true
				pi.sendUserMessage(result.reason, { deliverAs: "followUp" })
			}
		})
		pi.on("session_shutdown", async (event, ctx) => {
			await runObserver(definition, "SessionEnd", event, ctx)
		})
	}
}

export async function runCommandHook(
	hook: Pick<CommandHookResource, "command" | "async" | "timeoutMs" | "env">,
	payload: Record<string, unknown>,
	cwd: string,
): Promise<HookCommandResult> {
	const input = `${JSON.stringify(payload)}\n`
	if (hook.async) {
		try {
			const child = spawn(shellBinary(), shellArgs(hook.command), {
				cwd,
				env: hookEnv(payload, hook.env),
				stdio: ["pipe", "ignore", "ignore"],
				detached: true,
			})
			child.on("error", () => {})
			let timeout: NodeJS.Timeout | undefined
			const clearKillTimer = () => {
				if (timeout) clearTimeout(timeout)
				timeout = undefined
			}
			timeout = setTimeout(() => {
				child.kill()
			}, hook.timeoutMs)
			timeout.unref?.()
			child.once("exit", clearKillTimer)
			child.once("close", clearKillTimer)
			child.stdin.end(input)
			child.unref()
		} catch {
			return {}
		}
		return {}
	}

	return runBlockingCommandHook(hook, payload, cwd, input)
}

function runBlockingCommandHook(
	hook: Pick<CommandHookResource, "command" | "timeoutMs" | "env">,
	payload: Record<string, unknown>,
	cwd: string,
	input: string,
): Promise<HookCommandResult> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		let timeout: NodeJS.Timeout | undefined
		const settle = (result: HookCommandResult) => {
			if (settled) return
			settled = true
			if (timeout) clearTimeout(timeout)
			resolve(result)
		}

		try {
			const child = spawn(shellBinary(), shellArgs(hook.command), {
				cwd,
				env: hookEnv(payload, hook.env),
				stdio: ["pipe", "pipe", "pipe"],
			})
			child.stdout.setEncoding("utf-8")
			child.stderr.setEncoding("utf-8")
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk)
			})
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk)
			})
			child.once("error", () => settle({}))
			child.once("close", (code) => {
				if (code === 0) {
					settle(parseCommandHookOutput(stdout, stringValue(payload.hook_event_name)))
					return
				}
				if (code === 2) {
					settle({
						block: true,
						reason: firstLine(stderr) || firstLine(stdout) || "Hook blocked operation",
					})
					return
				}
				settle({})
			})
			timeout = setTimeout(() => {
				child.kill()
				settle({})
			}, hook.timeoutMs)
			child.stdin.end(input)
		} catch {
			settle({})
		}
	})
}

export function parseCommandHookOutput(stdout: string, eventName?: string): HookCommandResult {
	const trimmed = stdout.trim()
	if (!trimmed) return {}
	const parsed = parseJson(trimmed)
	if (!parsed) return plainTextResult(trimmed, eventName)

	const specific = isRecord(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : {}
	const decisionValue = specific.permissionDecision ?? parsed.permissionDecision ?? parsed.decision
	const decision =
		typeof decisionValue === "string"
			? decisionValue.toLowerCase()
			: isRecord(decisionValue) && typeof decisionValue.behavior === "string"
				? decisionValue.behavior.toLowerCase()
				: undefined
	const reason = stringValue(
		specific.permissionDecisionReason ?? parsed.permissionDecisionReason ?? parsed.reason ?? parsed.stopReason,
	)
	const block = parsed.continue === false || decision === "deny" || decision === "block"
	const updatedInput = asRecord(parseMaybeJson(specific.updatedInput ?? parsed.updatedInput ?? parsed.updated_input))
	const updatedOutput = stringValue(
		specific.updatedToolOutput ??
			specific.updatedMCPToolOutput ??
			parsed.updatedToolOutput ??
			parsed.updatedMCPToolOutput,
	)
	const additionalContext =
		stringValue(specific.additionalContext ?? parsed.additionalContext) ?? stringValue(parsed.systemMessage)

	return {
		block,
		reason,
		updatedInput,
		updatedOutput,
		additionalContext,
	}
}

async function runPreToolUse(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const externalName = externalToolName(event.toolName)
	const result = await runMatchingHooks(definition, "PreToolUse", ctx, matcherCandidates(event.toolName), {
		tool_name: externalName,
		tool_use_id: event.toolCallId,
		tool_input: claudeToolInput(event.input),
	})
	if (!result) return undefined
	if (result.additionalContext) sendAdditionalContext(definition, pi, result.additionalContext, "steer")
	if (result.updatedInput) Object.assign(event.input, kimchiToolInput(result.updatedInput, event.input))
	if (result.block) return { block: true, reason: result.reason }
	return undefined
}

async function runPostToolUse(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): Promise<HookToolResultEventResult | undefined> {
	const basePayload = {
		tool_name: externalToolName(event.toolName),
		tool_use_id: event.toolCallId,
		tool_input: claudeToolInput(event.input),
		tool_response: event.content,
		tool_output: textContent(event.content),
		is_error: event.isError,
	}
	let result = await runMatchingHooks(definition, "PostToolUse", ctx, matcherCandidates(event.toolName), basePayload)
	const skillName = skillNameFromReadPath(event)
	if (skillName) {
		result = mergeOptionalResults(
			result,
			await runMatchingHooks(
				definition,
				"PostToolUse",
				ctx,
				["Skill"],
				{
					...basePayload,
					tool_name: "Skill",
					tool_input: { skill: skillName },
				},
				{ includeUniversalMatchers: false },
			),
		)
	}
	if (!result) return undefined
	if (result.additionalContext) sendAdditionalContext(definition, pi, result.additionalContext, "steer")
	if (result.block) {
		return {
			content: [{ type: "text", text: result.reason ?? "Hook blocked normal tool result processing." }],
			isError: true,
		}
	}
	if (result.updatedOutput !== undefined) return { content: [{ type: "text", text: result.updatedOutput }] }
	return undefined
}

async function runSessionStart(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: SessionStartEvent | (SessionCompactEvent & { type: "session_compact" }),
	ctx: ExtensionContext,
	pendingSystemPrompt: { context?: string },
): Promise<void> {
	const source = event.type === "session_compact" ? "compact" : sessionStartSource(event.reason)
	const result = await runMatchingHooks(definition, "SessionStart", ctx, [source], { source })
	const additionalContext = result?.additionalContext
	if (!additionalContext) return
	if (definition.sessionStartDelivery === "systemPrompt") {
		pendingSystemPrompt.context = pendingSystemPrompt.context
			? `${pendingSystemPrompt.context}\n\n${additionalContext}`
			: additionalContext
		return
	}
	const send = () => sendAdditionalContext(definition, pi, additionalContext, "nextTurn")
	if (event.type === "session_compact") send()
	else deferExtensionAction(send)
}

async function runPreCompact(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const trigger = event.customInstructions ? "manual" : "auto"
	const result = await runMatchingHooks(definition, "PreCompact", ctx, [trigger], {
		trigger,
		custom_instructions: event.customInstructions,
	})
	if (result?.additionalContext) sendAdditionalContext(definition, pi, result.additionalContext, "steer")
}

async function runPostCompact(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: SessionCompactEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const trigger = event.fromExtension ? "manual" : "auto"
	const result = await runMatchingHooks(definition, "PostCompact", ctx, [trigger], { trigger })
	if (result?.additionalContext) sendAdditionalContext(definition, pi, result.additionalContext, "nextTurn")
}

async function runUserPromptSubmit(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	event: InputEvent,
	ctx: ExtensionContext,
): Promise<InputEventResult | undefined> {
	const result = await runMatchingHooks(definition, "UserPromptSubmit", ctx, [], {
		prompt: event.text,
		user_prompt: event.text,
		source: event.source,
	})
	if (!result) return undefined
	if (result.additionalContext) sendAdditionalContext(definition, pi, result.additionalContext, "steer")
	if (result.block) {
		if (result.reason) sendVisibleHookMessage(definition, pi, result.reason)
		return { action: "handled" }
	}
	const prompt = stringValue(result.updatedInput?.prompt ?? result.updatedInput?.text)
	return prompt === undefined ? undefined : { action: "transform", text: prompt, images: event.images }
}

async function runStop(
	definition: CommandHookAdapterDefinition,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	stopHookActive: boolean,
): Promise<HookCommandResult | undefined> {
	return runMatchingHooks(definition, "Stop", ctx, [], {
		turn_id: String(event.turnIndex),
		stop_hook_active: stopHookActive,
		last_assistant_message: lastAssistantText(event.message),
	})
}

async function runObserver(
	definition: CommandHookAdapterDefinition,
	eventName: "SessionEnd",
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
): Promise<void> {
	await runMatchingHooks(definition, eventName, ctx, [], event as unknown as Record<string, unknown>)
}

async function runMatchingHooks(
	definition: CommandHookAdapterDefinition,
	eventName: CommandHookEventName,
	ctx: ExtensionContext,
	matcherValues: string[],
	eventPayload: Record<string, unknown>,
	options: { includeUniversalMatchers?: boolean } = {},
): Promise<HookCommandResult | undefined> {
	if (!definition.supportedEvents.includes(eventName)) return undefined
	const payload = basePayload(eventName, ctx, eventPayload)
	let combined: HookCommandResult | undefined
	for (const hook of discoverCommandHookResources(definition, ctx.cwd)) {
		if (!isResourceEnabled(hook.id)) continue
		if (hook.eventName !== eventName) continue
		if (!matchesHook(hook, matcherValues, eventPayload, options)) continue
		const result = await runCommandHook(hook, payload, ctx.cwd)
		const next = mergeResults(combined, result)
		combined = next
		if (next?.block && eventName !== "Stop") break
	}
	return combined
}

function basePayload(
	eventName: CommandHookEventName,
	ctx: ExtensionContext,
	eventPayload: Record<string, unknown>,
): Record<string, unknown> {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: null,
		cwd: ctx.cwd,
		hook_event_name: eventName,
		model: modelName(ctx),
		permission_mode: "default",
		...eventPayload,
	}
}

function mergeResults(current: HookCommandResult | undefined, next: HookCommandResult): HookCommandResult | undefined {
	if (!current) return next
	return {
		block: current.block || next.block,
		reason: next.reason ?? current.reason,
		updatedInput: next.updatedInput ? { ...(current.updatedInput ?? {}), ...next.updatedInput } : current.updatedInput,
		updatedOutput: next.updatedOutput ?? current.updatedOutput,
		additionalContext: [current.additionalContext, next.additionalContext].filter(Boolean).join("\n\n") || undefined,
	}
}

function mergeOptionalResults(
	current: HookCommandResult | undefined,
	next: HookCommandResult | undefined,
): HookCommandResult | undefined {
	return next ? mergeResults(current, next) : current
}

function matchesHook(
	hook: CommandHookResource,
	matcherValues: string[],
	eventPayload: Record<string, unknown>,
	options: { includeUniversalMatchers?: boolean } = {},
): boolean {
	if (!hook.matcher || hook.matcher === "*") return options.includeUniversalMatchers !== false
	if (matcherValues.length === 0) return true
	const paren = hook.matcher.match(/^([^(]+)\((.*)\)$/)
	if (paren) {
		if (!matchesPattern(paren[1], matcherValues)) return false
		const command = stringValue(asRecord(eventPayload.tool_input)?.command)
		return command === undefined || globToRegExp(paren[2]).test(command)
	}
	return matchesPattern(hook.matcher, matcherValues)
}

function matchesPattern(pattern: string, values: string[]): boolean {
	try {
		const re = new RegExp(`^(?:${pattern})$`)
		return values.some((value) => re.test(value))
	} catch {
		return values.includes(pattern)
	}
}

function matcherCandidates(toolName: string): string[] {
	const external = externalToolName(toolName)
	const values = new Set([toolName, external])
	if (toolName === "edit" || toolName === "write") values.add("apply_patch")
	if (toolName === "ls") values.add("LS")
	return [...values]
}

function externalToolName(toolName: string): string {
	if (toolName.includes("__")) return toolName
	if (toolName === "ls") return "LS"
	return toolName.slice(0, 1).toUpperCase() + toolName.slice(1)
}

function sendAdditionalContext(
	definition: CommandHookAdapterDefinition,
	pi: ExtensionAPI,
	content: string,
	deliverAs: "steer" | "nextTurn",
): void {
	pi.sendMessage(
		{
			customType: definition.customType,
			content,
			display: false,
			details: { source: definition.id },
		},
		{ deliverAs, triggerTurn: false },
	)
}

function sendVisibleHookMessage(definition: CommandHookAdapterDefinition, pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{
			customType: definition.customType,
			content,
			display: true,
			details: { source: definition.id, blocked: true },
		},
		{ triggerTurn: false },
	)
}

function textContent(content: ToolResultEvent["content"]): string {
	return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
}

function claudeToolInput(input: Record<string, unknown>): Record<string, unknown> {
	if (typeof input.path !== "string" || typeof input.file_path === "string") return input
	return { ...input, file_path: input.path }
}

function kimchiToolInput(
	updatedInput: Record<string, unknown>,
	currentInput: Record<string, unknown>,
): Record<string, unknown> {
	if (typeof updatedInput.file_path !== "string" || typeof currentInput.path !== "string") return updatedInput
	const next = Object.fromEntries(Object.entries(updatedInput).filter(([key]) => key !== "file_path"))
	if (typeof next.path !== "string") next.path = updatedInput.file_path
	return next
}

function skillNameFromReadPath(event: ToolResultEvent): string | undefined {
	if (event.toolName !== "read" || event.isError) return undefined
	const path = stringValue(event.input.path)
	if (!path || !path.endsWith("/SKILL.md")) return undefined
	const parts = path.split("/")
	return parts.at(-2) || undefined
}

function lastAssistantText(message: TurnEndEvent["message"]): string | null {
	if (!isRecord(message) || !Array.isArray(message.content)) return null
	return message.content.map((part) => (isRecord(part) && part.type === "text" ? part.text : "")).join("") || null
}

function sessionStartSource(reason: SessionStartEvent["reason"]): string {
	if (reason === "resume") return "resume"
	if (reason === "reload") return "reload"
	return "startup"
}

function modelName(ctx: ExtensionContext): string | null {
	const model = ctx.model as unknown
	if (!isRecord(model)) return null
	return stringValue(model.id) ?? stringValue(model.name) ?? stringValue(model.model) ?? null
}

function plainTextResult(stdout: string, eventName?: string): HookCommandResult {
	return eventName === "SessionStart" || eventName === "UserPromptSubmit" ? { additionalContext: stdout } : {}
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	return new RegExp(`^${escaped}$`)
}

function shellBinary(): string {
	return process.platform === "win32" ? "cmd.exe" : "sh"
}

function shellArgs(command: string): string[] {
	return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
}

function hookEnv(payload: Record<string, unknown>, extra?: Record<string, string>): NodeJS.ProcessEnv {
	const eventName = stringValue(payload.hook_event_name) ?? ""
	const toolName = stringValue(payload.tool_name) ?? ""
	return {
		...process.env,
		...extra,
		KIMCHI_HOOK_EVENT: eventName,
		KIMCHI_TOOL_NAME: toolName,
	}
}

function parseJson(value: string): HookJsonOutput | undefined {
	try {
		const parsed = JSON.parse(value)
		return isRecord(parsed) ? (parsed as HookJsonOutput) : undefined
	} catch {
		return undefined
	}
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function firstLine(value: string | undefined): string | undefined {
	return value
		?.split(/\r?\n/)
		.map((line) => line.replace(/\p{C}/gu, "").trim())
		.find((line) => line !== "" && !isProtocolMarkerLine(line))
}

function isProtocolMarkerLine(line: string): boolean {
	return /^__[A-Z0-9_]+__:\d+$/.test(line)
}
