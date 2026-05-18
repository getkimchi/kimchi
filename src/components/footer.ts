import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG, resolvedAccentFg, resolvedSemanticFg } from "../ansi.js"
import { getActiveAgentCount } from "../extensions/agents/index.js"
import { getActiveFerment, getCurrentPhaseIndex } from "../extensions/ferment/index.js"
import { formatCount } from "../extensions/format.js"
import { getCurrentPermissionsMode } from "../extensions/permissions/index.js"
import { MULTI_MODEL_SHORTCUT, getMultiModelEnabled } from "../extensions/prompt-construction/prompt-enrichment.js"
import { getActiveTags, getCurrentPhase, parseTag } from "../extensions/tags.js"

/** Stable identifier used by compaction steps to find segments. */
type SegmentId =
	| "permissions"
	| "multi-model"
	| "model"
	| "ferment"
	| "agents"
	| "context"
	| "usage"
	| "phase"
	| "tags"
	| "team"

/** Raw inputs preserved on segments that have compact forms, so compaction
 *  steps can rebuild the colorized text without round-tripping through ANSI.
 *
 *  `ferment` is the odd one out: instead of storing inputs and rebuilding the
 *  whole segment, it just stashes the leading colorized `ferment:` substring
 *  so the compaction step can slice it off in place. Cheaper than a rebuild
 *  and the segment's tail is identical in both forms anyway. */
type SegmentRaw =
	| { kind: "context"; percent: number; pctColor?: "error" | "warning" }
	| { kind: "multi-model"; enabled: boolean }
	| { kind: "phase"; phase: string }
	| { kind: "ferment"; prefix: string; prefixWidth: number }

/** A single piece of the footer line. */
interface Segment {
	/** Stable identifier used by compaction steps to find this segment. */
	id: SegmentId
	/** Already-colorized text (includes ANSI). */
	text: string
	/** Visible width of `text`, precomputed. */
	width: number
	/** Original inputs, present only on segments that participate in the
	 *  UX-ladder compaction steps. Compact-form builders use these. */
	raw?: SegmentRaw
}

/** A single compaction action in the UX ladder. */
interface CompactionStep {
	/** Human label, used in tests/debug. */
	name: string
	/** Mutate the segment array in place. Returning `false` means "no-op";
	 *  the layout engine will move on to the next step. */
	apply(segments: Segment[], ctx: CompactionContext): boolean
}

/** Context passed to compaction steps so they can rebuild colorized text. */
interface CompactionContext {
	/** Theme accessors so steps can rebuild colorized text when shortening. */
	dim: (s: string) => string
	accent: (s: string) => string
	/** Apply a named semantic color (e.g. "error", "warning") to a string. */
	semantic: (color: string, s: string) => string
	/** Set to `false` once the command hint should no longer be appended. */
	showCommandHint: boolean
}

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

export function readStatusLineCommand(): string | null {
	try {
		const raw = readFileSync(HARNESS_SETTINGS_PATH, "utf-8")
		const parsed = JSON.parse(raw)
		const cmd = parsed?.statusLine?.command
		if (typeof cmd !== "string" || cmd.length === 0) return null
		if (cmd.startsWith("~/")) return resolve(homedir(), cmd.slice(2))
		return cmd
	} catch {
		return null
	}
}

