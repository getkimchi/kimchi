import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { startInteractiveFerment } from "../ferment/commands.js"
import sessionModeOnboardingExtension, { buildSessionModeLaunchContext } from "./session-mode.js"

export interface SessionModeStartupOptions {
	rawArgs: string[]
	nonInteractiveMode: boolean
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
	configPath?: string
	now?: () => Date
	shouldSkip?: () => boolean
	startFerment?: (params: { pi: ExtensionAPI; ctx: ExtensionContext }) => void | Promise<void>
}

export function createSessionModeOnboardingForStartup(options: SessionModeStartupOptions): ExtensionFactory {
	const startFerment =
		options.startFerment ??
		(({ pi, ctx }) => {
			return startInteractiveFerment({ pi, ctx })
		})

	return sessionModeOnboardingExtension({
		launchContext: buildSessionModeLaunchContext(options.rawArgs, {
			nonInteractiveMode: options.nonInteractiveMode,
			stdinIsTTY: options.stdinIsTTY,
			stdoutIsTTY: options.stdoutIsTTY,
		}),
		configPath: options.configPath,
		now: options.now,
		shouldSkip: options.shouldSkip,
		onOutcome: (outcome, ctx, pi) => {
			if (outcome === "ferment") return startFerment({ pi, ctx })
		},
	})
}
