import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { Key } from "@earendil-works/pi-tui"
import { retainThinkingStepsPatch } from "./internal-patch.js"
import { parseThinkingMode } from "./parse.js"
import {
	clearThinkingStepsModePreference,
	readThinkingStepsModePreference,
	writeThinkingStepsModePreference,
} from "./persistence.js"
import {
	clearActiveThinkingState,
	clearThinkingMessageOwnership,
	getCurrentThinkingScopeKey,
	getThinkingStepsMode,
	nextThinkingRefreshLabel,
	recordThinkingMessageScope,
	registerThinkingPatchRelease,
	resolveThinkingMessageScope,
	setActiveThinkingState,
	setCurrentThinkingScopeKey,
	setLastThinkingDuration,
	setThinkingStepsMode,
	takeThinkingPatchRelease,
} from "./state.js"
import type { PersistedThinkingStepsPreferenceScope, ThinkingStepsMode } from "./types.js"

type ThinkingStepsCommandScope = "session" | PersistedThinkingStepsPreferenceScope
type ThinkingStepsCommandAction =
	| { type: "set"; scope: ThinkingStepsCommandScope; mode?: ThinkingStepsMode }
	| { type: "clear"; scope: PersistedThinkingStepsPreferenceScope }

const CUSTOM_ENTRY_TYPE = "thinking-steps.mode"
const DEFAULT_HIDDEN_LABEL = "Thinking..."
const MODE_OPTIONS: ThinkingStepsMode[] = ["collapsed", "expanded"]
const SCOPE_OPTIONS: PersistedThinkingStepsPreferenceScope[] = ["project", "global"]

function modeStatusText(ctx: ExtensionContext, mode: ThinkingStepsMode): string {
	return `${ctx.ui.theme.fg("muted", "thinking:")} ${ctx.ui.theme.fg("accent", mode)}`
}

function modeChangeMessage(mode: ThinkingStepsMode, scope: ThinkingStepsCommandScope): string {
	if (scope === "session") {
		return `Thinking view: ${mode}`
	}

	return `Thinking view: ${mode} (saved for ${scope})`
}

function invalidUsageMessage(): string {
	return "Usage: /thinking-steps [collapsed|expanded] | [project|global] [collapsed|expanded|clear]"
}

function notifyUser(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level)
		return
	}

	if (level === "warning") {
		console.warn(message)
		return
	}

	console.info(message)
}

function persistMode(pi: ExtensionAPI, mode: ThinkingStepsMode): void {
	pi.appendEntry(CUSTOM_ENTRY_TYPE, { mode })
}

async function readRestoredModePreference(
	ctx: ExtensionContext,
	scope: PersistedThinkingStepsPreferenceScope,
): Promise<ThinkingStepsMode | undefined> {
	try {
		return await readThinkingStepsModePreference(scope, ctx.cwd)
	} catch (error) {
		reportPersistenceError(ctx, error)
		return undefined
	}
}

async function restoreMode(ctx: ExtensionContext): Promise<ThinkingStepsMode> {
	const entries = ctx.sessionManager.getEntries() as Array<{
		type?: string
		customType?: string
		data?: { mode?: string }
	}>
	const savedEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE)
	for (let index = savedEntries.length - 1; index >= 0; index -= 1) {
		const sessionMode = parseThinkingMode(savedEntries[index]?.data?.mode ?? "")
		if (sessionMode) return sessionMode
	}

	const projectMode = await readRestoredModePreference(ctx, "project")
	if (projectMode) return projectMode

	const globalMode = await readRestoredModePreference(ctx, "global")
	return globalMode ?? "expanded"
}

function refreshThinkingUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	setCurrentThinkingScopeKey(ctx.cwd)
	ctx.ui.setHiddenThinkingLabel(nextThinkingRefreshLabel(DEFAULT_HIDDEN_LABEL, ctx.cwd))
	ctx.ui.setStatus("thinking-steps", modeStatusText(ctx, getThinkingStepsMode(ctx.cwd)))
}

function applyMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: ThinkingStepsMode,
	options?: { persistSession?: boolean; announceScope?: ThinkingStepsCommandScope },
): void {
	setCurrentThinkingScopeKey(ctx.cwd)
	setThinkingStepsMode(mode, ctx.cwd)
	if (options?.persistSession !== false) {
		persistMode(pi, mode)
	}
	refreshThinkingUI(ctx)
	if (options?.announceScope) {
		notifyUser(ctx, modeChangeMessage(mode, options.announceScope), "info")
	}
}

function cycleMode(current: ThinkingStepsMode): ThinkingStepsMode {
	if (current === "collapsed") return "expanded"
	if (current === "summary") return "expanded"
	return "collapsed"
}

