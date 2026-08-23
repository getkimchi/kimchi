import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { RST_FG, resolvedAccentFg, resolvedSemanticFg } from "../ansi.js"
import { readStatusLineConfig } from "../config/status-line-config.js"
import { getActiveAgentCount } from "../extensions/agents/index.js"
import { getBillingStatusLine } from "../extensions/billing/status.js"
import { formatBudgetStatusLine, formatCreditsStatusLine } from "../extensions/billing/status-line-format.js"
import { getActiveFerment, getFermentContinuationPolicy } from "../extensions/ferment/index.js"
import { formatFermentStatusLineDisplay } from "../extensions/ferment/status-line.js"
import { formatCount } from "../extensions/format.js"
import { getMultiModelEnabled } from "../extensions/multi-model.js"
import { getPermissionMode } from "../extensions/permissions/mode-controller.js"
import { getActiveTags, getCurrentPhase, parseTag } from "../extensions/tags.js"

/** Stable identifier used by compaction steps to find segments. */
export type SegmentId =
	| "permissions"
	| "model"
	| "ferment"
	| "agents"
	| "context"
	| "usage"
	| "phase"
	| "tags"
	| "team"
	| "credits"
	| "budget"
	| "lsp"

/** Raw inputs preserved on segments that have compact forms, so compaction
 *  steps can rebuild the colorized text without round-tripping through ANSI.
 *
 *  `ferment` is the odd one out: instead of storing inputs and rebuilding the
 *  whole segment, it just stashes the leading colorized `Ferment: ` substring
 *  so the compaction step can slice it off in place. Cheaper than a rebuild
 *  and the segment's tail is identical in both forms anyway. */
type SegmentRaw =
	| { kind: "context"; percent: number; pctColor?: "error" | "warning" }
	| { kind: "model"; multiModel: boolean; modelId: string }
	| { kind: "phase"; phase: string }
	| { kind: "budget"; percentage: string }
	| { kind: "ferment"; prefix: string; prefixWidth: number }

/** A single piece of the status line. */
export interface Segment {
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
	const sessionId = ctx.sessionManager.getSessionId()
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
	const billing = getBillingStatusLine()

	return {
		// kimchi fields
		model: { id: ctx.model?.id ?? null, name: ctx.model?.name ?? null },
		context: {
			used: usage?.tokens ?? null,
			limit: usage?.contextWindow ?? null,
			percent: usage?.percent ?? null,
		},
		credits: billing?.amount ?? null,
		budget: billing?.budget ?? null,
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
			mode: getPermissionMode(sessionId),
		},
		multi_model: {
			enabled: getMultiModelEnabled(ctx.sessionManager),
		},
		phase: getCurrentPhase(sessionId),
	}
}

export class StatusLineScript implements Component {
	private cachedLines: string[] = []

	constructor(private getControlsLine: (width: number) => string | null) {}

	setLines(lines: string[]): void {
		this.cachedLines = lines
	}

	invalidate(): void {}

