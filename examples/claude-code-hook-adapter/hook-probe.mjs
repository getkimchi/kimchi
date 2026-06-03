#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const stdin = await readStdin()
const payload = parseJson(stdin) || {}
const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd()
const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "unknown"
const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {}
const command = typeof toolInput.command === "string" ? toolInput.command : ""
const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
const toolOutput = typeof payload.tool_output === "string" ? payload.tool_output : ""

writeLog(cwd, {
	event: eventName,
	tool: payload.tool_name ?? null,
	command: command || null,
	prompt: prompt || null,
	at: new Date().toISOString(),
})

if (eventName === "PreToolUse") {
	if (command.includes("KIMCHI_HOOK_BLOCK") || /\bnpm\s+(install|i)\b/.test(command)) {
		emit({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "claude-code: blocked by test hook",
			},
		})
	}
	if (command.includes("KIMCHI_HOOK_REWRITE")) {
		emit({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: { command: "printf '%s\\n' 'claude-code: PreToolUse rewrite OK'" },
			},
		})
	}
}

if (eventName === "PostToolUse" && (command.includes("KIMCHI_HOOK_POST_REWRITE") || toolOutput.includes("KIMCHI_HOOK_POST_REWRITE"))) {
	emit({
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			updatedToolOutput: "claude-code: PostToolUse output rewrite OK",
		},
	})
}

if (eventName === "UserPromptSubmit") {
	if (prompt.includes("KIMCHI_HOOK_PROMPT_BLOCK")) {
		emit({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				permissionDecision: "deny",
				permissionDecisionReason: "claude-code: prompt blocked by test hook",
			},
		})
	}
	if (prompt.includes("KIMCHI_HOOK_PROMPT_REWRITE")) {
		emit({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				updatedInput: { prompt: prompt.replace("KIMCHI_HOOK_PROMPT_REWRITE", "claude-code rewrite OK.") },
			},
		})
	}
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`)
	process.exit(0)
}

function writeLog(root, record) {
	const dir = join(root, ".kimchi")
	mkdirSync(dir, { recursive: true })
	appendFileSync(join(dir, "claude-code-hook-adapter.log"), `${JSON.stringify(record)}\n`, "utf-8")
}

async function readStdin() {
	const chunks = []
	for await (const chunk of process.stdin) chunks.push(chunk)
	return Buffer.concat(chunks).toString("utf-8")
}

function parseJson(value) {
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
