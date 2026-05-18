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
	// Trim trailing newlines to avoid counting empty lines from trailing newline
	const trimmedOld = oldStr.endsWith("\n") ? oldStr.replace(/\n+$/, "") : oldStr
	const trimmedNew = newStr.endsWith("\n") ? newStr.replace(/\n+$/, "") : newStr

	const oldLines = trimmedOld ? trimmedOld.split("\n").length : 0
	const newLines = trimmedNew ? trimmedNew.split("\n").length : 0

	// Only count as a change if strings actually differ
	const changed = trimmedOld !== trimmedNew
	// Use || 1 only when the side has net additions/removals (follows OpenCode plugin behavior)
	const added = Math.max(newLines - oldLines, 0) || (changed && newLines >= oldLines ? 1 : 0)
	const removed = Math.max(oldLines - newLines, 0) || (changed && oldLines > newLines ? 1 : 0)

	return { added, removed }
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

// ---------------------------------------------------------------------------
// OTLP metrics sender
// ---------------------------------------------------------------------------

interface MetricData {
	name: string
	type: "Sum" | "Gauge"
	value: number
	attrs: Record<string, string | number>
}

async function sendMetrics(
	config: TelemetryConfig,
	sessionId: string,
	metrics: MetricData[],
	sessionStartNano: string,
): Promise<void> {
	if (!config.enabled || !config.metricsEndpoint) return
	if (metrics.length === 0) return
	const now = nowNano()
	const headers: Record<string, string> = { "Content-Type": "application/json", ...config.headers }
	const payload = {
		resourceMetrics: [
			{
				resource: { attributes: [strAttr("service.name", "kimchi")], droppedAttributesCount: 0 },
				scopeMetrics: [
					{
						scope: { name: "kimchi", version: "1.0.0" },
						metrics: metrics.map((m) => {
							const base = {
								name: m.name,
								[m.type.toLowerCase() as "sum" | "gauge"]: {
									dataPoints: [
										{
											timeUnixNano: now,
											startTimeUnixNano: sessionStartNano,
											...(Number.isInteger(m.value) ? { asInt: String(m.value) } : { asDouble: m.value }),
											attributes: [
												strAttr("session.id", sessionId),
												strAttr("client", "pi"),
												...Object.entries(m.attrs).map(([k, v]) => strAttr(k, String(v))),
											],
										},
									],
									...(m.type === "Sum"
										? {
												aggregationTemporality: 2,
												isMonotonic: true,
											}
										: {}),
								},
							}
							return base
						}),
					},
				],
			},
		],
	}
	try {
		const res = await fetch(config.metricsEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		})
		if (!res.ok) {
			console.error(`[telemetry] metrics send failed: ${res.status} ${await res.text()}`)
		}
	} catch (err) {
		console.error(`[telemetry] metrics send error: ${err}`)
	}
}

