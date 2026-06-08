/**
 * ACP command processor - transforms slash commands into structured prompt data.
 *
 * This module is transport-agnostic. It doesn't know about ACP, JSON-RPC,
 * or any specific protocol. It simply parses command syntax and returns
 * structured data that can be used to build prompts.
 */

export interface CommandResult {
	/** The original input text */
	readonly originalText: string
	/** Whether a command was detected and processed */
	readonly isCommand: boolean
	/** The command name (e.g., "create_ferment") */
	readonly command?: string
	/** The command argument (raw text after command) */
	readonly argument?: string
	/** The processed text to send to the agent */
	readonly promptText: string
	/** The ferment title (if applicable) */
	readonly title?: string
	/** The user intent description (if applicable) */
	readonly intent?: string
}

/**
 * Parse and process slash commands from user input.
 *
 * Supported commands:
 * - /create_ferment [title] - Creates a new ferment workflow
 *
 * @param text - The raw input text
 * @returns CommandResult with processed data
 */
export function processCommand(text: string): CommandResult {
	const trimmed = text.trim()

	// Check for command prefix
	if (!trimmed.startsWith("/")) {
		return {
			originalText: text,
			isCommand: false,
			promptText: text,
		}
	}

	// Extract command name (case-insensitive) and argument
	const spaceIndex = trimmed.indexOf(" ")
	const commandRaw = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
	const command = commandRaw.toLowerCase()
	const argument = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim()

	switch (command) {
		case "create_ferment":
			return processCreateFerment(text, argument)

		// Future commands:
		// case "pause_ferment":
		// case "resume_ferment":
		// case "complete_ferment":

		default:
			// Unknown command - return unchanged
			return {
				originalText: text,
				isCommand: true,
				command,
				argument,
				promptText: text,
			}
	}
}

function processCreateFerment(originalText: string, argument: string): CommandResult {
	const title = argument || "New Ferment"
	const intent = argument
		? `User wants to create a ferment: ${argument}`
		: "User wants to create a new ferment workflow"

	// Transform into a prompt that triggers the request_ferment_workflow tool
	const promptText = `Create a ferment workflow using the request_ferment_workflow tool with title "${title}" and intent: ${intent}`

	return {
		originalText,
		isCommand: true,
		command: "create_ferment",
		argument,
		promptText,
		title,
		intent,
	}
}
