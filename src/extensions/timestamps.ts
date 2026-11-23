import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent"
import { liveTheme } from "../components/live-theme.js"
import { buildAlignedLine } from "../components/tool-block.js"
import { loadConfig, normalizeTuiTimezone, writeTuiTimestamps, writeTuiTimezone } from "../config.js"
import { notifyUser } from "../utils/notify-user.js"

export interface TranscriptTimestampConfig {
	enabled: boolean
	timezone?: string
}

/**
 * Component prototype patches are process-wide, and the interactive TUI has one
 * active display configuration per process. ACP/RPC sessions never configure or
 * install these adapters. Mutable state lives in this const singleton rather
 * than in extension factory locals, which would not be visible to Pi-created
 * components after their constructors return.
 */
const displayConfig: Required<TranscriptTimestampConfig> = {
	enabled: false,
	timezone: "local",
}

const componentTimestamps = new WeakMap<object, number>()
const formatterCache = new Map<string, Intl.DateTimeFormat>()
const patchedRenderers = new WeakSet<object>()
const patchedAdapters = new WeakSet<object>()
const installedAdapterRoots = new WeakSet<object>()
const missingPatchDiagnostics = new Set<string>()

/** Resolve "local" through the host's Intl implementation; invalid values use local. */
export function resolveTranscriptTimezone(value?: string): string {
	const normalized = normalizeTuiTimezone(value)
	if (normalized !== undefined && normalized !== "local") return normalized
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

/** Format an epoch-milliseconds timestamp without locale-dependent field order. */
export function formatTranscriptTimestamp(timestampMs: number, timezone?: string): string | undefined {
	if (!Number.isFinite(timestampMs)) return undefined
	if (timezone !== undefined && normalizeTuiTimezone(timezone) === undefined) return undefined
	return formatResolvedTimestamp(timestampMs, resolveTranscriptTimezone(timezone))
}

/** Render-time path: configuration already resolved and validated this zone. */
function formatResolvedTimestamp(timestampMs: number, resolvedTimezone: string): string | undefined {
	if (!Number.isFinite(timestampMs)) return undefined
	try {
		let formatter = formatterCache.get(resolvedTimezone)
		if (!formatter) {
			formatter = new Intl.DateTimeFormat("en-GB", {
				timeZone: resolvedTimezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
				timeZoneName: "shortOffset",
			})
			formatterCache.set(resolvedTimezone, formatter)
		}
		const values = new Map(formatter.formatToParts(timestampMs).map((part) => [part.type, part.value]))
		const year = values.get("year")
		const month = values.get("month")
		const day = values.get("day")
		const hour = values.get("hour")
		const minute = values.get("minute")
		const second = values.get("second")
		const rawOffset = values.get("timeZoneName")
		if (!year || !month || !day || !hour || !minute || !second || !rawOffset) return undefined
		// Node emits GMT+0 for UTC while Bun emits GMT; keep both runtimes stable.
		const offset = rawOffset === "GMT" ? "GMT+0" : rawOffset
		return `${year}-${month}-${day} ${hour}:${minute}:${second} ${offset}`
	} catch {
		return undefined
	}
}

export function configureTranscriptTimestamps(config: TranscriptTimestampConfig): void {
	displayConfig.enabled = config.enabled
	displayConfig.timezone = resolveTranscriptTimezone(config.timezone)
}

function warnMissingPatch(target: string): void {
	if (missingPatchDiagnostics.has(target)) return
	missingPatchDiagnostics.add(target)
	console.warn(`transcript timestamps: ${target} not found; timestamp rendering is unavailable for this component`)
}

function validTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function messageTimestamp(component: object): number | undefined {
	const recorded = componentTimestamps.get(component)
	if (recorded !== undefined) return recorded
	const message: unknown = Reflect.get(component, "lastMessage")
	if (message === null || typeof message !== "object") return undefined
	return validTimestamp(Reflect.get(message, "timestamp"))
}

interface TimestampRenderable {
	render(width: number): string[]
}

/** Prepend role-labelled, right-aligned metadata outside content and ANSI zones. */
function patchTimestampRenderer(prototype: TimestampRenderable, label: string): void {
	if (patchedRenderers.has(prototype)) return
	const originalRender = prototype.render
	if (typeof originalRender !== "function") {
		warnMissingPatch(`${prototype.constructor.name}.render`)
		return
	}
	patchedRenderers.add(prototype)

	prototype.render = function timestampedRender(width: number): string[] {
		const lines = originalRender.call(this, width)
		if (!displayConfig.enabled || lines.length === 0) return lines
		const timestamp = messageTimestamp(this)
		if (timestamp === undefined) return lines
		const text = formatResolvedTimestamp(timestamp, displayConfig.timezone)
		if (!text) return lines

		const theme = liveTheme()
		const role = theme?.fg("accent", `${label} ·`) ?? `${label} ·`
		const datetime = theme?.fg("muted", text) ?? text
		return [buildAlignedLine(role, datetime, Math.max(1, Math.floor(width))), ...lines]
	}
}

interface InteractiveModeAdapter {
	chatContainer?: { children?: unknown[] }
	addMessageToChat?: (message: { timestamp?: unknown }, options?: unknown) => unknown
}

/** Associate Pi-created child components with the persisted source message. */
function patchAddMessageToChat(): void {
	const prototype = InteractiveMode.prototype as unknown as InteractiveModeAdapter
	const original = prototype.addMessageToChat
	if (typeof original !== "function") {
		warnMissingPatch("InteractiveMode.addMessageToChat")
		return
	}
	if (patchedAdapters.has(prototype)) return
	patchedAdapters.add(prototype)

	prototype.addMessageToChat = function timestampedAddMessage(message, options) {
		const children = this.chatContainer?.children
		const previousChildCount = children?.length ?? 0
		const result = original.call(this, message, options)
		const timestamp = validTimestamp(message.timestamp)
		if (timestamp !== undefined && Array.isArray(children)) {
			// Only decorate children appended by this message. Snapshotting every
			// existing child made session resume quadratic as history grew.
			for (let index = previousChildCount; index < children.length; index++) {
				const child = children[index]
				if (child !== null && typeof child === "object") componentTimestamps.set(child, timestamp)
			}
		}
		return result
	}
}

interface ToolExecutionAdapter {
	updateResult?: (result: { timestamp?: unknown }, isPartial?: boolean) => unknown
}

interface BashExecutionAdapter {
	setComplete?: (
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: unknown,
		fullOutputPath?: string,
	) => unknown
}

/** Install display adapters once; no message, result, or session data is mutated. */
export function installTranscriptTimestampAdapters(): void {
	const adapterRoot = InteractiveMode.prototype as object
	if (installedAdapterRoots.has(adapterRoot)) return
	installedAdapterRoots.add(adapterRoot)

	patchAddMessageToChat()
	const renderers: [TimestampRenderable, string][] = [
		[UserMessageComponent.prototype, "user"],
		[AssistantMessageComponent.prototype, "assistant"],
		[ToolExecutionComponent.prototype, "tool completed"],
		[BashExecutionComponent.prototype, "bash completed"],
		[CustomMessageComponent.prototype, "event"],
		[CompactionSummaryMessageComponent.prototype, "compaction"],
		[BranchSummaryMessageComponent.prototype, "branch"],
		[SkillInvocationMessageComponent.prototype, "skill"],
	]
	for (const [prototype, label] of renderers) patchTimestampRenderer(prototype, label)

	const toolPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionAdapter
	const originalToolResult = toolPrototype.updateResult
	if (typeof originalToolResult === "function") {
		toolPrototype.updateResult = function timestampedToolResult(result, isPartial) {
			const output = originalToolResult.call(this, result, isPartial)
			if (isPartial !== true) componentTimestamps.set(this, validTimestamp(result.timestamp) ?? Date.now())
			return output
		}
	} else {
		warnMissingPatch("ToolExecutionComponent.updateResult")
	}

	const bashPrototype = BashExecutionComponent.prototype as unknown as BashExecutionAdapter
	const originalBashComplete = bashPrototype.setComplete
	if (typeof originalBashComplete === "function") {
		bashPrototype.setComplete = function timestampedBashComplete(
			exitCode,
			cancelled,
			truncationResult,
			fullOutputPath,
		) {
			const output = originalBashComplete.call(this, exitCode, cancelled, truncationResult, fullOutputPath)
			// A replay may have supplied a historical time before calling this
			// method again. Only live, previously-unstamped executions use now.
			if (!componentTimestamps.has(this)) componentTimestamps.set(this, Date.now())
			return output
		}
	} else {
		warnMissingPatch("BashExecutionComponent.setComplete")
	}
}

const TIMESTAMPS_USAGE = "/timestamps [on|off|status] or /timestamps timezone <local|UTC|IANA zone>"

interface EffectiveTimestampConfig {
	enabled: boolean
	timezone: string
}

function applyEffectiveTimestamps(ctx: Pick<ExtensionCommandContext, "cwd">): EffectiveTimestampConfig {
	const tui = loadConfig({ cwd: ctx.cwd }).tui
	const enabled = tui?.timestamps === true
	const timezone = resolveTranscriptTimezone(tui?.timezone)
	configureTranscriptTimestamps({ enabled, timezone })
	return { enabled, timezone }
}

function timestampStatus(config: EffectiveTimestampConfig): string {
	return `Transcript timestamps: ${config.enabled ? "on" : "off"}; timezone: ${config.timezone}`
}

export async function handleTimestampsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [rawAction, ...actionArgs] = args.trim().split(/\s+/).filter(Boolean)
	const action = rawAction?.toLowerCase() || "status"
	if (ctx.mode !== "tui") {
		notifyUser(ctx, "Transcript timestamp display is available only in the interactive TUI.", "warning")
		return
	}
	if (action === "status" && actionArgs.length === 0) {
		notifyUser(ctx, `${timestampStatus(applyEffectiveTimestamps(ctx))}. Use ${TIMESTAMPS_USAGE}.`, "info")
		return
	}

	let effective: EffectiveTimestampConfig
	let warnedAboutProjectOverride = false
	if ((action === "on" || action === "off") && actionArgs.length === 0) {
		const enabled = action === "on"
		writeTuiTimestamps(enabled)
		effective = applyEffectiveTimestamps(ctx)
		warnedAboutProjectOverride = effective.enabled !== enabled
	} else if (action === "timezone" && actionArgs.length === 1) {
		const timezone = normalizeTuiTimezone(actionArgs[0])
		if (!timezone) {
			notifyUser(ctx, `Invalid timezone "${actionArgs[0]}". Use ${TIMESTAMPS_USAGE}.`, "error")
			return
		}
		writeTuiTimezone(timezone)
		effective = applyEffectiveTimestamps(ctx)
		const requestedTimezone = resolveTranscriptTimezone(timezone)
		warnedAboutProjectOverride = effective.timezone !== requestedTimezone
	} else {
		notifyUser(ctx, `Usage: ${TIMESTAMPS_USAGE}`, "error")
		return
	}
	const shadowNote = warnedAboutProjectOverride
		? " A trusted project .kimchi/config.json overrides the global write."
		: ""
	// ctx.ui.notify triggers Pi's redraw in the TUI. Every existing component
	// already carries display metadata, so its next render uses this setting.
	notifyUser(ctx, `${timestampStatus(effective)}.${shadowNote}`, warnedAboutProjectOverride ? "warning" : "info")
}

