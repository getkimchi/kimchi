import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { TelemetryConfig } from "../config.js"
import { getAvailableModels } from "../startup-context.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowNano(): string {
	return String(Date.now() * 1_000_000)
}

function strAttr(key: string, value: string): { key: string; value: { stringValue: string } } {
	return { key, value: { stringValue: value } }
}

function inferLanguage(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
	const map: Record<string, string> = {
		ts: "TypeScript",
		tsx: "TypeScript",
		js: "JavaScript",
		jsx: "JavaScript",
		mjs: "JavaScript",
		cjs: "JavaScript",
		py: "Python",
		go: "Go",
		rs: "Rust",
		rb: "Ruby",
		java: "Java",
		kt: "Kotlin",
		swift: "Swift",
		c: "C",
		h: "C",
		cpp: "C++",
		cc: "C++",
		cxx: "C++",
		hpp: "C++",
		cs: "C#",
		php: "PHP",
		dart: "Dart",
		md: "Markdown",
		mdx: "Markdown",
		json: "JSON",
		yaml: "YAML",
		yml: "YAML",
		toml: "TOML",
		ini: "TOML",
		xml: "HTML/XML",
		html: "HTML/XML",
		htm: "HTML/XML",
		svg: "HTML/XML",
		css: "CSS",
		scss: "CSS",
		less: "CSS",
		sql: "SQL",
		sh: "Bash",
		bash: "Bash",
		zsh: "Bash",
		txt: "Plain text",
		proto: "Protocol Buffers",
		tf: "HCL",
		dockerfile: "Dockerfile",
	}
	return map[ext] ?? "unknown"
}

function countLineChanges(oldStr: string, newStr: string): { added: number; removed: number } {
	const oldLines = oldStr ? oldStr.split("\n").length : 0
	const newLines = newStr ? newStr.split("\n").length : 0
	if (newLines >= oldLines) return { added: newLines - oldLines, removed: 0 }
	return { added: 0, removed: oldLines - newLines }
}

// ---------------------------------------------------------------------------
// OTLP sender
// ---------------------------------------------------------------------------

async function sendLog(
	config: TelemetryConfig,
	sessionId: string,
	eventName: string,
	attrs: Record<string, string | number>,
): Promise<void> {
	if (!config.enabled || !config.endpoint) return
	const now = nowNano()
	const headers: Record<string, string> = { "Content-Type": "application/json", ...config.headers }
	const payload = {
		resourceLogs: [
			{
				resource: { attributes: [strAttr("service.name", "kimchi")], droppedAttributesCount: 0 },
				scopeLogs: [
					{
						scope: { name: "kimchi", version: "1.0.0" },
						logRecords: [
							{
								timeUnixNano: now,
								observedTimeUnixNano: now,
								severityNumber: 9,
								severityText: "INFO",
								eventName,
								body: { stringValue: eventName },
								attributes: [
									strAttr("session.id", sessionId),
									strAttr("client", "pi"),
									...Object.entries(attrs).map(([k, v]) => strAttr(k, String(v))),
								],
								droppedAttributesCount: 0,
								flags: 0,
								traceId: "",
								spanId: "",
							},
						],
					},
				],
			},
		],
	}
	try {
		const res = await fetch(config.endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		})
		if (!res.ok) {
			console.error(`[telemetry] send failed: ${res.status} ${await res.text()}`)
		}
	} catch (err) {
		console.error(`[telemetry] send error: ${err}`)
	}
}

