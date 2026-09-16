import { appendFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export type Arm = "solo" | "workers" | "messages" | "board"

const communicationTools = new Set([
	"list_agent_contacts",
	"send_agent_message",
	"reply_to_agent_message",
	"read_agent_board",
	"post_agent_note",
	"reconcile_agent_result",
])
const boardTools = new Set(["read_agent_board", "post_agent_note"])
export const roles = ["Lifecycle investigator", "Boundary investigator", "Implementation owner", "Repair owner"]

export function unavailableTool(name: string, arm: Arm): boolean {
	if (name === "resume_subagent" || name === "reconcile_agent_result") return true
	if (arm === "solo" && ["Agent", "get_subagent_result", "steer_subagent"].includes(name)) return true
	if ((arm === "solo" || arm === "workers") && communicationTools.has(name)) return true
	return arm === "messages" && boardTools.has(name)
}

export function stripGuidance(text: string, arm: Arm): string {
	const sections =
		arm === "solo" || arm === "workers"
			? ["Subagent messages", "Communication", "Coordination board"]
			: arm === "messages"
				? ["Coordination board"]
				: []
	for (const section of sections)
		text = text.replace(new RegExp(`^## ${section}\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, "gm"), "")
	return text
}

export function checkLaunch(input: Record<string, unknown>, arm: Arm, used: Set<string>): string | undefined {
	if (arm === "solo") return "This is the solo arm; complete the task without delegation."
	const role = String(input.description)
	if (!roles.includes(role)) return `Use only the declared worker descriptions: ${roles.join(", ")}.`
	if (used.has(role))
		return `${role} already started. Each worker gets one attempt; collect its result without resuming.`
	const owner = role === "Implementation owner" || role === "Repair owner"
	const required = {
		subagent_type: "General-Purpose",
		model: "glm-5.3-flash",
		thinking: "low",
		run_in_background: true,
		max_turns: owner ? 70 : 35,
		max_duration: 900,
		token_budget: role === "Implementation owner" ? 20000 : 10000,
		communication: arm === "workers" ? undefined : "group",
	}
	const mismatches = Object.entries(required)
		.filter(([key, value]) => input[key] !== value)
		.map(([key]) => key)
	if (input.ferment_v2 === true) mismatches.push("ferment_v2")
	if (mismatches.length)
		return `Correct launch fields ${mismatches.join(", ")}: ${JSON.stringify(required)}. Worker Ferment is off. No slot was used.`
}

/** Experiment-only channel masking and observations; no production policy changes. */
export function installExperiment(pi: ExtensionAPI, arm: Arm, auditPath: string): void {
	const used = new Set<string>()
	const pending = new Map<string, string>()
	const log = (event: Record<string, unknown>) =>
		appendFileSync(auditPath, `${JSON.stringify({ time: Date.now(), ...event })}\n`)
	pi.on("session_start", (_event, ctx) => ctx.ui.notify(`Communication experiment: ${arm}`, "info"))
	pi.on("before_agent_start", (event) => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !unavailableTool(name, arm)))
		return { systemPrompt: stripGuidance(event.systemPrompt, arm) }
	})
	pi.on("tool_call", (event, ctx) => {
		let reason: string | undefined
		if (unavailableTool(event.toolName, arm)) reason = `${event.toolName} is unavailable in the ${arm} arm.`
		if (event.toolName === "Agent") {
			reason ??= checkLaunch(event.input, arm, used)
			if (!reason && event.input.description === "Repair owner") {
				const records = new Map<string, { status: string }>()
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type !== "custom" || entry.customType !== "subagents:record") continue
					const record = entry.data as { id: string; visibility: string; status: string }
					if (record.visibility === "user") records.set(record.id, record)
				}
				if (
					used.size !== 3 ||
					records.size !== 3 ||
					[...records.values()].some((record) => ["queued", "running"].includes(record.status))
				)
					reason = "Collect all three initial workers before starting the Repair owner."
			}
			if (!reason && [...pending.values()].includes(String(event.input.description)))
				reason = "This worker launch is already pending."
			if (!reason) pending.set(event.toolCallId, String(event.input.description))
		}
		if (reason || event.toolName === "Agent")
			log({
				kind: "launch_or_rejection",
				sessionId: ctx.sessionManager.getSessionId(),
				tool: event.toolName,
				toolCallId: event.toolCallId,
				input: event.toolName === "Agent" ? event.input : undefined,
				reason,
			})
		if (reason) return { block: true, reason }
	})
	pi.on("tool_result", (event) => {
		const role = pending.get(event.toolCallId)
		if (!role) return
		pending.delete(event.toolCallId)
		if (!event.isError && typeof event.details === "object" && event.details !== null && "agentId" in event.details)
			used.add(role)
	})
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant")
			log({
				kind: "usage",
				sessionId: ctx.sessionManager.getSessionId(),
				timestamp: event.message.timestamp,
				usage: event.message.usage,
			})
	})
	pi.on("agent_settled", (_event, ctx) => {
		log({
			kind: "settled",
			sessionId: ctx.sessionManager.getSessionId(),
			parentSession: ctx.sessionManager.getHeader()?.parentSession,
		})
	})
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as {
			tools?: Array<{ function?: { name: string }; name?: string }>
			messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
		}
		const filtered = {
			...payload,
			tools: payload.tools?.filter((tool) => !unavailableTool(tool.function?.name ?? tool.name ?? "", arm)),
			messages: payload.messages?.map((message) => {
				if (message.role !== "system" && message.role !== "developer") return message
				return {
					...message,
					content:
						typeof message.content === "string"
							? stripGuidance(message.content, arm)
							: message.content.map((part) => (part.text ? { ...part, text: stripGuidance(part.text, arm) } : part)),
				}
			}),
		}
		log({
			kind: "request",
			sessionId: ctx.sessionManager.getSessionId(),
			parentSession: ctx.sessionManager.getHeader()?.parentSession,
			tools: filtered.tools?.map((tool) => tool.function?.name ?? tool.name),
			boardGuidance: JSON.stringify(filtered.messages).includes("## Coordination board"),
		})
		return filtered
	})
}
