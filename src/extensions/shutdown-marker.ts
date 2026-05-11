import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const AGENT_END_ENTRY_TYPE = "agent_end"
export const AGENT_TERMINATED_ENTRY_TYPE = "agent_terminated"

export interface AgentEndData {
	timestamp: number
}

export interface AgentTerminatedData {
	reason: "signal" | "disconnect"
	timestamp: number
}

type AppendFn = (type: string, data: unknown) => void

export class ShutdownMarker {
	private agentEndWritten = false
	private shutdownWritten = false

	onSessionStart(): void {
		this.agentEndWritten = false
		this.shutdownWritten = false
	}

	onAgentStart(): void {
		this.agentEndWritten = false
	}

	onAgentEnd(append: AppendFn): void {
		append(AGENT_END_ENTRY_TYPE, { timestamp: Date.now() } satisfies AgentEndData)
		this.agentEndWritten = true
	}

	onSessionShutdown(cause: "signal" | "disconnect", append: AppendFn): void {
		if (this.agentEndWritten || this.shutdownWritten) return
		this.shutdownWritten = true
		append(AGENT_TERMINATED_ENTRY_TYPE, { reason: cause, timestamp: Date.now() } satisfies AgentTerminatedData)
	}
}

export default function shutdownMarkerExtension(pi: ExtensionAPI): void {
	const marker = new ShutdownMarker()

	pi.on("session_start", () => {
		marker.onSessionStart()
	})

	pi.on("agent_start", () => {
		marker.onAgentStart()
	})

	pi.on("agent_end", () => {
		marker.onAgentEnd((type, data) => pi.appendEntry(type, data))
	})

	pi.on("session_shutdown", (event) => {
		const cause = (event as { cause?: "signal" | "disconnect" }).cause ?? "signal"
		marker.onSessionShutdown(cause, (type, data) => pi.appendEntry(type, data))
	})
}