	render(width: number): string[] {
		const scriptLines = this.cachedLines.map((line) => truncateToWidth(line, width))
		// The callback returns an already-fitted line (compaction ladder →
		// priority shed → truncation applied inside), so no extra work here.
		const controls = this.getControlsLine(width)
		if (!controls) return scriptLines
		return [...scriptLines, "", controls]
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

/** Compact form for model: abbreviates "multi-model (kimi-k2.6)" to "m-m (kimi-k2.6)". */
export function buildModelAbbrev(ctx: CompactionContext, multiModel: boolean, modelId: string): Segment {
	const label = multiModel ? `m-m (${modelId})` : modelId
	const text = `${ctx.accent(label)} ${ctx.dim("→ ctrl+p")}`
	return {
		id: "model",
		text,
		width: visibleWidth(text),
		raw: { kind: "model", multiModel, modelId },
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
			segments[i] = { ...segments[i], text: stripped, width: visibleWidth(stripped) }
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
		name: "drop-context-bar",
		apply: (segs, ctx) =>
			recompactSegment(segs, "context", "context", (raw) => buildContextCompact(ctx, raw.percent, raw.pctColor)),
	},
	{
		name: "abbrev-model-label",
		apply: (segs, ctx) =>
			recompactSegment(segs, "model", "model", (raw) => buildModelAbbrev(ctx, raw.multiModel, raw.modelId)),
	},
	{
		name: "drop-shortcut-hints",
		apply: (segs) => stripShortcutHintsAcross(segs, ["permissions", "model", "ferment"]),
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

/** Visible width of the line a segment array would render to. */
function segmentsLineWidth(segments: Segment[], sepWidth: number): number {
	if (segments.length === 0) return 0
	return segments.reduce((sum, s) => sum + s.width, 0) + (segments.length - 1) * sepWidth
}

function joinSegments(segments: Segment[], sep: string): string {
	return segments.map((s) => s.text).join(sep)
}

/** Whole-segment shedding order, applied after the compaction ladder when the
 *  line still doesn't fit. Segments earlier in this list disappear first.
 *
 *  The core three — permissions, model, context — are deliberately NOT in this
 *  list: they are the modes the user changes most frequently and must survive
 *  any terminal width. Compaction still shrinks them (context bar → `N% ctx`,
 *  shortcut hints stripped); only outright removal is off the table.
 *
 *  This order is hardcoded and beats user pinning: a pinned segment is a
 *  display preference, not a survival guarantee. */
const SHED_ORDER: SegmentId[] = ["lsp", "team", "tags", "phase", "usage", "agents", "credits", "budget", "ferment"]

/** Fit segments into `width` columns: run the compaction ladder, then shed
 *  whole segments in SHED_ORDER until the line fits. The input `segments`
 *  array and the segment objects themselves are not mutated — a shallow copy
 *  of each segment is compacted/shed internally. Returns the surviving
 *  segments; if only core segments remain and still overflow, the caller is
 *  responsible for tail-truncating the rendered line. */
export function fitSegments(
	segments: Segment[],
	width: number,
	ctx: CompactionContext,
	sepWidth: number,
	extraSteps: CompactionStep[] = [],
): Segment[] {
	const working = segments.map((s) => ({ ...s }))
	const fits = () => segmentsLineWidth(working, sepWidth) <= width

	if (fits()) return working

	for (const step of [...STEPS, ...extraSteps]) {
		step.apply(working, ctx)
		if (fits()) return working
	}

	for (const id of SHED_ORDER) {
		const i = working.findIndex((s) => s.id === id)
		if (i === -1) continue
		working.splice(i, 1)
		if (fits()) return working
	}

	return working
}

// ── Segment construction (shared by StatusLine and the script controls line) ─

function dimText(theme: Theme, s: string): string {
	return theme.fg("dim", s)
}

function accentText(theme: Theme, s: string): string {
	return `${resolvedAccentFg(theme)}${s}${RST_FG}`
}

function semanticText(theme: Theme, color: "success" | "warning" | "error", s: string): string {
	return `${resolvedSemanticFg(theme, color)}${s}${RST_FG}`
}

export function buildCompactionContext(theme: Theme): CompactionContext {
	return {
		dim: (s) => dimText(theme, s),
		accent: (s) => accentText(theme, s),
		semantic: (color, s) => semanticText(theme, color as "success" | "warning" | "error", s),
	}
}

/** `abbrev-budget` needs the theme (via `formatBudgetStatusLine`), which
 *  CompactionContext doesn't carry — so it can't live in the STEPS array. */
function buildAbbrevBudgetStep(theme: Theme): CompactionStep {
	return {
		name: "abbrev-budget",
		apply: (segs) =>
			recompactSegment(segs, "budget", "budget", (raw) => {
				const text = formatBudgetStatusLine(raw.percentage, theme)
				return { id: "budget", text, width: visibleWidth(text), raw }
			}),
	}
}

/** Fit segments into `width` (compaction ladder → priority shed), join them
 *  into one line, and tail-truncate if even the core survivors overflow.
 *  Shared fitting logic for any line built from status-line segments. */
export function renderFittedLine(segments: Segment[], width: number, theme: Theme): string {
	const sep = ` ${dimText(theme, "·")} `
	const survivors = fitWithBudgetStep(segments, width, theme)
	return truncateToWidth(joinSegments(survivors, sep), width)
}

/** Fit segments using the full pipeline. Encapsulates the budget abbreviation
 *  step so callers don't repeat the same `fitSegments` invocation shape. */
function fitWithBudgetStep(segments: Segment[], width: number, theme: Theme): Segment[] {
	const sep = ` ${dimText(theme, "·")} `
	return fitSegments(segments, width, buildCompactionContext(theme), visibleWidth(sep), [buildAbbrevBudgetStep(theme)])
}

function buildModelSegment(ctx: ExtensionContext, theme: Theme): Segment {
	const multiModel = getMultiModelEnabled(ctx.sessionManager)
	const rawModelId = ctx.model?.id ?? "n/a"
	const label = multiModel ? `multi-model (${rawModelId})` : rawModelId
	const text = `${accentText(theme, label)} ${dimText(theme, "→ ctrl+p")}`
	return { id: "model", text, width: visibleWidth(text), raw: { kind: "model", multiModel, modelId: rawModelId } }
}

function buildUsageSegment(ctx: ExtensionContext, theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	let totalInput = 0
	let totalOutput = 0
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msg = entry.message
			if (msg?.role === "assistant" && msg.usage) {
				totalInput += msg.usage.input ?? 0
				totalOutput += msg.usage.output ?? 0
			}
		}
	}
	if (!totalInput && !totalOutput) {
		const text = dimText(theme, "↑0 ↓0")
		return { id: "usage", text, width: visibleWidth(text) }
	}
	const tokens = [totalInput ? `↑${formatCount(totalInput)}` : "", totalOutput ? `↓${formatCount(totalOutput)}` : ""]
		.filter(Boolean)
		.join(" ")
	return { id: "usage", text: dimText(theme, tokens), width: visibleWidth(tokens) }
}

function buildContextSegment(ctx: ExtensionContext, theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	const contextUsage = ctx.getContextUsage()
	const pct = contextUsage?.percent ?? 0

	if (pct === 0) {
		const bar = dimText(theme, "░".repeat(BAR_WIDTH))
		const text = `${bar} ${accentText(theme, "0%")} ${dimText(theme, "ctx")}`
		return {
			id: "context",
			text,
			width: visibleWidth(text),
			raw: { kind: "context", percent: 0, pctColor: undefined },
		}
	}

	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)))
	const bar = `${semanticText(theme, "success", "█".repeat(filled))}${dimText(theme, "░".repeat(BAR_WIDTH - filled))}`
	const pctColor = pct > 90 ? "error" : pct > 70 ? "warning" : undefined
	const pctStr = pctColor
		? semanticText(theme, pctColor, `${Math.round(pct)}%`)
		: accentText(theme, `${Math.round(pct)}%`)
	const text = `${bar} ${pctStr} ${dimText(theme, "ctx")}`
	return { id: "context", text, width: visibleWidth(text), raw: { kind: "context", percent: pct, pctColor } }
}

