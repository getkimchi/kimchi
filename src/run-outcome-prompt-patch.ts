import type { AgentSession } from "@earendil-works/pi-coding-agent"

export function observeAgentSessionPrompts(proto: Pick<AgentSession, "prompt">, onPrompt: () => void): void {
	const original = proto.prompt
	const wrapped: AgentSession["prompt"] = function (this: AgentSession, text, options) {
		onPrompt()
		return original.call(this, text, options)
	}
	proto.prompt = wrapped
}
