import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
import { getCliModeArg, isPreDispatchValueFlag } from "../../cli-args.js"
import { readHideSessionModeDialog, readSessionModeWizardSeenAt, writeSessionModeWizardSeenAt } from "../../config.js"

import { setTipWidgetLocation } from "../tips/index.js"
import { setSessionModeOnboardingFooterSuppressed } from "../ui.js"
import { NoOpPickerEditor } from "./picker-editor.js"
import {
	SessionModePickerComponent,
	type SessionModePickerResult,
	type SessionModePickerState,
	initialSessionModePickerState,
	keyToSessionModePickerEvent,
} from "./session-mode-picker.js"

// Stateless editor — share a single instance across factory invocations so
// pi-tui doesn't churn allocations if it re-instantiates the editor on resize
// or theme change.
const NO_OP_EDITOR = new NoOpPickerEditor()

export type SessionModeOnboardingAction = "show" | "skip" | "skip-and-mark-seen"

export type SessionModeOnboardingReason =
	| "eligible"
	| "hidden"
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
	seenAt?: string
	hideSessionModeDialog?: boolean
	sessionStartReason?: SessionStartEvent["reason"]
}

const SESSION_MODE_WIDGET_KEY = "kimchi-session-mode-onboarding"
const SESSION_MODE_WIDGET_OPTIONS = { placement: "aboveEditor" } as const

export type SessionModeWizardOutcome = "default" | "ferment" | "cancelled"

export interface SessionModeOnboardingExtensionOptions {
	launchContext: SessionModeLaunchContext
	configPath?: string
	now?: () => Date
	shouldSkip?: () => boolean
	onOutcome?: (
		outcome: Extract<SessionModeWizardOutcome, "default" | "ferment">,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	) => void | Promise<void>
}