function buildPhaseSegment(ctx: ExtensionContext, theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	const phase = getCurrentPhase(ctx.sessionManager.getSessionId())
	if (!phase) {
		const text = `${dimText(theme, "phase:")}${dimText(theme, "—")}`
		return { id: "phase", text, width: visibleWidth(text), raw: { kind: "phase", phase: "—" } }
	}
	const text = `${dimText(theme, "phase:")}${accentText(theme, phase)}`
	return { id: "phase", text, width: visibleWidth(text), raw: { kind: "phase", phase } }
}

type ParsedTag = { key: string; value: string }

function buildTagsSegment(theme: Theme, parsed: ParsedTag[], pinned: boolean): Segment | null {
	if (!pinned) return null
	const display = parsed.filter((t) => t.key !== "team" && t.key !== "phase")
	if (display.length === 0) {
		const text = `${dimText(theme, "tags:")} ${dimText(theme, "—")}`
		return { id: "tags", text, width: visibleWidth(text) }
	}
	const formatted = display.map((t) => dimText(theme, `${t.key}:${t.value}`)).join(dimText(theme, " "))
	const text = `${dimText(theme, "tags:")}${formatted}`
	return { id: "tags", text, width: visibleWidth(text) }
}

function buildTeamSegment(theme: Theme, parsed: ParsedTag[], pinned: boolean): Segment | null {
	if (!pinned) return null
	const team = parsed.find((t) => t.key === "team")
	if (!team) {
		const text = `${dimText(theme, "team:")} ${dimText(theme, "—")}`
		return { id: "team", text, width: visibleWidth(text) }
	}
	const text = `${dimText(theme, "team:")}${accentText(theme, team.value)}`
	return { id: "team", text, width: visibleWidth(text) }
}

function buildPermissionsSegment(
	theme: Theme,
	statusLineData: ReadonlyFooterDataProvider,
	pinned: boolean,
): Segment | null {
	const mode = statusLineData.getExtensionStatuses().get("permissions-mode")
	if (!mode) {
		if (pinned) {
			const text = `${dimText(theme, "● ")}${dimText(theme, "— ")}${dimText(theme, "→ shift+tab")}`
			return { id: "permissions", text, width: visibleWidth(text) }
		}
		return null
	}
	return { id: "permissions", text: mode, width: visibleWidth(mode) }
}

