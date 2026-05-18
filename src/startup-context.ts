/**
 * Startup context shared between cli.ts and extensions.
 *
 * cli.ts runs before pi-mono's main() and before any extension factory is
 * invoked. It writes discovered model metadata here after fetching from the
 * API, so extensions can read a fully populated context when they initialise.
 *
 * Module-level state is safe here because Node/Bun evaluates each module
 * exactly once per process. By the time any extension factory runs, cli.ts
 * has already set these values.
 */

import type { ModelMetadata } from "./models.js"

export interface StartupContext {
	availableModels?: readonly ModelMetadata[]
	sessionName?: string
}

let _availableModels: readonly ModelMetadata[] = []
let _sessionName: string | undefined = undefined

export function setAvailableModels(models: readonly ModelMetadata[]): void {
	_availableModels = models
}

export function getAvailableModels(): readonly ModelMetadata[] {
	return _availableModels
}

export function setSessionName(name: string | undefined): void {
	_sessionName = name
}

export function getSessionName(): string | undefined {
	return _sessionName
}

/**
 * Parse the --name flag from raw CLI args.
 * Returns the name value and the indices of arguments that should be stripped
 * from the args list.
 * Only consumes the next token as the value if it does not start with "-".
 */
export function parseNameArg(rawArgs: string[]): { name: string | undefined; stripIndices: number[] } {
	let name: string | undefined
	const stripIndices: number[] = []

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i]
		if (arg === "--name") {
			stripIndices.push(i)
			const next = rawArgs[i + 1]
			if (next !== undefined && !next.startsWith("-")) {
				name = next
				stripIndices.push(i + 1)
				i++ // skip the value in the loop
			}
			break
		}
		if (arg?.startsWith("--name=")) {
			name = arg.slice("--name=".length)
			stripIndices.push(i)
			break
		}
	}

	return { name, stripIndices }
}

/**
 * Parse startup context from raw CLI args.
 * NOTE: This does NOT mutate rawArgs — the --name stripping happens in cli.ts.
 */
export function resolveStartupContext(rawArgs: string[]): StartupContext {
	const context: StartupContext = {}

	const { name } = parseNameArg(rawArgs)
	if (name) {
		context.sessionName = name
	}

	// Also load available models (set by cli.ts before extensions run)
	const models = getAvailableModels()
	if (models.length > 0) {
		context.availableModels = models
	}

	return context
}