const TELEMETRY_DRAIN_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function telemetryExtension(config: TelemetryConfig) {
	return (pi: ExtensionAPI) => {
		if (!config.enabled) return

		let sessionId = crypto.randomUUID()
		let sessionStartMs = Date.now()
		const sentMessages = new Set<string>()
		const pendingArgs = new Map<string, { toolName: string; args: unknown }>()
		const inFlight = new Set<Promise<void>>()
		let shuttingDown = false

		function track(p: Promise<void>): void {
			if (shuttingDown) return
			inFlight.add(p)
			p.finally(() => inFlight.delete(p))
		}

		pi.on("session_start", async () => {
			sessionId = crypto.randomUUID()
			sessionStartMs = Date.now()
			sentMessages.clear()
			pendingArgs.clear()
			shuttingDown = false
		})

		pi.on("session_shutdown", async () => {
			shuttingDown = true
			if (inFlight.size === 0) return
			const drain = Promise.allSettled([...inFlight])
			let timer: NodeJS.Timeout | undefined
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, TELEMETRY_DRAIN_TIMEOUT_MS)
			})
			await Promise.race([drain, timeout])
			clearTimeout(timer)
		})

		pi.on("message_end", async (event) => {
			const msg = event.message
			if (msg.role !== "assistant") return
			try {
				const assistant = msg as AssistantMessage
				const msgId = String(assistant.timestamp)
				if (sentMessages.has(msgId)) return
				sentMessages.add(msgId)

				const model = assistant.model ?? "unknown"
				const availableModels = getAvailableModels()
				const meta = availableModels.find((m) => m.slug === model)
				const rawProvider = String(assistant.provider ?? "unknown")
				const provider = meta?.provider ? meta.provider : rawProvider === "kimchi-dev" ? "ai-enabler" : rawProvider
				const { input, output, cacheRead, cacheWrite } = assistant.usage
				const costTotal = assistant.usage.cost.total
				const sessionUptimeMs = Date.now() - sessionStartMs

				track(
					sendLog(config, sessionId, "api_request", {
						model,
						provider,
						input_tokens: input,
						output_tokens: output,
						cache_read_tokens: cacheRead,
						cache_creation_tokens: cacheWrite,
						cost_usd: costTotal,
						session_uptime_ms: sessionUptimeMs,
					}),
				)
			} catch (err) {
				console.error("[telemetry] message_end handler error:", err)
			}
		})

		pi.on("tool_execution_start", async (event) => {
			pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args })
		})

		pi.on("tool_execution_end", async (event) => {
			const pending = pendingArgs.get(event.toolCallId)
			pendingArgs.delete(event.toolCallId)
			if (!pending) return

			const { toolName, args } = pending as { toolName: string; args: Record<string, unknown> }

			if (toolName === "bash") {
				const command = String(args?.command ?? "")
				if (/git\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
					track(sendLog(config, sessionId, "tool_usage", { tool: "bash", action: "git_commit" }))
				}
				if (/gh\s+pr\s+create\b/.test(command)) {
					track(sendLog(config, sessionId, "tool_usage", { tool: "bash", action: "gh_pr_create" }))
				}
			}

			if (toolName === "edit") {
				const filePath = String(args?.filePath ?? "")
				const language = inferLanguage(filePath)
				const changes = countLineChanges(String(args?.oldString ?? ""), String(args?.newString ?? ""))
				track(
					sendLog(config, sessionId, "tool_usage", {
						tool: "edit",
						language,
						lines_added: changes.added,
						lines_removed: changes.removed,
					}),
				)
			}

			if (toolName === "write") {
				const filePath = String(args?.filePath ?? "")
				const language = inferLanguage(filePath)
				const content = String(args?.content ?? "")
				const lines = content ? content.split("\n").length : 1
				track(
					sendLog(config, sessionId, "tool_usage", {
						tool: "write",
						language,
						lines_added: lines,
					}),
				)
			}

			if (toolName === "multiedit") {
				const filePath = String(args?.filePath ?? "")
				const language = inferLanguage(filePath)
				const edits = Array.isArray(args?.edits)
					? (args.edits as Array<{ oldString?: string; newString?: string }>)
					: []
				for (const edit of edits) {
					const changes = countLineChanges(String(edit.oldString ?? ""), String(edit.newString ?? ""))
					track(
						sendLog(config, sessionId, "tool_usage", {
							tool: "edit",
							language,
							lines_added: changes.added,
							lines_removed: changes.removed,
						}),
					)
				}
			}
		})
	}
}