export function buildScriptPayload(
	ctx: ExtensionContext,
	status: "idle" | "generating",
	sessionStartMs: number,
	linesAdded: number,
	linesRemoved: number,
) {
	const usage = ctx.getContextUsage()

	let costUsd = 0
	let totalInput = 0
	let totalOutput = 0
	let lastTurn: { input: number; output: number } | null = null
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = (entry.message as AssistantMessage).usage
			costUsd += u.cost.total
			totalInput += u.input
			totalOutput += u.output
			lastTurn = { input: u.input, output: u.output }
		}
	}

	return {
		// kimchi fields
		model: { id: ctx.model?.id ?? null, name: ctx.model?.name ?? null },
		context: {
			used: usage?.tokens ?? null,
			limit: usage?.contextWindow ?? null,
			percent: usage?.percent ?? null,
		},
		workspace: { cwd: ctx.cwd, current_dir: ctx.cwd },
		status,
		session: {
			cost_usd: costUsd,
			last_turn: lastTurn,
			id: ctx.sessionManager.getSessionId(),
			name: ctx.sessionManager.getSessionName() ?? null,
			transcript_path: ctx.sessionManager.getSessionFile(),
		},
		// claude code compat fields
		cost: {
			total_cost_usd: costUsd,
			total_duration_ms: Date.now() - sessionStartMs,
			total_lines_added: linesAdded,
			total_lines_removed: linesRemoved,
		},
		context_window: {
			context_window_size: usage?.contextWindow ?? null,
			used_percentage: usage?.percent ?? null,
			remaining_percentage: usage?.percent != null ? 100 - usage.percent : null,
			current_usage: usage?.tokens != null ? { input_tokens: usage.tokens } : null,
			total_input_tokens: totalInput,
			total_output_tokens: totalOutput,
		},
		exceeds_200k_tokens: (usage?.tokens ?? 0) > 200_000,
		permissions: {
			mode: getCurrentPermissionsMode(),
		},
		multi_model: {
			enabled: getMultiModelEnabled(),
		},
		phase: getCurrentPhase(),
	}
}

export class ScriptFooter implements Component {
	private cachedLines: string[] = []

	constructor(private getControlsLine: () => string | null) {}

	setLines(lines: string[]): void {
		this.cachedLines = lines
	}

	invalidate(): void {}

	render(width: number): string[] {
		const controls = this.getControlsLine()
		const scriptLines = this.cachedLines.map((line) => truncateToWidth(line, width))
		if (!controls) return scriptLines
		return [...scriptLines, "", truncateToWidth(controls, width)]
	}
}

const BAR_WIDTH = 16

/** Compact form builders */

/** Compact form for the context segment: drops the bar, keeps `N% ctx`. */
export function buildContextCompact(ctx: CompactionContext, percent: number, pctColor?: "error" | "warning"): Segment {
	const pctStr = pctColor ? ctx.semantic(pctColor, `${Math.round(percent)}%`) : ctx.accent(`${Math.round(percent)}%`)
	const ctxStr = ctx.dim("ctx")
	const text = `${pctStr} ${ctxStr}`
	return {
		id: "context",
		text,
		width: visibleWidth(text),
		raw: { kind: "context", percent, pctColor },
	}
}

/** Compact form for multi-model: replaces "multi-model:" with "m-m:". */
export function buildMultiModelAbbrev(ctx: CompactionContext, enabled: boolean): Segment {
	const label = enabled ? ctx.accent("on") : ctx.dim("off")
	const shortcut = MULTI_MODEL_SHORTCUT
	const text = `${ctx.dim("m-m:")} ${label} ${ctx.dim(`→ ${shortcut}`)}`
	return {
		id: "multi-model",
		text,
		width: visibleWidth(text),
		raw: { kind: "multi-model", enabled },
	}
}

/** Compact form for phase: drops the "phase:" prefix, keeps just the value. */
export function buildPhaseCompact(ctx: CompactionContext, phase: string): Segment {
	const text = ctx.accent(phase)
	return {
		id: "phase",
		text,
		width: visibleWidth(text),
		raw: { kind: "phase", phase },
	}
}

/** Compaction action for ferment: drop the leading colorized `ferment:`
 *  substring in place. The rest of the segment is unchanged, so no rebuild. */
function dropFermentPrefix(segs: Segment[]): boolean {
	const idx = segs.findIndex((s) => s.id === "ferment")
	if (idx === -1) return false
	const seg = segs[idx]
	if (seg.raw?.kind !== "ferment") return false
	if (!seg.text.startsWith(seg.raw.prefix)) return false
	const newText = seg.text.slice(seg.raw.prefix.length)
	segs[idx] = { id: seg.id, text: newText, width: seg.width - seg.raw.prefixWidth }
	return true
}

