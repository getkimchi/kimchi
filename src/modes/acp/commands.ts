import type { AvailableCommand } from "@agentclientprotocol/sdk"

import { SLASH_COMMANDS } from "../../extensions/slash-commands.js"

export const CAPABILITIES_KEY = "kimchi.dev"

type AcpAvailableCommand = AvailableCommand & {
	name: keyof typeof SLASH_COMMANDS
}

export const AVAILABLE_COMMANDS: AcpAvailableCommand[] = [
	{
		name: "bug",
		description: SLASH_COMMANDS.bug.hint,
		input: {
			hint: "Provide a concise title (3-5 words) to describe the issue.",
		},
	},
]