const TELEMETRY_DRAIN_TIMEOUT_MS = 5_000
const METRICS_FLUSH_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function telemetryExtension(config: TelemetryConfig) {
	return (pi: ExtensionAPI) => {
		if (!config.enabled) return

		let sessionId = crypto.randomUUID()
		let sessionStartMs = Date.now()
		let sessionStartNano = String(sessionStartMs * 1_000_000)
		const sentMessages = new Set<string>()
		const pendingArgs = new Map<string, { toolName: string; args: unknown }>()
		const inFlight = new Set<Promise<void>>()
		let shuttingDown = false

		// Accumulation state for metrics
		const cumulativeTokensByModel: Record<
			string,
			{ input: number; output: number; cacheRead: number; cacheWrite: number }
		> = {}
		const cumulativeCostByModel: Record<string, number> = {}
		let cumulativeCommitCount = 0
		let cumulativePRCount = 0
		let cumulativeLinesAdded = 0
		let cumulativeLinesRemoved = 0
		const cumulativeEditDecisionsFull: MetricData[] = []

		let flushTimer: NodeJS.Timeout | undefined

		function track(p: Promise<void>): void {
			if (shuttingDown) return
			inFlight.add(p)
			p.finally(() => inFlight.delete(p))
		}

		function flushMetrics(): void {
			const allMetrics: MetricData[] = []

			// Flush token metrics (keyed by model)
			for (const [model, tokens] of Object.entries(cumulativeTokensByModel)) {
				if (tokens.input > 0) {
					allMetrics.push({
						name: "claude_code.token.usage",
						type: "Sum",
						value: tokens.input,
						attrs: { type: "input", model, provider: "ai-enabler" },
					})
				}
				if (tokens.output > 0) {
					allMetrics.push({
						name: "claude_code.token.usage",
						type: "Sum",
						value: tokens.output,
						attrs: { type: "output", model, provider: "ai-enabler" },
					})
				}
				if (tokens.cacheRead > 0) {
					allMetrics.push({
						name: "claude_code.token.usage",
						type: "Sum",
						value: tokens.cacheRead,
						attrs: { type: "cacheRead", model, provider: "ai-enabler" },
					})
				}
				if (tokens.cacheWrite > 0) {
					allMetrics.push({
						name: "claude_code.token.usage",
						type: "Sum",
						value: tokens.cacheWrite,
						attrs: { type: "cacheCreation", model, provider: "ai-enabler" },
					})
				}
			}

			// Flush cost metrics (keyed by model)
			for (const [model, cost] of Object.entries(cumulativeCostByModel)) {
				if (cost > 0) {
					allMetrics.push({
						name: "claude_code.cost.usage",
						type: "Sum",
						value: cost,
						attrs: { model, provider: "ai-enabler" },
					})
				}
			}

			// Flush commit count
			if (cumulativeCommitCount > 0) {
				allMetrics.push({
					name: "claude_code.commit.count",
					type: "Sum",
					value: cumulativeCommitCount,
					attrs: { tool_name: "bash", decision: "git_commit" },
				})
			}

			// Flush PR count
			if (cumulativePRCount > 0) {
				allMetrics.push({
					name: "claude_code.pull_request.count",
					type: "Sum",
					value: cumulativePRCount,
					attrs: { tool_name: "bash", decision: "gh_pr_create" },
				})
			}

			// Flush lines of code (separate added/removed)
			if (cumulativeLinesAdded > 0) {
				allMetrics.push({
					name: "claude_code.lines_of_code.count",
					type: "Sum",
					value: cumulativeLinesAdded,
					attrs: { type: "added" },
				})
			}
			if (cumulativeLinesRemoved > 0) {
				allMetrics.push({
					name: "claude_code.lines_of_code.count",
					type: "Sum",
					value: cumulativeLinesRemoved,
					attrs: { type: "removed" },
				})
			}

			// Flush edit decisions with full attributes (language when known)
			allMetrics.push(...cumulativeEditDecisionsFull)

			if (allMetrics.length > 0) {
				track(sendMetrics(config, sessionId, allMetrics, sessionStartNano))
			}
		}

		pi.on("session_start", async () => {
			sessionId = crypto.randomUUID()
			sessionStartMs = Date.now()
			sessionStartNano = String(sessionStartMs * 1_000_000)
			sentMessages.clear()
			pendingArgs.clear()
			shuttingDown = false

			// Reset accumulation state
			for (const key of Object.keys(cumulativeTokensByModel)) delete cumulativeTokensByModel[key]
			for (const key of Object.keys(cumulativeCostByModel)) delete cumulativeCostByModel[key]
			cumulativeCommitCount = 0
			cumulativePRCount = 0
			cumulativeLinesAdded = 0
			cumulativeLinesRemoved = 0
			cumulativeEditDecisionsFull.length = 0

			// Start periodic flush timer
			if (flushTimer) clearInterval(flushTimer)
			flushTimer = setInterval(() => {
				flushMetrics()
			}, METRICS_FLUSH_INTERVAL_MS)
		})

		pi.on("session_shutdown", async () => {
			shuttingDown = true
			if (flushTimer) clearInterval(flushTimer)
			flushMetrics()
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
				// Use message ID if available, fall back to timestamp for deduplication
				const msgId = assistant.responseId ? String(assistant.responseId) : String(assistant.timestamp)
				if (sentMessages.has(msgId)) return
				sentMessages.add(msgId)

				const model = assistant.model ?? "unknown"
				const availableModels = getAvailableModels()
				const meta = availableModels.find((m) => m.slug === model)
				const rawProvider = String(assistant.provider ?? "unknown")
				const provider = meta?.provider ? meta.provider : rawProvider === "kimchi-dev" ? "ai-enabler" : rawProvider
				const { input, output, cacheRead, cacheWrite } = assistant.usage
				const costTotal = assistant.usage?.cost?.total ?? 0
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

				// Accumulate tokens and costs per model
				if (!cumulativeTokensByModel[model]) {
					cumulativeTokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
				}
				cumulativeTokensByModel[model].input += input
				cumulativeTokensByModel[model].output += output
				cumulativeTokensByModel[model].cacheRead += cacheRead
				cumulativeTokensByModel[model].cacheWrite += cacheWrite

				if (!cumulativeCostByModel[model]) {
					cumulativeCostByModel[model] = 0
				}
				cumulativeCostByModel[model] += costTotal
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
					track(sendLog(config, sessionId, "tool_usage", { tool_name: "bash", decision: "git_commit" }))
					cumulativeCommitCount++
					cumulativeEditDecisionsFull.push({
						name: "claude_code.code_edit_tool.decision",
						type: "Sum",
						value: 1,
						attrs: { tool_name: "bash", decision: "git_commit", source: "auto", decision_type: "applied" },
					})
				}
				if (/gh\s+pr\s+create\b/.test(command)) {
					track(sendLog(config, sessionId, "tool_usage", { tool_name: "bash", decision: "gh_pr_create" }))
					cumulativePRCount++
					cumulativeEditDecisionsFull.push({
						name: "claude_code.code_edit_tool.decision",
						type: "Sum",
						value: 1,
						attrs: { tool_name: "bash", decision: "gh_pr_create", source: "auto", decision_type: "applied" },
					})
				}
			}

			if (toolName === "edit") {
				const filePath = String(args?.filePath ?? "")
				const language = inferLanguage(filePath)
				const changes = countLineChanges(String(args?.oldString ?? ""), String(args?.newString ?? ""))
				track(
					sendLog(config, sessionId, "tool_usage", {
						tool_name: "edit",
						language,
						lines_added: changes.added,
						lines_removed: changes.removed,
					}),
				)
				cumulativeLinesAdded += changes.added
				cumulativeLinesRemoved += changes.removed
				cumulativeEditDecisionsFull.push({
					name: "claude_code.code_edit_tool.decision",
					type: "Sum",
					value: 1,
					attrs: { tool_name: "edit", decision: "edit_applied", language, source: "auto", decision_type: "applied" },
				})
			}

			if (toolName === "write") {
				const filePath = String(args?.filePath ?? "")
				const language = inferLanguage(filePath)
				const content = String(args?.content ?? "")
				const trimmedContent = content.endsWith("\n") ? content.replace(/\n+$/, "") : content
				const actualLines = trimmedContent ? trimmedContent.split("\n").length : 1
				track(
					sendLog(config, sessionId, "tool_usage", {
						tool_name: "write",
						language,
						lines_added: actualLines,
					}),
				)
				// Emit lines_of_code.count directly with language attribute
				cumulativeEditDecisionsFull.push({
					name: "claude_code.lines_of_code.count",
					type: "Sum",
					value: actualLines,
					attrs: { type: "added", language },
				})
				// Emit code_edit_tool.decision with full attributes
				cumulativeEditDecisionsFull.push({
					name: "claude_code.code_edit_tool.decision",
					type: "Sum",
					value: 1,
					attrs: { tool_name: "write", decision: "write_created", language, source: "auto", decision_type: "applied" },
				})
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
							tool_name: "multiedit",
							language,
							lines_added: changes.added,
							lines_removed: changes.removed,
						}),
					)
					cumulativeLinesAdded += changes.added
					cumulativeLinesRemoved += changes.removed
				}
				cumulativeEditDecisionsFull.push({
					name: "claude_code.code_edit_tool.decision",
					type: "Sum",
					value: 1,
					attrs: {
						tool_name: "multiedit",
						decision: "edit_applied",
						language,
						source: "auto",
						decision_type: "applied",
					},
				})
			}
		})
	}
}