/** Regex to strip trailing shortcut hints like "→ shift+tab" or "→ option+tab"
 *  from segments that have them. Matches the dim/text colored shortcut at the end. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are required for matching real terminal output
export const SHORTCUT_TAIL = /\s*\x1b\[[\d;]*m\s*→\s+[\w+]+\x1b\[[\d;]*m\s*$/

/** Strip shortcut hints from the named segments. Returns true if any were stripped. */
function stripShortcutHintsAcross(segments: Segment[], ids: SegmentId[]): boolean {
	let changed = false
	for (const id of ids) {
		const i = segments.findIndex((s) => s.id === id)
		if (i === -1) continue
		const stripped = segments[i].text.replace(SHORTCUT_TAIL, "")
		if (stripped !== segments[i].text) {
			segments[i] = { id, text: stripped, width: visibleWidth(stripped) }
			changed = true
		}
	}
	return changed
}

/** Replace a segment by ID with a new Segment (or null to skip). Returns true if changed. */
function replaceSegment(segs: Segment[], id: SegmentId, next: Segment | null): boolean {
	const i = segs.findIndex((s) => s.id === id)
	if (i === -1 || !next) return false
	if (segs[i].text === next.text) return false
	segs[i] = next
	return true
}

/** Helper for compaction steps: rebuild a segment in place from its raw inputs.
 *  Type-safe: only matches segments whose `raw.kind` equals the requested kind. */
function recompactSegment<K extends SegmentRaw["kind"]>(
	segs: Segment[],
	id: SegmentId,
	kind: K,
	builder: (raw: Extract<SegmentRaw, { kind: K }>) => Segment,
): boolean {
	const seg = segs.find((s) => s.id === id)
	if (!seg || seg.raw?.kind !== kind) return false
	return replaceSegment(segs, id, builder(seg.raw as Extract<SegmentRaw, { kind: K }>))
}

/** The ordered compaction steps */
const STEPS: CompactionStep[] = [
	{
		name: "drop-command-hint",
		apply: (_segs, ctx) => {
			if (!ctx.showCommandHint) return false
			ctx.showCommandHint = false
			return true
		},
	},
	{
		name: "drop-context-bar",
		apply: (segs, ctx) =>
			recompactSegment(segs, "context", "context", (raw) => buildContextCompact(ctx, raw.percent, raw.pctColor)),
	},
	{
		name: "abbrev-multi-model-label",
		apply: (segs, ctx) =>
			recompactSegment(segs, "multi-model", "multi-model", (raw) => buildMultiModelAbbrev(ctx, raw.enabled)),
	},
	{
		name: "drop-shortcut-hints",
		apply: (segs) => stripShortcutHintsAcross(segs, ["permissions", "multi-model"]),
	},
	{
		name: "drop-phase-prefix",
		apply: (segs, ctx) => recompactSegment(segs, "phase", "phase", (raw) => buildPhaseCompact(ctx, raw.phase)),
	},
	{
		name: "drop-ferment-prefix",
		apply: (segs) => dropFermentPrefix(segs),
	},
]

/** Render a line from segments, separator, and optional command hint. */
function renderLine(
	segments: Segment[],
	ctx: CompactionContext,
	sep: string,
	sepWidth: number,
	commandHint: { text: string; width: number },
	width: number,
): { text: string; width: number } {
	if (segments.length === 0) {
		return { text: "", width: 0 }
	}

	const joinedText = segments.map((s) => s.text).join(sep)
	const joinedWidth = segments.reduce((sum, s) => sum + s.width, 0) + (segments.length - 1) * sepWidth

	// Try to fit command hint if requested
	if (ctx.showCommandHint && joinedWidth + 2 + commandHint.width <= width) {
		const padding = width - joinedWidth - commandHint.width
		return {
			text: `${joinedText}${" ".repeat(padding)}${commandHint.text}`,
			width, // text fills exactly `width` columns
		}
	}

	return { text: joinedText, width: joinedWidth }
}

/** Main layout function — applies compaction steps in order, then truncates if
 *  the fully-compacted line still doesn't fit. We deliberately do not shed
 *  whole segments: disappearing elements look worse than a clean tail truncation. */
function layoutFooter(
	segments: Segment[],
	width: number,
	ctx: CompactionContext,
	sep: string,
	sepWidth: number,
	commandHint: { text: string; width: number },
): string {
	// Initial attempt with no compaction.
	let line = renderLine(segments, ctx, sep, sepWidth, commandHint, width)
	if (line.width <= width) return line.text

	// Apply each compaction step in order, re-rendering and stopping the first time we fit.
	for (const step of STEPS) {
		step.apply(segments, ctx)
		line = renderLine(segments, ctx, sep, sepWidth, commandHint, width)
		if (line.width <= width) return line.text
	}

	// Fully compacted line still overflows — truncate the tail.
	return truncateToWidth(line.text, width)
}