function parsePreferenceScope(input: string): PersistedThinkingStepsPreferenceScope | undefined {
	const normalized = input.trim().toLowerCase()
	if (["project", "proj", "p"].includes(normalized)) return "project"
	if (["global", "user", "g"].includes(normalized)) return "global"
	return undefined
}

function isClearCommand(input: string): boolean {
	return ["clear", "reset"].includes(input.trim().toLowerCase())
}

function parseCommandAction(args: string): ThinkingStepsCommandAction | undefined {
	const trimmed = args.trim()
	if (!trimmed) {
		return { type: "set", scope: "session" }
	}

	const scope = parsePreferenceScope(trimmed.split(/\s+/, 1)[0] ?? "")
	if (!scope) {
		const mode = parseThinkingMode(trimmed)
		return mode ? { type: "set", scope: "session", mode } : undefined
	}

	const tail = trimmed.replace(/^\S+\s*/, "")
	if (!tail) {
		return { type: "set", scope }
	}

	if (isClearCommand(tail)) {
		return { type: "clear", scope }
	}

	const mode = parseThinkingMode(tail)
	return mode ? { type: "set", scope, mode } : undefined
}

function buildCompletionItems(values: string[], prefix: string, prefixText = ""): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trim().toLowerCase()
	const items = values
		.filter((value) => value.startsWith(normalizedPrefix))
		.map((value) => ({ value: `${prefixText}${value}`, label: value }))
	return items.length > 0 ? items : null
}

function thinkingModeCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trim()
	const endsWithWhitespace = /\s$/.test(prefix)

	if (!trimmed) {
		return [
			...MODE_OPTIONS.map((value) => ({ value, label: value })),
			...SCOPE_OPTIONS.map((value) => ({ value, label: value })),
		]
	}

	const parts = trimmed.split(/\s+/)
	if (parts.length === 1 && !endsWithWhitespace) {
		return buildCompletionItems([...MODE_OPTIONS, ...SCOPE_OPTIONS], parts[0] ?? "")
	}

	const scope = parsePreferenceScope(parts[0] ?? "")
	if (!scope) {
		return null
	}

	const valuePrefix = `${scope} `
	const nestedPrefix = endsWithWhitespace ? "" : parts.slice(1).join(" ")
	return buildCompletionItems([...MODE_OPTIONS, "clear"], nestedPrefix, valuePrefix)
}

async function selectMode(ctx: ExtensionContext): Promise<ThinkingStepsMode | undefined> {
	if (!ctx.hasUI) {
		return undefined
	}

	const choice = await ctx.ui.select("Thinking view", MODE_OPTIONS)
	return choice ? parseThinkingMode(choice) : undefined
}

function reportPersistenceError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(
		ctx,
		`Thinking steps persistence error: ${error instanceof Error ? error.message : String(error)}`,
		"warning",
	)
}

function reportPatchError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(ctx, `Thinking steps patch error: ${error instanceof Error ? error.message : String(error)}`, "warning")
}