export function timestampArgumentCompletions(prefix: string): { value: string; label: string; description: string }[] {
	const parts = prefix.trimStart().split(/\s+/)
	if (parts[0]?.toLowerCase() === "timezone") {
		const zonePrefix = parts[1]?.toLowerCase() ?? ""
		return ["local", "UTC"]
			.filter((zone) => zone.toLowerCase().startsWith(zonePrefix))
			.map((zone) => ({ value: zone, label: zone, description: `Display timestamps in ${zone}` }))
	}
	return [
		{ value: "status", label: "status", description: "Show current timestamp settings" },
		{ value: "on", label: "on", description: "Enable transcript timestamps" },
		{ value: "off", label: "off", description: "Disable transcript timestamps" },
		{ value: "timezone", label: "timezone", description: "Set local, UTC, or an IANA timezone" },
	].filter((option) => option.value.startsWith(parts[0]?.toLowerCase() ?? ""))
}

export default function transcriptTimestampsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return
		installTranscriptTimestampAdapters()
		const tui = loadConfig({ cwd: ctx.cwd }).tui
		configureTranscriptTimestamps({ enabled: tui?.timestamps === true, timezone: tui?.timezone })
	})
	pi.registerCommand("timestamps", {
		description: "Show, enable, or configure interactive transcript timestamps",
		getArgumentCompletions: timestampArgumentCompletions,
		handler: handleTimestampsCommand,
	})
}
