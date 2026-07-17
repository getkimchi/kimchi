import type { AvailableCommand } from "@agentclientprotocol/sdk"

import { GOAL_RESOURCE_ID } from "../../extensions/goal/constants.js"
import { SLASH_COMMANDS } from "../../extensions/slash-commands.js"
import { isResourceEnabled } from "../../resources/store.js"

export const CAPABILITIES_KEY = "kimchi.dev"

type AcpAvailableCommand = AvailableCommand & {
	name: keyof typeof SLASH_COMMANDS
}

export function buildAvailableCommands(goalEnabled = isResourceEnabled(GOAL_RESOURCE_ID)): AcpAvailableCommand[] {
	return [
		{
			name: "bug",
			description: SLASH_COMMANDS.bug.hint,
			input: {
				hint: "Provide a concise title (3-5 words) to describe the issue.",
			},
		},
		...(goalEnabled
			? [
					{
						name: "goal" as const,
						description: SLASH_COMMANDS.goal.hint,
						input: { hint: "Provide the persistent session objective." },
					},
				]
			: []),
	]
}

export const AVAILABLE_COMMANDS = buildAvailableCommands()