export default function thinkingStepsExtension(pi: ExtensionAPI): void {
	let sessionScopeKey = getCurrentThinkingScopeKey()
	const degradedSessionScopes = new Set<string>()
	const setSessionScopeKey = (scopeKey: string): string => {
		sessionScopeKey = scopeKey
		setCurrentThinkingScopeKey(scopeKey)
		return sessionScopeKey
	}
	const markSessionDegraded = (scopeKey: string, degraded: boolean): void => {
		if (degraded) {
			degradedSessionScopes.add(scopeKey)
			return
		}
		degradedSessionScopes.delete(scopeKey)
	}
	const isSessionDegraded = (scopeKey: string): boolean => degradedSessionScopes.has(scopeKey)
	const degradedSessionMessage = (): string =>
		"Thinking steps is using Pi's native thinking renderer for this session; live mode switching is disabled."
	const futureCompatibleSessionMessage = (
		scope: PersistedThinkingStepsPreferenceScope,
		action: "saved" | "cleared",
	): string =>
		`${action === "saved" ? "Saved" : "Cleared"} ${scope} thinking view default for future compatible sessions; the current session is using Pi's native thinking renderer.`

	pi.registerCommand("thinking-steps", {
		description: "Switch thinking view or set/clear project/global defaults",
		getArgumentCompletions: thinkingModeCompletions,
		handler: async (args, ctx) => {
			const action = parseCommandAction(args)
			if (!action) {
				notifyUser(ctx, invalidUsageMessage(), "warning")
				return
			}

			const degraded = isSessionDegraded(ctx.cwd)
			if (action.type === "clear") {
				try {
					await clearThinkingStepsModePreference(action.scope, ctx.cwd)
				} catch (error) {
					reportPersistenceError(ctx, error)
					return
				}

				if (degraded) {
					notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "cleared"), "info")
					return
				}

				refreshThinkingUI(ctx)
				notifyUser(ctx, `Cleared ${action.scope} thinking view default`, "info")
				return
			}

			const selectedMode = action.mode ?? (await selectMode(ctx))
			if (!selectedMode) {
				return
			}

			if (action.scope !== "session") {
				try {
					await writeThinkingStepsModePreference(action.scope, ctx.cwd, selectedMode)
				} catch (error) {
					reportPersistenceError(ctx, error)
					return
				}
			}

			if (degraded) {
				if (action.scope === "session") {
					notifyUser(ctx, degradedSessionMessage(), "warning")
					return
				}
				notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "saved"), "info")
				return
			}

			applyMode(pi, ctx, selectedMode, { announceScope: action.scope })
		},
	})

	const thinkingToggleHandler = async (ctx: ExtensionContext) => {
		if (isSessionDegraded(ctx.cwd)) {
			notifyUser(ctx, degradedSessionMessage(), "warning")
			return
		}
		const nextMode = cycleMode(getThinkingStepsMode(ctx.cwd))
		applyMode(pi, ctx, nextMode, { announceScope: "session" })
	}

	pi.registerShortcut(Key.alt("t"), {
		description: "Toggle thinking view (collapsed / expanded)",
		handler: thinkingToggleHandler,
	})

	pi.on("session_start", async (_event, ctx) => {
		const activeScopeKey = setSessionScopeKey(ctx.cwd)
		clearActiveThinkingState(undefined, activeScopeKey)
		try {
			registerThinkingPatchRelease(activeScopeKey, await retainThinkingStepsPatch(ctx.ui.theme))
			markSessionDegraded(activeScopeKey, false)
		} catch (error) {
			markSessionDegraded(activeScopeKey, true)
			reportPatchError(ctx, error)
			notifyUser(ctx, degradedSessionMessage(), "warning")
			return
		}

		const restoredMode = await restoreMode(ctx)
		applyMode(pi, ctx, restoredMode, { persistSession: false })
	})

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey)
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey)
			const timestamp =
				typeof (event.message as { timestamp?: unknown }).timestamp === "number"
					? (event.message as { timestamp: number }).timestamp
					: undefined
			clearActiveThinkingState(timestamp, ownerScopeKey)
		}
	})

	let thinkingStartMs = 0

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return
		recordThinkingMessageScope(event.message, sessionScopeKey)
		const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey)
		const assistantEvent = event.assistantMessageEvent
		if (assistantEvent.type === "thinking_start" || assistantEvent.type === "thinking_delta") {
			if (assistantEvent.type === "thinking_start") {
				thinkingStartMs = Date.now()
			}
			setActiveThinkingState(
				{
					active: true,
					messageTimestamp: event.message.timestamp,
					contentIndex: assistantEvent.contentIndex,
				},
				ownerScopeKey,
			)
			return
		}

		if (assistantEvent.type === "thinking_end" && thinkingStartMs > 0) {
			const timestamp =
				typeof (event.message as { timestamp?: unknown }).timestamp === "number"
					? (event.message as { timestamp: number }).timestamp
					: undefined
			if (timestamp !== undefined) {
				setLastThinkingDuration(timestamp, Date.now() - thinkingStartMs)
			}
		}

		if (
			assistantEvent.type === "thinking_end" ||
			assistantEvent.type === "text_start" ||
			assistantEvent.type === "text_delta" ||
			assistantEvent.type === "text_end" ||
			assistantEvent.type === "toolcall_start" ||
			assistantEvent.type === "toolcall_delta" ||
			assistantEvent.type === "toolcall_end"
		) {
			clearActiveThinkingState(event.message.timestamp, ownerScopeKey)
		}
	})

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey)
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey)
			const timestamp =
				typeof (event.message as { timestamp?: unknown }).timestamp === "number"
					? (event.message as { timestamp: number }).timestamp
					: undefined
			clearActiveThinkingState(timestamp, ownerScopeKey)
		}
	})

	pi.on("agent_end", async () => {
		clearActiveThinkingState(undefined, sessionScopeKey)
	})

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeScopeKey = setSessionScopeKey(ctx.cwd)
		clearActiveThinkingState(undefined, activeScopeKey)
		clearThinkingMessageOwnership(activeScopeKey)
		markSessionDegraded(activeScopeKey, false)
		if (ctx.hasUI) {
			ctx.ui.setStatus("thinking-steps", undefined)
		}

		const releasePatch = takeThinkingPatchRelease(activeScopeKey)
		if (!releasePatch) {
			return
		}

		try {
			await releasePatch()
		} catch (error) {
			registerThinkingPatchRelease(activeScopeKey, releasePatch)
			reportPatchError(ctx, error)
		}
	})
}