function buildLspSegment(theme: Theme, statusLineData: ReadonlyFooterDataProvider): Segment | null {
	const lspStatus = statusLineData.getExtensionStatuses().get("lsp")
	if (!lspStatus) return null
	// Style "LSP:" as dimmed label, server names as accent. Preserve the
	// space after the colon so the label and value don't render run-together
	// (e.g. "LSP:typescript-language-server" instead of "LSP: typescript-language-server").
	const colonIdx = lspStatus.indexOf(":")
	if (colonIdx === -1) return { id: "lsp", text: accentText(theme, lspStatus), width: visibleWidth(lspStatus) }
	const label = dimText(theme, lspStatus.slice(0, colonIdx + 1))
	const value = lspStatus.slice(colonIdx + 1).trimStart()
	const text = value.length > 0 ? `${label} ${accentText(theme, value)}` : label
	return { id: "lsp", text, width: visibleWidth(text) }
}

function buildCreditsSegment(theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	const amount = getBillingStatusLine()?.amount
	if (!amount) return null
	const text = formatCreditsStatusLine(amount, theme)
	return { id: "credits", text, width: visibleWidth(text) }
}

function buildBudgetSegment(theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	const budget = getBillingStatusLine()?.budget
	if (!budget) return null
	const [percentage = budget] = budget.split(" ", 1)
	const text = formatBudgetStatusLine(budget, theme)
	return { id: "budget", text, width: visibleWidth(text), raw: { kind: "budget", percentage } }
}

function buildAgentsSegment(theme: Theme, pinned: boolean): Segment | null {
	if (!pinned) return null
	const count = getActiveAgentCount()
	if (count === 0) {
		const text = dimText(theme, "0 agents")
		return { id: "agents", text, width: visibleWidth(text) }
	}
	const text = accentText(theme, `${count} agent${count === 1 ? "" : "s"}`)
	return { id: "agents", text, width: visibleWidth(text) }
}

function buildFermentSegment(theme: Theme, pinned: boolean): Segment | null {
	const display = formatFermentStatusLineDisplay(getActiveFerment(), getFermentContinuationPolicy(), {
		dim: (s) => dimText(theme, s),
		accent: (s) => accentText(theme, s),
	})
	// No active ferment: only show the placeholder when the user has
	// explicitly pinned the segment (so they can see it's wired up but
	// idle). Unpinned, hide it entirely — "Ferment: —" is noise when no
	// ferment is running.
	if (!display) {
		if (!pinned) return null
		const text = `${dimText(theme, "Ferment:")} ${dimText(theme, "—")}`
		return { id: "ferment", text, width: visibleWidth(text) }
	}

	// Active ferment: always render, even when unpinned. The status line is
	// the primary surface for ferment progress and must not be hidden by
	// default. This matches the ScriptFooter path (ui.ts) which shows the
	// ferment segment unconditionally when there is one.
	return {
		id: "ferment",
		text: display.text,
		width: display.width,
		raw: { kind: "ferment", prefix: display.prefix, prefixWidth: display.prefixWidth },
	}
}

export interface StatusLineBuildContext {
	ctx: ExtensionContext
	theme: Theme
	statusLineData: ReadonlyFooterDataProvider
}

/** Build the full status-line segment pool in display order.
 *  Permissions and model ALWAYS lead — they are the modes the user changes
 *  most frequently, so no other segment (ferment name included) may push them
 *  off the left edge. Everything else follows. */
export function buildStatusLineSegments(
	{ ctx, theme, statusLineData }: StatusLineBuildContext,
	pinned: ReadonlySet<SegmentId>,
): Segment[] {
	const tags = getActiveTags(ctx.sessionManager)
		.map(parseTag)
		.filter((t): t is ParsedTag => t !== null)

	return [
		buildPermissionsSegment(theme, statusLineData, pinned.has("permissions")),
		buildModelSegment(ctx, theme),
		buildFermentSegment(theme, pinned.has("ferment")),
		buildCreditsSegment(theme, pinned.has("credits")),
		buildBudgetSegment(theme, pinned.has("budget")),
		buildAgentsSegment(theme, pinned.has("agents")),
		buildContextSegment(ctx, theme, pinned.has("context")),
		buildUsageSegment(ctx, theme, pinned.has("usage")),
		buildPhaseSegment(ctx, theme, pinned.has("phase")),
		buildTagsSegment(theme, tags, pinned.has("tags")),
		buildTeamSegment(theme, tags, pinned.has("team")),
		buildLspSegment(theme, statusLineData),
	].filter((s): s is Segment => s !== null)
}

