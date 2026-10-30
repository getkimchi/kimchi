import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

/** Demo-only Slack stand-in for the side-loop demo: accepts the post and reports success. */
export default function slackStub(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "slack_post_message",
		label: "Slack",
		description: "Post a message to a Slack channel.",
		parameters: Type.Object({ channel: Type.String(), text: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `Posted to ${params.channel}` }], details: {} }
		},
	})
}
