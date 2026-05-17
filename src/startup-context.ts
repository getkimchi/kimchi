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
 * Parse startup context from raw CLI args.
 * NOTE: This does NOT mutate rawArgs — the --name stripping happens in cli.ts.
 */
export function resolveStartupContext(rawArgs: string[]): StartupContext {
	const context: StartupContext = {}

	// Look for --name <value> in rawArgs
	for (let i = 0; i < rawArgs.length; i++) {
		if (rawArgs[i] === "--name" && rawArgs[i + 1] !== undefined) {
			context.sessionName = rawArgs[i + 1]
			break
		}
		// Handle --name=<value> format
		if (rawArgs[i]?.startsWith("--name=")) {
			context.sessionName = rawArgs[i].slice("--name=".length)
			break
		}
	}

	// Also load available models (set by cli.ts before extensions run)
	const models = getAvailableModels()
	if (models.length > 0) {
		context.availableModels = models
	}

	return context
}