/** Segments shown below a custom `statusLine.command` script's output
 *  (StatusLineScript's controls line). A subset of the full pool: the script
 *  usually covers context/usage itself, so the controls line carries
 *  permissions, model, ferment, and billing — in pool order so permissions
 *  and model lead — fitted through the same compaction/shed pipeline. */
const CONTROLS_LINE_IDS: ReadonlySet<SegmentId> = new Set(["permissions", "model", "ferment", "credits", "budget"])
const CONTROLS_LINE_PINNED: ReadonlySet<SegmentId> = new Set(["credits", "budget"])

export function buildControlsLineSegments(buildCtx: StatusLineBuildContext): Segment[] {
	return buildStatusLineSegments(buildCtx, CONTROLS_LINE_PINNED).filter((s) => CONTROLS_LINE_IDS.has(s.id))
}

export class StatusLine implements Component {
	constructor(
		private ctx: ExtensionContext,
		private theme: Theme,
		private statusLineData: ReadonlyFooterDataProvider,
	) {}

	invalidate(): void {}

	private dim(s: string): string {
		return dimText(this.theme, s)
	}

	private permissionsWarning(): string | null {
		const text = this.statusLineData.getExtensionStatuses().get("permissions-warning")
		if (!text) return null
		return this.theme.fg("warning", text)
	}

	private updateAvailableSegment(): { text: string; width: number } | null {
		// Info-line segment (rendered above the status line), NOT one of the
		// status-line `Segment`s above — it has no SegmentId because it never
		// participates in compaction.
		const text = this.statusLineData.getExtensionStatuses().get("update-available")
		if (!text) return null
		const segText = this.theme.fg("accent", text)
		return { text: segText, width: visibleWidth(text) }
	}

	render(width: number): string[] {
		const config = readStatusLineConfig()
		const pinnedSet = new Set<SegmentId>(config.pinned)
		const allSegments = buildStatusLineSegments(
			{ ctx: this.ctx, theme: this.theme, statusLineData: this.statusLineData },
			pinnedSet,
		)

		const sep = ` ${this.dim("·")} `

		const hintText = this.dim("/ for commands")
		const hintWidth = visibleWidth(hintText)

		// The hint always lives at the far right edge, independent of pinning.
		// Reserve its space upfront so compaction uses the right budget.
		const minHintGap = 2
		const hintReserve = hintWidth + minHintGap
		const contentBudget = Math.max(0, width - hintReserve)

		// Fit ALL segments as one pool against the full content budget. Pinned
		// segments get no upfront reservation: the hardcoded compaction/shedding
		// priority beats pinning, so a pinned low-priority segment sheds before
		// the core permissions/model/context trio is touched.
		const survivors = fitWithBudgetStep(allSegments, contentBudget, this.theme)

		// Core segments (permissions/model) must always lead the line, even if a
		// persisted config marks them as pinned. Pinning only affects display order
		// for non-core segments.
		const CORE_LEAD_IDS: Set<SegmentId> = new Set(["permissions", "model"])

		// Display order is unchanged: unpinned group left, pinned group right.
		const unpinned = survivors.filter((s) => !pinnedSet.has(s.id) || CORE_LEAD_IDS.has(s.id))
		const pinned = survivors.filter((s) => pinnedSet.has(s.id) && !CORE_LEAD_IDS.has(s.id))

		// Build content: unpinned (left) then pinned (right).
		let contentLine: string
		if (unpinned.length > 0 && pinned.length > 0) {
			contentLine = `${joinSegments(unpinned, sep)}${sep}${joinSegments(pinned, sep)}`
		} else if (pinned.length > 0) {
			contentLine = joinSegments(pinned, sep)
		} else {
			contentLine = joinSegments(unpinned, sep)
		}

		// Append hint at the far right when there is room; truncate if not.
		let line: string
		const contentWidth = visibleWidth(contentLine)
		if (contentWidth + minHintGap + hintWidth <= width) {
			const padding = width - contentWidth - hintWidth
			line = `${contentLine}${" ".repeat(padding)}${hintText}`
		} else {
			line = contentWidth > width ? truncateToWidth(contentLine, width) : contentLine
		}

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
