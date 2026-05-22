import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { getCliModeArg, isPreDispatchValueFlag } from "../../cli-args.js"

export type SessionModeOnboardingAction = "skip"

export type SessionModeOnboardingReason =
	| "hidden"
	| "not-interactive-tty"
	| "automation-mode"
	| "explicit-session"
	| "explicit-default-session"
	| "default-chat"

export interface SessionModeOnboardingDecision {
	action: SessionModeOnboardingAction
	reason: SessionModeOnboardingReason
}

export interface SessionModeLaunchContext {
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
	// JSON/RPC/print/ACP-style launches are controlled by another process or
	// stream protocol. They must not render interactive onboarding or persist a
	// first-run choice.
	nonInteractiveMode: boolean
	// Resume, continue, session selection, and fork launches already name an
	// existing session flow. Skip onboarding without marking it seen so the
	// user's explicit session intent is not interrupted or consumed as Default.
	explicitSession: boolean
	explicitDefaultIntent: boolean
}

export interface SessionModeOnboardingInput {
	launchContext: SessionModeLaunchContext
	hasUI: boolean
	sessionStartReason?: SessionStartEvent["reason"]
}

export default function sessionModeOnboardingExtension(_options: unknown): (pi: ExtensionAPI) => void {
	return () => {
		// No-op: the session-mode picker has been removed.
	}
}

export function buildSessionModeLaunchContext(
	rawArgs: string[],
	options: { stdinIsTTY: boolean; stdoutIsTTY: boolean; nonInteractiveMode: boolean },
): SessionModeLaunchContext {
	const flags = scanLaunchArgs(rawArgs)
	return {
		stdinIsTTY: options.stdinIsTTY,
		stdoutIsTTY: options.stdoutIsTTY,
		nonInteractiveMode: options.nonInteractiveMode || flags.nonInteractiveMode,
		explicitSession: flags.explicitSession,
		explicitDefaultIntent: flags.explicitDefaultIntent,
	}
}

export function decideSessionModeOnboarding(input: SessionModeOnboardingInput): SessionModeOnboardingDecision {
	if (input.sessionStartReason !== undefined && input.sessionStartReason !== "startup") {
		return { action: "skip", reason: "explicit-session" }
	}
	if (!input.hasUI || !input.launchContext.stdinIsTTY || !input.launchContext.stdoutIsTTY) {
		return { action: "skip", reason: "not-interactive-tty" }
	}
	if (input.launchContext.nonInteractiveMode) return { action: "skip", reason: "automation-mode" }
	if (input.launchContext.explicitSession) return { action: "skip", reason: "explicit-session" }
	if (input.launchContext.explicitDefaultIntent) {
		return { action: "skip", reason: "explicit-default-session" }
	}
	return { action: "skip", reason: "default-chat" }
}

function scanLaunchArgs(rawArgs: string[]): {
	nonInteractiveMode: boolean
	explicitSession: boolean
	explicitDefaultIntent: boolean
} {
	let nonInteractiveMode = false
	let explicitSession = false
	let explicitDefaultIntent = false

	for (let i = 0; i < rawArgs.length; i += 1) {
		const arg = rawArgs[i]
		if (arg === "--mode") {
			if (isNonInteractiveModeArg(getCliModeArg(rawArgs))) nonInteractiveMode = true
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("--mode=")) {
			if (isNonInteractiveModeArg(getCliModeArg(rawArgs))) nonInteractiveMode = true
		} else if (arg === "--print" || arg === "-p") {
			nonInteractiveMode = true
			if (looksLikeInlinePrintPrompt(rawArgs[i + 1])) i += 1
		} else if (arg === "--continue" || arg === "-c" || arg === "--resume" || arg === "-r") {
			explicitSession = true
		} else if (arg === "--session" || arg === "--fork") {
			explicitSession = true
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("@")) {
			explicitDefaultIntent = true
		} else if (isPreDispatchValueFlag(arg)) {
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("--")) {
			if (!arg.includes("=") && isPotentialUnknownFlagValue(rawArgs[i + 1])) i += 1
		} else if (!arg.startsWith("-")) {
			explicitDefaultIntent = true
		}
	}

	return { nonInteractiveMode, explicitSession, explicitDefaultIntent }
}

function isNonInteractiveModeArg(mode: string | undefined): boolean {
	return mode === "json" || mode === "rpc"
}

function looksLikeInlinePrintPrompt(value: string | undefined): boolean {
	return value !== undefined && !value.startsWith("@") && (!value.startsWith("-") || value.startsWith("---"))
}

function isPotentialUnknownFlagValue(value: string | undefined): boolean {
	return value !== undefined && !value.startsWith("-") && !value.startsWith("@")
}
