/** Imported only by the disposable diagnostic build; default export observes workers. */
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { AgentManager } from "../../src/extensions/agents/manager/agent-manager.js"

export type DeliveryCondition = "checkpoint" | "artifacts" | "early" | "board" | "delayed"

interface Protocol {
	condition: DeliveryCondition
	audit: string
	result: string
	finding: string
	checkpoint?: string
	checkpointCwd?: string
}

function protocol(): Protocol {
	const path = process.env.KIMCHI_DELIVERY_PROTOCOL
	if (!path) throw new Error("KIMCHI_DELIVERY_PROTOCOL is required in the diagnostic build")
	return JSON.parse(readFileSync(path, "utf8"))
}

function log(config: Protocol, event: Record<string, unknown>): void {
	appendFileSync(config.audit, `${JSON.stringify({ time: Date.now(), ...event })}\n`)
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function saveResult(config: Protocol, result: unknown): void {
	writeFileSync(`${config.result}.pending`, `${JSON.stringify(result, null, 2)}\n`)
	renameSync(`${config.result}.pending`, config.result)
}

export function shouldPublish(condition: DeliveryCondition, edited: boolean): boolean {
	return condition === "early" || condition === "board" || (condition === "delayed" && edited)
}

/** Observe the actual provider payload; never insert evidence through this hook. */
export default function observeDelivery(pi: ExtensionAPI): void {
	const config = protocol()
	pi.on("before_agent_start", () => {
		pi.setActiveTools(
			pi.getActiveTools().filter((name) => !["Agent", "resume_subagent", "steer_subagent"].includes(name)),
		)
	})
	pi.on("before_provider_request", (event, ctx) => {
		log(config, { kind: "request", sessionId: ctx.sessionManager.getSessionId(), payload: event.payload })
	})
	pi.on("tool_call", (event, ctx) => {
		log(config, {
			kind: "tool_call",
			sessionId: ctx.sessionManager.getSessionId(),
			tool: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
		})
	})
	pi.on("tool_result", (event, ctx) => {
		log(config, {
			kind: "tool_result",
			sessionId: ctx.sessionManager.getSessionId(),
			tool: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			content: event.content,
		})
	})
}

export function installDeliveryProbe(pi: ExtensionAPI, manager: AgentManager): void {
	pi.registerCommand("delivery-diagnostic", {
		description: "Run the isolated, evaluator-controlled delivery diagnostic",
		handler: async (_args, ctx) => {
			const config = protocol()
			if (existsSync(config.result)) throw new Error("This diagnostic already has a result; never overwrite an attempt")
			if (!ctx.model) throw new Error("Select the frozen diagnostic model first")
			pi.appendEntry("delivery:started", { condition: config.condition })
			const rootSessionId = ctx.sessionManager.getSessionId()
			const sessionDir = ctx.sessionManager.getSessionDir()
			const sessionFile = join(sessionDir, `${randomUUID()}.jsonl`)
			const header = {
				...ctx.sessionManager.getHeader(),
				id: randomUUID(),
				cwd: ctx.cwd,
				parentSession: ctx.sessionManager.getSessionFile(),
			}
			let entries: unknown[] = []
			if (config.checkpoint) {
				if (!config.checkpointCwd) throw new Error("Checkpoint cwd is required")
				const saved = readFileSync(config.checkpoint, "utf8").replaceAll(config.checkpointCwd, ctx.cwd)
				entries = saved
					.trim()
					.split("\n")
					.slice(1)
					.map((line) => JSON.parse(line))
			}
			writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`)
			log(config, {
				kind: "checkpoint",
				sessionFile,
				entryCount: entries.length,
				entriesHash: hash(JSON.stringify(entries).replaceAll(ctx.cwd, "<WORKDIR>")),
			})
			const consumer = join(ctx.cwd, "consumer.py")
			let source = readFileSync(consumer, "utf8")
			let published = false
			let sourceId = ""
			let recipientId = ""
			let delivery: Promise<void> | undefined
			const publish = (): void => {
				if (published) return
				published = true
				const capability = manager.getAgentCommsCapability(sourceId)
				if (!capability) throw new Error("Replay source has no authorized communication capability")
				log(config, {
					kind: "publish",
					sourceId,
					recipientId,
					condition: config.condition,
					findingHash: hash(config.finding),
				})
				if (config.condition === "board") {
					const receipt = capability.postBoardEntry({
						kind: "finding",
						title: "Cancellation request is not an outcome",
						body: config.finding,
					})
					log(config, { kind: "receipt", receipt })
					if (!receipt.ok) throw new Error(`Board post failed: ${JSON.stringify(receipt)}`)
				} else {
					delivery = capability
						.sendMessage("diagnostic-finding", {
							recipient: { type: "agent", agentId: recipientId },
							payload: { kind: "status", summary: config.finding },
						})
						.then((receipt) => {
							log(config, { kind: "receipt", receipt })
							if (!["queued_before_session", "queued_for_running_session"].includes(receipt.status))
								throw new Error(`Message was not queued: ${JSON.stringify(receipt)}`)
						})
				}
			}
			manager.setMaxConcurrent(1)
			const prompt =
				config.condition === "checkpoint"
					? "Orient yourself by reading only TASK.md and consumer.py. Briefly describe the current implementation and what you need to investigate next. Leave reading producer.py, choosing a repair and editing files for the continuation. Do not delegate."
					: "Continue the saved task now: implement the repair, add focused checks, run the supplied tests and your checks, and report the actual result. You may inspect every supplied source file. Do not delegate. The contact named Replay source is an evaluator-controlled source of one verified finding, not an interactive investigator; it cannot answer questions."
			const options = {
				model: ctx.model,
				thinkingLevel: "low" as const,
				isBackground: true,
				communication: "group" as const,
				rootSessionId,
				fermentV2: false,
				maxTurns: 35,
				tokenBudget: 10000,
				maxDuration: 600,
				inheritContext: false,
			}
			const unsubscribe = pi.events.on("subagents:completed", (event) => {
				if ((event as { id?: string }).id === recipientId && sourceId) manager.abort(sourceId)
			})
			const unsubscribeFailed = pi.events.on("subagents:failed", (event) => {
				if ((event as { id?: string }).id === recipientId && sourceId) manager.abort(sourceId)
			})
			try {
				recipientId = manager.spawn(pi, ctx, "General-Purpose", prompt, {
					...options,
					description: "Delivery diagnostic recipient",
					sessionFile,
					sessionDir,
					onToolActivity: (activity) => {
						if (activity.status !== "completed" && activity.status !== "failed") return
						const current = existsSync(consumer) ? readFileSync(consumer, "utf8") : ""
						if (current !== source) {
							log(config, { kind: "edit", tool: activity.toolName, before: source, after: current })
							source = current
							if (config.condition === "delayed") publish()
						}
					},
				})
				sourceId = manager.spawn(pi, ctx, "General-Purpose", "Evaluator replay source: never execute inference.", {
					...options,
					description: "Replay source",
				})
				for (const id of [recipientId, sourceId]) {
					const record = manager.getRecord(id)
					if (!record) throw new Error("Native spawn did not create a record")
					record.groupId = "delivery-diagnostic"
					record.resultConsumed = true
				}
				if (manager.getRecord(sourceId)?.status !== "queued") throw new Error("Replay source must remain queued")
				if (shouldPublish(config.condition, false)) publish()
				while (manager.getRecord(recipientId)?.status === "running")
					await new Promise((resolve) => setTimeout(resolve, 100))
				manager.abort(sourceId)
				await manager.waitForAll()
				await delivery
				const record = manager.getRecord(recipientId)
				if (!record) throw new Error("Recipient record disappeared")
				const result = {
					condition: config.condition,
					recipientId,
					sourceId,
					sessionFile,
					cwd: ctx.cwd,
					status: record.status,
					abortReason: record.abortReason,
					result: record.result,
					usage: record.lifetimeUsage,
					startedAt: record.startedAt,
					completedAt: record.completedAt,
					published,
					sourceStatus: manager.getRecord(sourceId)?.status,
				}
				saveResult(config, result)
				ctx.ui.notify(`Delivery diagnostic finished: ${record.status}`, "info")
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				log(config, { kind: "error", message })
				saveResult(config, { condition: config.condition, status: "error", error: message })
				ctx.ui.notify(`Delivery diagnostic failed: ${message}`, "error")
			} finally {
				if (sourceId) manager.abort(sourceId)
				if (recipientId) manager.abort(recipientId)
				unsubscribe()
				unsubscribeFailed()
			}
		},
	})
}
