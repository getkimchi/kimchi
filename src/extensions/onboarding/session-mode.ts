import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { getCliModeArg } from "../../cli-args.js"
import { readSessionModeWizardSeenAt, writeSessionModeWizardSeenAt } from "../../config.js"

export type SessionModeOnboardingAction = "show" | "skip" | "skip-and-mark-seen"

export type SessionModeOnboardingReason =
	| "eligible"
	| "already-seen"
	| "not-interactive-tty"
	| "automation-mode"
	| "explicit-session"
	| "explicit-default-session"

export interface SessionModeOnboardingDecision {
	action: SessionModeOnboardingAction
	reason: SessionModeOnboardingReason
}

export interface SessionModeLaunchContext {
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
	automationMode: boolean
	explicitSession: boolean
	explicitDefaultIntent: boolean
}

export interface SessionModeOnboardingInput {
	launchContext: SessionModeLaunchContext
	hasUI: boolean
	seenAt?: string
	sessionStartReason?: SessionStartEvent["reason"]
}

export type SessionModeWizardOutcome = "default" | "ferment" | "cancelled"

export interface SessionModeOnboardingExtensionOptions {
	launchContext: SessionModeLaunchContext
	configPath?: string
	now?: () => Date
}

const VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
])

export default function sessionModeOnboardingExtension(options: SessionModeOnboardingExtensionOptions) {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", (event, ctx) => {
			const decision = decideSessionModeOnboarding({
				launchContext: options.launchContext,
				hasUI: ctx.hasUI,
				seenAt: readSessionModeWizardSeenAt(options.configPath),
				sessionStartReason: event.reason,
			})
			if (decision.action === "skip-and-mark-seen") {
				markSessionModeWizardSeen({ configPath: options.configPath, now: options.now })
			}
		})
	}
}

export function buildSessionModeLaunchContext(
	rawArgs: string[],
	options: { stdinIsTTY: boolean; stdoutIsTTY: boolean; isAcpMode: boolean },
): SessionModeLaunchContext {
	const flags = scanLaunchArgs(rawArgs)
	return {
		stdinIsTTY: options.stdinIsTTY,
		stdoutIsTTY: options.stdoutIsTTY,
		automationMode: options.isAcpMode || flags.automationMode,
		explicitSession: flags.explicitSession,
		explicitDefaultIntent: flags.explicitDefaultIntent,
	}
}

export function decideSessionModeOnboarding(input: SessionModeOnboardingInput): SessionModeOnboardingDecision {
	if (input.seenAt) return { action: "skip", reason: "already-seen" }
	if (input.sessionStartReason !== undefined && input.sessionStartReason !== "startup") {
		return { action: "skip", reason: "explicit-session" }
	}
	if (!input.hasUI || !input.launchContext.stdinIsTTY || !input.launchContext.stdoutIsTTY) {
		return { action: "skip", reason: "not-interactive-tty" }
	}
	if (input.launchContext.automationMode) return { action: "skip", reason: "automation-mode" }
	if (input.launchContext.explicitSession) return { action: "skip", reason: "explicit-session" }
	if (input.launchContext.explicitDefaultIntent) {
		return { action: "skip-and-mark-seen", reason: "explicit-default-session" }
	}
	return { action: "show", reason: "eligible" }
}

export function recordSessionModeWizardOutcome(
	outcome: SessionModeWizardOutcome,
	options?: { configPath?: string; now?: () => Date },
): string | undefined {
	if (outcome === "cancelled") return undefined
	return markSessionModeWizardSeen(options)
}

export function markSessionModeWizardSeen(options?: { configPath?: string; now?: () => Date }): string {
	const seenAt = (options?.now?.() ?? new Date()).toISOString()
	writeSessionModeWizardSeenAt(seenAt, options?.configPath)
	return seenAt
}

function scanLaunchArgs(rawArgs: string[]): {
	automationMode: boolean
	explicitSession: boolean
	explicitDefaultIntent: boolean
} {
	let automationMode = false
	let explicitSession = false
	let explicitDefaultIntent = false

	for (let i = 0; i < rawArgs.length; i += 1) {
		const arg = rawArgs[i]
		if (arg === "--mode") {
			if (isAutomationModeArg(getCliModeArg(rawArgs))) automationMode = true
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("--mode=")) {
			if (isAutomationModeArg(getCliModeArg(rawArgs))) automationMode = true
		} else if (arg === "--print" || arg === "-p") {
			automationMode = true
			if (looksLikeInlinePrintPrompt(rawArgs[i + 1])) i += 1
		} else if (arg === "--continue" || arg === "-c" || arg === "--resume" || arg === "-r") {
			explicitSession = true
		} else if (arg === "--session" || arg === "--fork") {
			explicitSession = true
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("@")) {
			explicitDefaultIntent = true
		} else if (VALUE_FLAGS.has(arg)) {
			if (i + 1 < rawArgs.length) i += 1
		} else if (arg.startsWith("--")) {
			if (!arg.includes("=") && isPotentialUnknownFlagValue(rawArgs[i + 1])) i += 1
		} else if (!arg.startsWith("-")) {
			explicitDefaultIntent = true
		}
	}

	return { automationMode, explicitSession, explicitDefaultIntent }
}

function isAutomationModeArg(mode: string | undefined): boolean {
	return mode === "json" || mode === "rpc"
}

function looksLikeInlinePrintPrompt(value: string | undefined): boolean {
	return value !== undefined && !value.startsWith("@") && (!value.startsWith("-") || value.startsWith("---"))
}

function isPotentialUnknownFlagValue(value: string | undefined): boolean {
	return value !== undefined && !value.startsWith("-") && !value.startsWith("@")
}