export default function sessionModeOnboardingExtension(options: SessionModeOnboardingExtensionOptions) {
	return (pi: ExtensionAPI) => {
		let cleanupActiveWizard: (() => void) | undefined

		pi.on("session_start", (event, ctx) => {
			cleanupActiveWizard?.()
			cleanupActiveWizard = undefined
			if (options.shouldSkip?.()) return
			const seenAt = readSessionModeWizardSeenAt(options.configPath)
			const decision = decideSessionModeOnboarding({
				launchContext: options.launchContext,
				hasUI: ctx.hasUI,
				seenAt,
				hideSessionModeDialog: readHideSessionModeDialog(options.configPath),
				sessionStartReason: event.reason,
			})
			if (decision.action === "skip-and-mark-seen") {
				markSessionModeWizardSeen({ configPath: options.configPath, now: options.now })
				return
			}
			if (decision.action === "show") {
				// Reaching "show" means seenAt was undefined (already-seen short-circuits
				// above), so this is the first run — mark seen immediately so a crash or
				// kill before selection doesn't re-show the picker next time.
				try {
					markSessionModeWizardSeen({ configPath: options.configPath, now: options.now })
				} catch (err) {
					ctx.ui.notify(
						`Could not save session mode onboarding state: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					)
				}
				cleanupActiveWizard = showSessionModeWizard(pi, ctx, options, () => {
					cleanupActiveWizard = undefined
				})
			}
		})

		pi.on("session_shutdown", () => {
			cleanupActiveWizard?.()
			cleanupActiveWizard = undefined
		})
	}
}

function showSessionModeWizard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: SessionModeOnboardingExtensionOptions,
	onCleanup: () => void,
): () => void {
	let finished = false
	let activated = false
	let unsubscribeInput: (() => void) | undefined
	let restoreTips: (() => void) | undefined
	let tuiRef: { hasOverlay(): boolean } | null = null
	let component: SessionModePickerComponent | undefined
	let editorSwapped = false
	// Held in the wizard closure so pi-tui re-invoking the widget factory
	// (resize, theme swap, etc.) re-creates the component without resetting
	// the user's highlight.
	let pickerState: SessionModePickerState = initialSessionModePickerState()
	const onPickerStateChange = (next: SessionModePickerState): void => {
		pickerState = next
	}
	// Captured from getEditorComponent() right before we swap. ui.ts registers
	// its session_start handler before ours (see cli.ts extension order), so in
	// the normal launch path this holds the upstream PromptEditor factory.
	// If it's undefined (no upstream editor installed yet), cleanup will pass
	// undefined back through, which restores pi-tui's library default.
	let prevEditorFactory: EditorFactory | undefined

	// Empty shim component mounted before activation. Renders nothing so the
	// picker contributes zero visual footprint while we wait for any overlay
	// (e.g. Mike's Shift+Enter terminal-compat warning) to clear. We still get
	// the tui reference from setWidget's factory so we can poll hasOverlay().
	const SHIM_COMPONENT = { render: () => [], invalidate: () => {} } as const

	const activate = () => {
		if (activated || finished) return
		// pi-tui routes terminal input through the current editor. If we swap
		// the editor (or mount a non-empty picker that consumes keys) while an
		// overlay is up, the overlay loses its dismissal keys and becomes
		// stuck. So we mount the picker + swap the editor atomically only once
		// no overlay is present. If tuiRef hasn't been set yet (shim factory
		// not invoked), treat that as "unknown overlay state" and bail; the
		// next input retry will re-attempt.
		if (!tuiRef || (typeof tuiRef.hasOverlay === "function" && tuiRef.hasOverlay())) return
		activated = true
		ctx.ui.setWidget(
			SESSION_MODE_WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui as unknown as { hasOverlay(): boolean }
				component = new SessionModePickerComponent(theme, finish, () => tui.requestRender(), {
					initialState: pickerState,
					onStateChange: onPickerStateChange,
				})
				return component
			},
			SESSION_MODE_WIDGET_OPTIONS,
		)
		prevEditorFactory = ctx.ui.getEditorComponent()
		// Flip editorSwapped before the call so a throw mid-mutation still
		// triggers a restore on cleanup.
		editorSwapped = true
		ctx.ui.setEditorComponent(() => NO_OP_EDITOR)
	}

	const cleanup = () => {
		unsubscribeInput?.()
		unsubscribeInput = undefined
		ctx.ui.setWidget(SESSION_MODE_WIDGET_KEY, undefined, SESSION_MODE_WIDGET_OPTIONS)
		restoreTips?.()
		restoreTips = undefined
		setSessionModeOnboardingFooterSuppressed(false)
		if (editorSwapped) {
			ctx.ui.setEditorComponent(prevEditorFactory)
			editorSwapped = false
		}
		onCleanup()
	}

	const finish = (result: SessionModePickerResult) => {
		if (finished) return
		finished = true
		try {
			if (result !== "cancelled") {
				recordSessionModeWizardOutcome(result, { configPath: options.configPath, now: options.now })
			}
		} catch (err) {
			cleanup()
			ctx.ui.notify(
				`Could not save session mode onboarding state: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			)
			return
		}
		cleanup()
		if (result !== "cancelled" && options.onOutcome) {
			Promise.resolve()
				.then(() => options.onOutcome?.(result, ctx, pi))
				.catch((err: unknown) => {
					ctx.ui.notify(`Session mode startup failed: ${err instanceof Error ? err.message : String(err)}`, "warning")
				})
		}
	}

	restoreTips = setTipWidgetLocation("hidden")
	setSessionModeOnboardingFooterSuppressed(true)
	// Mount an invisible shim so we can capture the tui reference (needed for
	// hasOverlay polling) without contributing any visual footprint. The shim
	// is replaced by the real picker inside activate().
	ctx.ui.setWidget(
		SESSION_MODE_WIDGET_KEY,
		(tui) => {
			tuiRef = tui as unknown as { hasOverlay(): boolean }
			// Defer the activation attempt to the next microtask so we don't
			// recurse into setWidget from inside the factory call.
			queueMicrotask(activate)
			return SHIM_COMPONENT
		},
		SESSION_MODE_WIDGET_OPTIONS,
	)
	unsubscribeInput = ctx.ui.onTerminalInput((data) => {
		const overlayUnknown = !tuiRef
		const overlayUp = !overlayUnknown && typeof tuiRef?.hasOverlay === "function" ? tuiRef.hasOverlay() : false
		if (overlayUnknown || overlayUp) {
			// The same keystroke that fires this handler may also dismiss the
			// overlay (Mike's Shift+Enter warning dismisses on any key). Re-check
			// on the next tick so the picker + editor swap happen as soon as the
			// overlay clears — without requiring a second keypress.
			if (!activated) setTimeout(activate, 0)
			return undefined
		}
		if (!activated) activate()
		const event = keyToSessionModePickerEvent(data)
		if (event) {
			component?.handleInput(data)
			return { consume: true }
		}
		return undefined
	})

	return () => {
		if (finished) return
		finished = true
		cleanup()
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
	if (input.hideSessionModeDialog) return { action: "skip", reason: "hidden" }
	// Show-once semantics: once the picker has been displayed (sessionModeWizardSeenAt
	// is written the moment the dialog mounts, even if the user cancels), never
	// show it again on subsequent startups.
	if (input.seenAt !== undefined) return { action: "skip", reason: "already-seen" }
	if (input.sessionStartReason !== undefined && input.sessionStartReason !== "startup") {
		return { action: "skip", reason: "explicit-session" }
	}
	if (!input.hasUI || !input.launchContext.stdinIsTTY || !input.launchContext.stdoutIsTTY) {
		return { action: "skip", reason: "not-interactive-tty" }
	}
	if (input.launchContext.nonInteractiveMode) return { action: "skip", reason: "automation-mode" }
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