export class StatsFooter implements Component {
	constructor(
		private ctx: ExtensionContext,
		private theme: Theme,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	invalidate(): void {}

	private dim(s: string): string {
		return this.theme.fg("dim", s)
	}

	private accent(s: string): string {
		const ansi = resolvedAccentFg(this.theme)
		return `${ansi}${s}${RST_FG}`
	}

	private modelSegment(): Segment {
		const modelId = this.ctx.model?.id ?? "n/a"
		const text = this.accent(modelId)
		return { id: "model", text, width: visibleWidth(text) }
	}

	private usageSegment(): Segment | null {
		let totalInput = 0
		let totalOutput = 0
		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type === "message") {
				const msg = entry.message
				if (msg?.role === "assistant" && msg.usage) {
					totalInput += msg.usage.input ?? 0
					totalOutput += msg.usage.output ?? 0
				}
			}
		}
		if (!totalInput && !totalOutput) return null
		const tokens = [totalInput ? `↑${formatCount(totalInput)}` : "", totalOutput ? `↓${formatCount(totalOutput)}` : ""]
			.filter(Boolean)
			.join(" ")
		return { id: "usage", text: this.dim(tokens), width: visibleWidth(tokens) }
	}

	private contextSegment(): Segment {
		const contextUsage = this.ctx.getContextUsage()
		const pct = contextUsage?.percent ?? 0

		const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)))
		const fill = resolvedSemanticFg(this.theme, "success")
		const bar = `${fill}${"█".repeat(filled)}${RST_FG}${this.dim("░".repeat(BAR_WIDTH - filled))}`
		const pctColor = pct > 90 ? "error" : pct > 70 ? "warning" : undefined
		const pctStr = pctColor
			? `${resolvedSemanticFg(this.theme, pctColor)}${Math.round(pct)}%${RST_FG}`
			: this.accent(`${Math.round(pct)}%`)
		const text = `${bar} ${pctStr} ${this.dim("ctx")}`
		return { id: "context", text, width: visibleWidth(text), raw: { kind: "context", percent: pct, pctColor } }
	}

	private phaseSegment(): Segment {
		const phase = getCurrentPhase() ?? "n/a"
		const text = `${this.dim("phase:")}${this.accent(phase)}`
		return { id: "phase", text, width: visibleWidth(text), raw: { kind: "phase", phase } }
	}

	private tagsSegment(parsed: Array<{ key: string; value: string }>): Segment | null {
		const display = parsed.filter((t) => t.key !== "team" && t.key !== "phase")
		if (display.length === 0) return null
		const formatted = display.map((t) => this.dim(`${t.key}:${t.value}`)).join(this.dim(" "))
		const text = `${this.dim("tags:")}${formatted}`
		return { id: "tags", text, width: visibleWidth(text) }
	}

	private teamSegment(parsed: Array<{ key: string; value: string }>): Segment | null {
		const team = parsed.find((t) => t.key === "team")
		if (!team) return null
		const text = `${this.dim("team:")}${this.accent(team.value)}`
		return { id: "team", text, width: visibleWidth(text) }
	}

	private permissionsSegment(): Segment | null {
		const mode = this.footerData.getExtensionStatuses().get("permissions-mode")
		if (!mode) return null
		return { id: "permissions", text: mode, width: visibleWidth(mode) }
	}

	private multiModelSegment(): Segment {
		const enabled = getMultiModelEnabled()
		const label = enabled ? this.accent("on") : this.dim("off")
		const shortcut = MULTI_MODEL_SHORTCUT
		const text = `${this.dim("multi-model:")} ${label} ${this.dim(`→ ${shortcut}`)}`
		return { id: "multi-model", text, width: visibleWidth(text), raw: { kind: "multi-model", enabled } }
	}

	private subagentSegment(): Segment | null {
		const count = getActiveAgentCount()
		if (count === 0) return null
		const text = this.accent(`${count} agent${count === 1 ? "" : "s"}`)
		return { id: "agents", text, width: visibleWidth(text) }
	}

	private fermentSegment(): Segment | null {
		const ferment = getActiveFerment()
		if (!ferment) return null
		const phaseIdx = getCurrentPhaseIndex()
		const totalPhases = ferment.phases.length
		const activePhase = ferment.activePhaseId ? ferment.phases.find((p) => p.id === ferment.activePhaseId) : undefined
		const activeStep = activePhase?.steps.find(
			(s) => s.status === "running" || s.status === "pending" || s.status === "failed",
		)

		// Capture the colorized `ferment:` prefix so the compaction step can
		// slice it off in place. `visibleWidth("ferment:")` is 8 (ASCII).
		const prefix = this.dim("ferment:")
		const PREFIX_WIDTH = visibleWidth(prefix)

		const parts: string[] = [`${prefix}${this.accent(ferment.name)}`]
		parts.push(this.dim(`[${ferment.status}]`))
		parts.push(this.dim(ferment.mode))

		if (phaseIdx !== undefined && totalPhases > 0) {
			const phaseName = activePhase?.name ?? ""
			const phaseInfo = phaseName ? ` "${phaseName}"` : ""
			parts.push(this.dim(`· phase ${phaseIdx}/${totalPhases}${phaseInfo}`))
		}
		if (activeStep && activePhase) {
			parts.push(this.dim(`· step ${activeStep.index}/${activePhase.steps.length}`))
		}

		const text = parts.join(" ")
		return {
			id: "ferment",
			text,
			width: visibleWidth(text),
			raw: { kind: "ferment", prefix, prefixWidth: PREFIX_WIDTH },
		}
	}

	private permissionsWarning(): string | null {
		const text = this.footerData.getExtensionStatuses().get("permissions-warning")
		if (!text) return null
		return this.theme.fg("warning", text)
	}

	private updateAvailableSegment(): { text: string; width: number } | null {
		// Info-line segment (rendered above the status line), NOT one of the
		// status-line `Segment`s above — it has no SegmentId because it never
		// participates in compaction.
		const text = this.footerData.getExtensionStatuses().get("update-available")
		if (!text) return null
		const segText = this.theme.fg("accent", text)
		return { text: segText, width: visibleWidth(text) }
	}

	render(width: number): string[] {
		const tags = getActiveTags()
			.map(parseTag)
			.filter((t): t is { key: string; value: string } => t !== null)

		const segments: Segment[] = [
			this.permissionsSegment(),
			this.multiModelSegment(),
			this.modelSegment(),
			this.fermentSegment(),
			this.subagentSegment(),
			this.contextSegment(),
			this.usageSegment(),
			this.phaseSegment(),
			this.tagsSegment(tags),
			this.teamSegment(tags),
		].filter((s): s is Segment => s !== null)

		const sep = ` ${this.dim("·")} `
		const sepWidth = visibleWidth(sep)

		const hintText = this.dim("/ for commands")
		const hintWidth = visibleWidth(hintText)

		const ctx: CompactionContext = {
			dim: (s) => this.dim(s),
			accent: (s) => this.accent(s),
			semantic: (color, s) =>
				`${resolvedSemanticFg(this.theme, color as "success" | "warning" | "error")}${s}${RST_FG}`,
			showCommandHint: true,
		}

		const line = layoutFooter(segments, width, ctx, sep, sepWidth, { text: hintText, width: hintWidth })

		const infoLine = this.buildInfoLine(width)
		return infoLine ? [infoLine, line] : [line]
	}

	private buildInfoLine(width: number): string {
		let line = ""
		const permissionsWarningText = this.permissionsWarning()
		const updateSeg = this.updateAvailableSegment()

		let remainingWidth = width
		if (permissionsWarningText) {
			line = truncateToWidth(permissionsWarningText, remainingWidth)
			remainingWidth -= visibleWidth(line)
		}

		if (updateSeg && remainingWidth >= updateSeg.width + 2) {
			line = `${line}${" ".repeat(remainingWidth - updateSeg.width)}${updateSeg.text}`
		}

		return line
	}
}
