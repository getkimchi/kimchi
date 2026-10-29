/**
 * Curated-aware thinking-level selection: the single source of truth for
 * which thinking levels are selectable for a model, shared by the status
 * line (`components/status-line.ts`) and the patched dist selector
 * (`/thinking`) through a process-global advisor hook.
 *
 * Selectability rule (user-confirmed): curated levels ∩ pi's map-supported
 * set. The thinkingLevelMap is the wire-format truth — a level the map
 * rejects (mapped to null, or xhigh/max without an explicit entry) cannot be
 * sent, so curating it must not make it selectable. Uncurated models
 * (registry miss) keep pi's computed set. Models with no selectable levels
 * (non-reasoning, the curated empty array, or an empty intersection) carry a
 * reason the selector surfaces as its info line and the status line renders
 * as `on` (reasoning at the provider default) or `off` (no reasoning).
 *
 * Kept in its own module — not `thinking-levels.ts` — to avoid an import
 * cycle: `models.ts` (registry) already imports from `thinking-levels.ts`.
 */
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import { getModelThinkingLevels } from "./models.js"
import { CANONICAL_THINKING_LEVELS } from "./thinking-levels.js"

/** Why nothing is selectable for a model. */
export type ThinkingNoneReason = "no-reasoning" | "curated-none" | "empty-intersection"

export type ThinkingSelection =
	| { mode: "levels"; selectable: string[] }
	| { mode: "none"; reasoning: boolean; noneReason: ThinkingNoneReason }

/** Structural subset of pi's Model that selection reads. The dist advisor
 * receives untyped session models; kimchi call sites pass real Models. */
export interface ThinkingSelectionModel {
	provider: string
	id: string
	reasoning?: boolean
	thinkingLevelMap?: ThinkingLevelMap
}

/**
 * Selectable thinking levels for a model.
 *
 * - no model → all canonical levels (pi's THINKING_LEVEL_OPTIONS fallback);
 * - non-reasoning → none, `reasoning: false`;
 * - curated `[]` → none, `reasoning: true` (thinking exists, no distinct
 *   levels — the provider default applies);
 * - curated populated → curated ∩ pi-supported; an empty intersection
 *   degrades to none (curation and the wire format disagree entirely);
 * - uncurated → pi's computed set (no curation-based restriction).
 */
export function thinkingSelection(model: ThinkingSelectionModel | undefined): ThinkingSelection {
	if (!model) return { mode: "levels", selectable: [...CANONICAL_THINKING_LEVELS] }
	if (!model.reasoning) return { mode: "none", reasoning: false, noneReason: "no-reasoning" }
	const curated = getModelThinkingLevels(`${model.provider}/${model.id}`)
	if (curated === undefined) return { mode: "levels", selectable: getSupportedThinkingLevels(model as Model<Api>) }
	if (curated.length === 0) return { mode: "none", reasoning: true, noneReason: "curated-none" }
	const piSupported = new Set<string>(getSupportedThinkingLevels(model as Model<Api>))
	const selectable = curated.filter((level) => piSupported.has(level))
	if (selectable.length === 0) return { mode: "none", reasoning: true, noneReason: "empty-intersection" }
	return { mode: "levels", selectable }
}

const LEVEL_RANK = new Map<string, number>(CANONICAL_THINKING_LEVELS.map((level, rank) => [level, rank]))

/**
 * Rank-nearest selectable level, mirroring pi-ai's clampThinkingLevel search
 * strategy (upward from the requested rank first, then downward). Models with
 * nothing selectable clamp to "off" — the session then carries no explicit
 * effort, so the provider default applies on the wire (the status line
 * renders `on`/`off` from the selection mode, not from this value).
 */
export function clampToSelection(level: string, selection: ThinkingSelection): string {
	if (selection.mode !== "levels" || selection.selectable.length === 0) return "off"
	if (selection.selectable.includes(level)) return level
	const requested = LEVEL_RANK.get(level)
	if (requested === undefined) return selection.selectable[0]
	for (let i = requested; i < CANONICAL_THINKING_LEVELS.length; i++) {
		const candidate = CANONICAL_THINKING_LEVELS[i]
		if (selection.selectable.includes(candidate)) return candidate
	}
	for (let i = requested - 1; i >= 0; i--) {
		const candidate = CANONICAL_THINKING_LEVELS[i]
		if (selection.selectable.includes(candidate)) return candidate
	}
	return selection.selectable[0]
}

/** Info the patched dist consumes via the process-global advisor hook. */
export interface KimchiThinkingLevelInfo {
	/** All canonical levels in rank order, flagged by selectability — the
	 *  selector renders them all, greying the non-selectable ones. */
	levels: ReadonlyArray<{ level: string; selectable: boolean }>
	/** Selectable levels in rank order. */
	selectable: string[]
	/** Why nothing is selectable; null when at least one level is. */
	noneReason: ThinkingNoneReason | null
	/** Rank-nearest selectable level; "off" when nothing is selectable, so
	 *  no explicit effort is derived for the request. */
	clamp: (level: string) => string
}

/** Dist seam: `(model) => info | null`. Null makes the dist fall back to its
 *  own behavior (pure-pi sessions, adversarial input, internal failure). */
export type KimchiThinkingLevelAdvisor = (model: unknown) => KimchiThinkingLevelInfo | null

function isSelectionModel(value: unknown): value is ThinkingSelectionModel {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { id?: unknown }).id === "string" &&
		typeof (value as { provider?: unknown }).provider === "string"
	)
}

/** The patched dependency cannot import harness source; this adapter is
 *  loaded by the CLI, mirroring installModelTableRenderer. */
export function installThinkingLevelAdvisor(): void {
	const globals = process as typeof process & { __kimchiThinkingLevelAdvisor?: KimchiThinkingLevelAdvisor }
	globals.__kimchiThinkingLevelAdvisor = (model) => {
		// Never throw into the dist: the patched call sites treat null as
		// "fall back to pure-pi behavior", so an internal failure degrades
		// to no curation rather than crashing setThinkingLevel / cycling /
		// completions / session creation.
		try {
			if (!isSelectionModel(model)) return null
			const selection = thinkingSelection(model)
			const selectable = selection.mode === "levels" ? selection.selectable : []
			const selectableSet = new Set(selectable)
			return {
				levels: CANONICAL_THINKING_LEVELS.map((level) => ({ level, selectable: selectableSet.has(level) })),
				selectable,
				noneReason: selection.mode === "none" ? selection.noneReason : null,
				clamp: (level: string) => clampToSelection(level, selection),
			}
		} catch {
			return null
		}
	}
}

/** @internal — test hook removing the process-global advisor. */
export function __uninstallThinkingLevelAdvisorForTest(): void {
	;(
		process as typeof process & { __kimchiThinkingLevelAdvisor?: KimchiThinkingLevelAdvisor | undefined }
	).__kimchiThinkingLevelAdvisor = undefined
}
