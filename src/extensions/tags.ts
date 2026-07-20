/**
 * Tags Extension
 *
 * Manages LLM request tags for usage tracking and cost attribution.
 * Features:
 * - Slash commands: /tags, /tags add <key:value>, /tags remove <key:value>, /tags clear
 * - Status line display of active tags with color coding
 * - Integration with before_provider_request hook
 *
 * Tags are stored per-session and persisted via session entries.
 */

import { homedir } from "node:os"
import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { readJson } from "../config/json.js"
import { readConfigSetting } from "../config/settings.js"
import type { ThinkingLevel } from "./agents/personas/types.js"
import { isStaleCtxError } from "./stale-ctx.js"

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_LINE_TAGS_KEY = "active-tags"
const TAGS_CONFIG_FILE = resolve(homedir(), ".config", "kimchi", "tags.json")
const TAGS_SESSION_ENTRY_TYPE = "kimchi_active_tags"

export function readHidePhaseChanges(): boolean {
	return readConfigSetting("hidePhaseChanges", (value) => typeof value === "boolean", false)
}

const TAG_COLORS: ThemeColor[] = ["accent", "mdLink", "success", "warning"]

// Valid phases for phase tracking
const VALID_PHASES = ["explore", "plan", "build", "review", "research"] as const
type Phase = (typeof VALID_PHASES)[number]

export function isValidPhase(phase: string): phase is Phase {
	return VALID_PHASES.includes(phase as Phase)
}

// ─── Tag validation ───────────────────────────────────────────────────────────

