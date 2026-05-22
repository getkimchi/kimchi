import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import sessionModeOnboardingExtension, { buildSessionModeLaunchContext } from "./session-mode.js"

export interface SessionModeStartupOptions {
	rawArgs: string[]
	nonInteractiveMode: boolean
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
}

export function createSessionModeOnboardingForStartup(options: SessionModeStartupOptions): ExtensionFactory {
	return sessionModeOnboardingExtension({
		launchContext: buildSessionModeLaunchContext(options.rawArgs, {
			nonInteractiveMode: options.nonInteractiveMode,
			stdinIsTTY: options.stdinIsTTY,
			stdoutIsTTY: options.stdoutIsTTY,
		}),
	})
}
