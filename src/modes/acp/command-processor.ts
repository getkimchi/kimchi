/**
 * Command processor — transforms slash commands into structured prompt data.
 *
 * This module is transport-agnostic: it knows nothing about ACP, JSON-RPC,
 * or any specific protocol. It simply parses command syntax and returns
 * structured data that can be used to build prompts.
 */

/** Common fields shared by all command results. */
interface CommandResultBase {
	/** The original input text, unmodified. */
	readonly originalText: string
	/** The processed text to send to the agent. */
	readonly promptText: string
}

/** Input was not a slash command — pass through unchanged. */
export interface PassthroughResult extends CommandResultBase {
	readonly isCommand: false
}

/** A recognised slash command with command-specific payload. */
export interface CreateFermentResult extends CommandResultBase {
	readonly isCommand: true
	readonly command: "create_ferment"
	readonly argument: string
	readonly title: string
	readonly intent: string
}

/** A slash command that was parsed but is not (yet) handled. */
export interface UnknownCommandResult extends CommandResultBase {
	readonly isCommand: true
	readonly command: string
	readonly argument: string
}

/**
 * Discriminated union of all possible command processing outcomes.
 *
 * Discriminate on `isCommand` first, then narrow on `command` to access
 * command-specific fields like `title` and `intent`.
 */
export type CommandResult = PassthroughResult | CreateFermentResult | UnknownCommandResult

/**
 * Parse and process slash commands from user input.
 *
 * Supported commands:
 * - /create_ferment [title] — Creates a new ferment workflow
 *
 * Commands are case-insensitive.
 *
 * @param text - The raw input text
 * @returns A discriminated {@link CommandResult}
 */
export function processCommand(text: string): CommandResult {
	const trimmed = text.trim()

	// Check for command prefix
	if (!trimmed.startsWith("/")) {
		return { originalText: text, isCommand: false, promptText: text }
	}

	// Extract command name (case-insensitive) and argument
	const spaceIndex = trimmed.indexOf(" ")
	const command = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).toLowerCase()
	const argument = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim()

	if (!command) {
		// Bare "/" with no command name — not a command
		return { originalText: text, isCommand: false, promptText: text }
	}

	switch (command) {
		case "create_ferment":
			return buildCreateFerment(text, argument)

		// Future commands:
		// case "pause_ferment":
		// case "resume_ferment":
		// case "complete_ferment":

		default:
			return {
				originalText: text,
				isCommand: true,
				command,
				argument,
				promptText: text,
			}
	}
}

function buildCreateFerment(originalText: string, argument: string): CreateFermentResult {
	const title = argument || "New Ferment"
	const intent = argument
		? `User wants to create a ferment: ${argument}`
		: "User wants to create a new ferment workflow"

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