const TAG_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?:[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

export function isValidTag(tag: string): boolean {
	if (!TAG_RE.test(tag)) return false
	const [key, value] = tag.split(":", 2)
	return key.length <= 64 && value.length <= 64
}

export function parseTag(tag: string): { key: string; value: string } | null {
	if (!isValidTag(tag)) return null
	const [key, value] = tag.split(":", 2)
	return { key, value }
}

// ─── Tag storage ──────────────────────────────────────────────────────────────

interface TagsConfig {
	tags?: string[]
}

export type TagAppendEntry = (customType: string, data?: unknown) => void

export class TagManager {
	private readonly sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">
	private readonly appendEntry: TagAppendEntry
	private readonly configFile = TAGS_CONFIG_FILE

	private tags: Set<string> = new Set()
	private defaultTags: Set<string> = new Set()
	private hasSessionTags = false

	constructor(sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">, appendEntry: TagAppendEntry) {
		this.sessionManager = sessionManager
		this.appendEntry = appendEntry
		this.loadTags()
	}

	private loadTags(): void {
		this.loadDefaultTags()

		const sessionTags = this.loadSessionTags()
		if (sessionTags !== undefined) {
			this.tags.clear()
			for (const tag of sessionTags) {
				if (isValidTag(tag)) {
					this.tags.add(tag)
				}
			}
			this.hasSessionTags = true
			return
		}

		for (const tag of this.defaultTags) {
			this.tags.add(tag)
		}
	}

	private loadDefaultTags(): void {
		// Load from config file (defaults for new sessions)
		try {
			const config = readJson(this.configFile) as TagsConfig
			if (Array.isArray(config.tags)) {
				for (const tag of config.tags) {
					if (isValidTag(tag)) {
						this.defaultTags.add(tag)
					}
				}
			}
		} catch {
			// Config file doesn't exist or is invalid, ignore
		}

		// Load from environment variable (defaults for new sessions)
		const envTags = process.env.KIMCHI_TAGS
		if (envTags) {
			for (const tag of envTags.split(",")) {
				const trimmed = tag.trim()
				if (isValidTag(trimmed)) {
					this.defaultTags.add(trimmed)
				}
			}
		}
	}

	private loadSessionTags(): string[] | undefined {
		const entry = this.sessionManager
			.getEntries()
			.findLast(
				(item): item is CustomEntry<string[]> => item.type === "custom" && item.customType === TAGS_SESSION_ENTRY_TYPE,
			)
		return entry?.data
	}

	private persistTags(): void {
		this.appendEntry(TAGS_SESSION_ENTRY_TYPE, Array.from(this.tags).sort())
	}

	getAllTags(): string[] {
		return Array.from(this.tags)
	}

	getUserTags(): string[] {
		return this.hasSessionTags
			? Array.from(this.tags)
			: Array.from(this.tags).filter((tag) => !this.defaultTags.has(tag))
	}

	getStaticTags(): string[] {
		return Array.from(this.defaultTags)
	}

	add(tag: string): { success: boolean; error?: string } {
		if (!isValidTag(tag)) {
			return {
				success: false,
				error: `Invalid tag format. Use "key:value" (alphanumeric, hyphens, underscores, dots allowed, max 64 chars each).`,
			}
		}

		if (this.tags.has(tag)) {
			return { success: false, error: `Tag "${tag}" already exists.` }
		}

		if (this.tags.size >= 10) {
			return { success: false, error: "Maximum 10 tags allowed (including default tags)." }
		}

		this.tags.add(tag)
		this.hasSessionTags = true
		this.persistTags()
		return { success: true }
	}

	remove(tag: string): { success: boolean; error?: string } {
		if (!this.tags.has(tag)) {
			return { success: false, error: `Tag "${tag}" not found.` }
		}

		this.tags.delete(tag)
		this.hasSessionTags = true
		this.persistTags()
		return { success: true }
	}

	clear(): { removed: number } {
		const removed = this.tags.size
		this.tags.clear()
		this.hasSessionTags = true
		this.persistTags()
		return { removed }
	}

	isStatic(tag: string): boolean {
		return this.defaultTags.has(tag)
	}

	getPhaseTag(phase: Phase | undefined): string | undefined {
		return phase ? `phase:${phase}` : undefined
	}
}

// ─── Status line formatting ──────────────────────────────────────────────────

function getColorForKey(key: string): ThemeColor {
	// Deterministic color based on key name
	const hash = key.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
	return TAG_COLORS[hash % TAG_COLORS.length]
}

function formatTagsForStatusLine(tags: string[], theme: Theme, phase: Phase | undefined): string {
	// Group tags by key for display
	const grouped = new Map<string, string[]>()
	for (const tag of tags) {
		const parsed = parseTag(tag)
		if (parsed) {
			const existing = grouped.get(parsed.key) ?? []
			existing.push(parsed.value)
			grouped.set(parsed.key, existing)
		}
	}

	// Format with colors - sort keys for consistent display
	const parts: string[] = []
	const sortedKeys = Array.from(grouped.keys()).sort()

	for (const key of sortedKeys) {
		const values = grouped.get(key) ?? []
		const color = getColorForKey(key)
		const coloredKey = theme.fg("dim", `${key}:`)
		const coloredValues = values
			.sort()
			.map((v) => theme.fg(color, v))
			.join(theme.fg("dim", ","))
		parts.push(`${coloredKey}${coloredValues}`)
	}

	// Build the status line
	const statusParts: string[] = []

	// Phase indicator (if set)
	if (phase) {
		statusParts.push(theme.fg("dim", "phase: ") + theme.fg("success", phase))
	}

	// Tags indicator
	if (parts.length > 0) {
		statusParts.push(theme.fg("dim", "tags: ") + parts.join(theme.fg("dim", " ")))
	}

	if (statusParts.length === 0) {
		return theme.fg("muted", "tags: none")
	}

	return statusParts.join("  ")
}

function updateStatusLineTags(tagManager: TagManager, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return

	const allTags = tagManager.getAllTags()
	const currentPhase = getCurrentPhase(ctx.sessionManager.getSessionId())
	const statusText = formatTagsForStatusLine(allTags, ctx.ui.theme, currentPhase)
	ctx.ui.setStatus(STATUS_LINE_TAGS_KEY, statusText)
}

// ─── Command handlers ─────────────────────────────────────────────────────────

function subcommandArgs(args: string, subcommand: string): string {
	const normalised = args.trim()
	return normalised.slice(subcommand.length).trim()
}

async function handlePhaseCommand(args: string, ctx: ExtensionCommandContext, tagManager: TagManager): Promise<void> {
	const trimmed = args.trim().toLowerCase()
	const sessionId = ctx.sessionManager.getSessionId()

	// No arg → show current phase + offer interactive selector when there's a UI.
	if (!trimmed) {
		const current = getCurrentPhase(sessionId)
		const currentLabel = current ? `current phase: ${current}` : "no phase set"

		if (!ctx.hasUI) {
			console.log(`${currentLabel}\nValid phases: ${VALID_PHASES.join(", ")}, none`)
			return
		}

		const choice = await ctx.ui.select(`Phase — ${currentLabel}`, [...VALID_PHASES, "none (clear)"])
		if (!choice) return

		if (choice === "none (clear)") {
			setCurrentPhase(sessionId, undefined)
			updateStatusLineTags(tagManager, ctx)
			ctx.ui.notify("Phase cleared", "info")
			return
		}

		const next = choice as Phase
		setCurrentPhase(sessionId, next)
		updateStatusLineTags(tagManager, ctx)
		ctx.ui.notify(`Phase changed to: ${next}`, "info")
		return
	}

	// Explicit clear.
	if (trimmed === "none" || trimmed === "clear" || trimmed === "off") {
		setCurrentPhase(sessionId, undefined)
		if (ctx.hasUI) {
			updateStatusLineTags(tagManager, ctx)
			ctx.ui.notify("Phase cleared", "info")
		} else {
			console.log("Phase cleared")
		}
		return
	}

	// Direct switch via /phase <name>.
	if (!isValidPhase(trimmed)) {
		const msg = `Invalid phase "${args.trim()}". Valid: ${VALID_PHASES.join(", ")}, none`
		if (ctx.hasUI) ctx.ui.notify(msg, "error")
		else console.error(msg)
		return
	}

	setCurrentPhase(sessionId, trimmed)
	if (ctx.hasUI) {
		updateStatusLineTags(tagManager, ctx)
		ctx.ui.notify(`Phase changed to: ${trimmed}`, "info")
	} else {
		console.log(`Phase changed to: ${trimmed}`)
	}
}

function handleTagsCommand(args: string, ctx: ExtensionCommandContext, tagManager: TagManager): void {
	const trimmed = args.trim().toLowerCase()

	if (!trimmed || trimmed === "list" || trimmed === "ls") {
		// List all tags
		const allTags = tagManager.getAllTags()
		const userTags = tagManager.getUserTags()
		const staticTags = tagManager.getStaticTags()

		if (allTags.length === 0) {
			ctx.ui.notify("No tags configured. Use '/tags add key:value' to add tags.", "info")
			return
		}

		const lines: string[] = []
		lines.push("Active tags:")

		for (const tag of allTags.sort()) {
			const isDefault = staticTags.includes(tag)
			const marker = isDefault ? "[default]" : "[user]"
			const colorTag = ctx.ui.theme.fg("accent", tag)
			const colorMarker = ctx.ui.theme.fg("dim", marker)
			lines.push(`  ${colorMarker} ${colorTag}`)
		}

		lines.push("")
		const countColor = allTags.length >= 8 ? "warning" : "dim"
		lines.push(
			ctx.ui.theme.fg(
				countColor,
				`Total: ${allTags.length}/10 tags${userTags.length > 0 ? ` (${userTags.length} user-defined)` : ""}`,
			),
		)

		ctx.ui.notify(lines.join("\n"), "info")
		return
	}

	if (trimmed.startsWith("add ")) {
		const tagsInput = subcommandArgs(args, "add")
		const tagsToAdd = tagsInput.split(/\s+/).filter((t) => t.length > 0)

		if (tagsToAdd.length === 0) {
			ctx.ui.notify("No tags provided. Use '/tags add key:value' to add tags.", "error")
			return
		}

		const results: Array<{ tag: string; success: boolean; error?: string }> = []
		for (const tag of tagsToAdd) {
			results.push({ tag, ...tagManager.add(tag) })
		}

		const succeeded = results.filter((r) => r.success)
		const failed = results.filter((r) => !r.success)

		if (succeeded.length > 0) {
			updateStatusLineTags(tagManager, ctx)
		}

		const lines: string[] = []
		if (succeeded.length > 0) {
			lines.push(`Added ${succeeded.length} tag(s):`)
			for (const { tag } of succeeded) {
				lines.push(`  ${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("accent", tag)}`)
			}
		}
		if (failed.length > 0) {
			if (lines.length > 0) lines.push("")
			lines.push(`Failed to add ${failed.length} tag(s):`)
			for (const { tag, error } of failed) {
				lines.push(`  ${ctx.ui.theme.fg("error", "✗")} ${ctx.ui.theme.fg("accent", tag)}: ${error}`)
			}
		}
		ctx.ui.notify(lines.join("\n"), failed.length > 0 && succeeded.length === 0 ? "error" : "info")
		return
	}

	if (trimmed.startsWith("remove ") || trimmed.startsWith("rm ")) {
		const tagsInput = subcommandArgs(args, trimmed.startsWith("remove ") ? "remove" : "rm")
		const tagsToRemove = tagsInput.split(/\s+/).filter((t) => t.length > 0)

		if (tagsToRemove.length === 0) {
			ctx.ui.notify("No tags provided. Use '/tags remove key:value' to remove tags.", "error")
			return
		}

		const results: Array<{ tag: string; success: boolean; error?: string }> = []
		for (const tag of tagsToRemove) {
			results.push({ tag, ...tagManager.remove(tag) })
		}

		const succeeded = results.filter((r) => r.success)
		const failed = results.filter((r) => !r.success)

		if (succeeded.length > 0) {
			updateStatusLineTags(tagManager, ctx)
		}

		const lines: string[] = []
		if (succeeded.length > 0) {
			lines.push(`Removed ${succeeded.length} tag(s):`)
			for (const { tag } of succeeded) {
				lines.push(`  ${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("accent", tag)}`)
			}
		}
		if (failed.length > 0) {
			if (lines.length > 0) lines.push("")
			lines.push(`Failed to remove ${failed.length} tag(s):`)
			for (const { tag, error } of failed) {
				lines.push(`  ${ctx.ui.theme.fg("error", "✗")} ${ctx.ui.theme.fg("accent", tag)}: ${error}`)
			}
		}
		ctx.ui.notify(lines.join("\n"), failed.length > 0 && succeeded.length === 0 ? "error" : "info")
		return
	}

	if (trimmed === "clear") {
		const result = tagManager.clear()
		updateStatusLineTags(tagManager, ctx)
		ctx.ui.notify(`Cleared ${result.removed} user-defined tag(s).`, "info")
		return
	}

	// Help
	const helpLines = [
		"Tag management commands:",
		"",
		"  /tags                      List all active tags",
		"  /tags add key:value ...    Add one or more tags",
		"  /tags remove tag ...       Remove one or more user-defined tags",
		"  /tags clear                Remove all user-defined tags",
		"",
		"Default tags from config/env are applied to new sessions; session changes override them.",
		`Current default tags: ${tagManager.getStaticTags().length > 0 ? tagManager.getStaticTags().join(", ") : "none"}`,
	]
	ctx.ui.notify(helpLines.join("\n"), "info")
}

// ─── Phase Tool Parameters ─────────────────────────────────────────────────────

const SetPhaseParams = Type.Object({
	phase: Type.String({
		description: "The phase to set. Valid phases: explore, plan, build, review, research",
		enum: ["explore", "plan", "build", "review", "research"],
	}),
	thinking: Type.Optional(
		Type.String({
			description:
				"Optional thinking level to use when the orchestrator performs this phase itself (not delegating). Set per the Orchestration Thinking levels table.",
			enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
		}),
	),
})

// ─── Extension entry point ─────────────────────────────────────────────────────

const phaseMap = new Map<string, Phase | undefined>()

export function getCurrentPhase(sessionId: string): Phase | undefined {
	return phaseMap.get(sessionId)
}

export function setCurrentPhase(sessionId: string, phase: string | undefined): void {
	if (phase !== undefined && !isValidPhase(phase)) return
	phaseMap.set(sessionId, phase)
}

const tagManagerMap = new Map<string, TagManager>()

function getTagManager(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">,
	appendEntry: TagAppendEntry,
): TagManager {
	const sessionId = sessionManager.getSessionId()
	let tagManager = tagManagerMap.get(sessionId)
	if (!tagManager) {
		tagManager = new TagManager(sessionManager, appendEntry)
		tagManagerMap.set(sessionId, tagManager)
	}
	return tagManager
}

export function getActiveTags(sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">): string[] {
	// Read-only lookup: do not cache this instance, otherwise a later
	// command/tool context that needs to mutate tags would get a no-op
	// appendEntry from the cached instance.
	return new TagManager(sessionManager, () => {}).getAllTags()
}

export default function tagsExtension(pi: ExtensionAPI) {
	function getExtensionTagManager(ctx: ExtensionContext): TagManager {
		return getTagManager(ctx.sessionManager, pi.appendEntry)
	}

	// Register the /tags command
	pi.registerCommand("tags", {
		description: "Manage LLM request tags for usage tracking",
		handler: async (args, ctx) => {
			handleTagsCommand(args, ctx, getExtensionTagManager(ctx))
		},
	})

	// Register the /phase slash command — manual phase switch (mirrors set_phase tool).
	pi.registerCommand("phase", {
		description: `Show or change the current work phase (${VALID_PHASES.join(", ")})`,
		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase()
			return VALID_PHASES.filter((p) => p.startsWith(lower)).map((value) => ({
				value,
				label: value,
				description: `Switch to ${value} phase`,
			}))
		},
		handler: async (args, ctx) => {
			await handlePhaseCommand(args, ctx, getExtensionTagManager(ctx))
		},
	})

	// Register the set_phase tool
	pi.registerTool({
		name: "set_phase",
		label: "Set Phase",
		description:
			"Set the current work phase for usage tracking and analytics. The session starts in explore. Call when transitioning between phases (e.g., exploration to planning, or planning to building). The phase is included as a tag in subsequent LLM requests. When the orchestrator decides to perform a phase itself rather than delegating, pass `thinking` to match the Orchestration Thinking levels table.",
		parameters: SetPhaseParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const phase = params.phase as Phase
			const thinking = params.thinking as ThinkingLevel | undefined
			const tagManager = getExtensionTagManager(ctx)
			const sessionId = ctx.sessionManager.getSessionId()

			setCurrentPhase(sessionId, phase)
			if (thinking) {
				pi.setThinkingLevel(thinking)
			}

			if (ctx.hasUI) {
				updateStatusLineTags(tagManager, ctx)
			}

			return {
				content: [{ type: "text", text: `Phase changed to: ${phase}` }],
				details: { phase, thinking, model: ctx.model?.id },
			}
		},

		renderCall(_args, _theme) {
			return new Text("", 0, 0)
		},

		renderResult(result, _options, theme) {
			if (readHidePhaseChanges()) {
				return new Text("", 0, 0)
			}
			const details = result.details as { phase: string; thinking?: ThinkingLevel; model?: string } | undefined
			const phase = details?.phase ?? "unknown"
			const model = details?.model
			const thinkingSuffix = details?.thinking ? theme.fg("dim", ` · thinking ${details.thinking}`) : ""
			const dash = theme.fg("dim", "- ")
			const label = theme.bold(theme.fg("toolTitle", `Phase changed: ${phase}`))
			const modelSuffix = model ? theme.fg("dim", ` [${model}]`) : ""
			return new Text(dash + label + modelSuffix + thinkingSuffix, 0, 0)
		},
	})

	// Initialize status line tags status and default phase on session start
	pi.on("session_start", async (_event, ctx) => {
		const tagManager = getExtensionTagManager(ctx)
		const sessionId = ctx.sessionManager.getSessionId()

		setCurrentPhase(sessionId, "explore")
		updateStatusLineTags(tagManager, ctx)
	})

	// Inject tags into every LLM request
	pi.on("before_provider_request", async (event, ctx) => {
		// Tags are a Cast AI-specific API field; skip for other providers.
		// If a request from a torn-down session reaches us after `/new` (etc.),
		// any ctx getter throws via assertActive — bail silently in that case.
		let model: Model<Api> | undefined
		try {
			model = ctx.model ?? undefined
		} catch (err) {
			if (isStaleCtxError(err)) return
			throw err
		}
		if (model?.provider !== "kimchi-dev") return

		const payload = event.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const sessionId = ctx.sessionManager.getSessionId()
		const tagManager = getExtensionTagManager(ctx)
		const allTags = tagManager.getAllTags()

		// Build reserved tags first (model + phase) so they are never dropped by the cap
		const reservedTags: string[] = []
		if (model?.id) {
			reservedTags.push(`model:${model.id}`)
		}
		const phaseTag = tagManager.getPhaseTag(getCurrentPhase(sessionId))
		if (phaseTag) {
			reservedTags.push(phaseTag)
		}

		// User tags are capped at 10; reserved tags (model, phase) ride on top of that cap
		const finalTags = [...reservedTags, ...allTags.slice(0, 10)]

		if (finalTags.length === 0) return

		// Merge with any existing tags in the payload — extension tags take priority
		const existing = Array.isArray(payload.tags) ? (payload.tags as string[]) : []
		const extensionSet = new Set(finalTags)
		const uniqueExisting = existing.filter((t) => !extensionSet.has(t))
		const merged = [...finalTags, ...uniqueExisting].slice(0, 10 + reservedTags.length)

		if (merged.length > 0) {
			payload.tags = merged
		}

		return payload
	})
}
