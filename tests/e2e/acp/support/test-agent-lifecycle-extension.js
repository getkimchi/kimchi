import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

const path = join(process.env.HOME, ".config", "kimchi", "harness", "acp-test-agent-lifecycle.jsonl")
mkdirSync(dirname(path), { recursive: true })

function record(type, ctx, details = {}) {
	appendFileSync(
		path,
		`${JSON.stringify({ type, sessionId: ctx.sessionManager.getSessionId(), at: new Date().toISOString(), ...details })}\n`,
		"utf8",
	)
}

export default (pi) => {
	for (const type of ["agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end"]) {
		pi.on(type, (event, ctx) => {
			record(type, ctx, { toolName: event.toolName, toolCallId: event.toolCallId })
		})
	}
}
