import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { FERMENT_V2_COMMAND_NAME, FERMENT_V2_RESOURCE_ID } from "../ferment-v2/constants.js"
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
	const startFerment = options.startFerment ?? (({ ctx }) => ctx.ui.setEditorText(`/${FERMENT_V2_COMMAND_NAME} `))

	return sessionModeOnboardingExtension({
		launchContext: buildSessionModeLaunchContext(options.rawArgs, {
			nonInteractiveMode: options.nonInteractiveMode,
			stdinIsTTY: options.stdinIsTTY,
			stdoutIsTTY: options.stdoutIsTTY,
		}),
		configPath: options.configPath,
		now: options.now,
		shouldSkip: () => options.shouldSkip?.() === true || !isResourceEnabled(FERMENT_V2_RESOURCE_ID),
		onOutcome: (outcome, ctx, pi) => {
			if (outcome === "ferment") return startFerment({ pi, ctx })
		},
	})
}
