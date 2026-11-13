/**
 * Redaction policy: parse, validate, and resolve on/off states into an
 * executable redaction view (LLM-4416).
 *
 * The same policy shape is accepted from two sources:
 *
 *   - local settings.json `redaction` block:
 *       { "categories": { "network": "off" }, "entities": { "PHONE_NUMBER": "on" },
 *         "customEntities": [{ "name", "category", "pattern", "flags"?, "secretGroup"? }] }
 *     Local input is strict: an unknown category/entity or an invalid custom
 *     entity THROWS (fail-visible, same convention as excludedEntities).
 *
 *   - the org-managed platform policy (settings:resolve → `kimchiRedaction`):
 *     same JSON shape, with enum-style state values
 *     ("KIMCHI_REDACTION_STATE_ON"/"KIMCHI_REDACTION_STATE_OFF"). Managed
 *     input is tolerant: unknown categories, unknown entities, and invalid
 *     custom entries are DROPPED with one log line — a platform value the
 *     harness predates must never disable the pipeline.
 *
 * Resolution, per entity, first hit wins:
 *   managed.entities[E] → managed.categories[cat(E)] → local.entities[E] →
 *   local.categories[cat(E)] → registry default (getEntityDefaultOn).
 *
 * The legacy local `redaction.excludedEntities` list keeps its exact
 * pre-policy meaning on a separate path: it REPLACES the engine exclusion
 * list wholesale — including the ability to switch bare detectors back on,
 * which entity states deliberately cannot do for anchor-required entities.
 * Settings with both the legacy key and the new keys throw.
 *
 * Entity ON semantics:
 *   - checksum/anchored/bare_shape: removed from engine exclusions (bare
 *     shapes false-positive; the admin accepts that).
 *   - anchor_required: the engine bare detector STAYS excluded; ON means
 *     "the anchored custom patterns run" (the default). Entity OFF excludes
 *     the engine detector AND skips the kimchi/user custom patterns with
 *     the same name — including SECRET_FIELD's JSON-key force-redaction.
 * Names in PERMANENT_ENGINE_EXCLUSIONS are not configurable: no registry
 * entry, permanently suppressed engine-side.
 */

import {
	getDefaultExcludedEntities,
	getEntityCategory,
	getEntityTier,
	isKnownEntity,
	isRedactionCategory,
	listRedactionCatalog,
	PERMANENT_ENGINE_EXCLUSIONS,
	type RedactionCategory,
} from "./entity-tiers.js"

export type RedactionState = "on" | "off"

export interface CustomEntityDef {
	name: string
	category: RedactionCategory
	pattern: string
	flags?: string
	secretGroup?: number
}

export interface RedactionPolicy {
	categories?: Partial<Record<RedactionCategory, RedactionState>>
	entities?: Record<string, RedactionState>
	customEntities?: CustomEntityDef[]
}

/**
 * Local redaction input: either a modern policy or the legacy
 * excludedEntities list (carried as an object so the two paths cannot be
 * confused — legacy semantics are not expressible as entity states).
 */
export type LocalRedactionInput = RedactionPolicy | { legacyExcluded: string[] }

/** One executable redaction regex — built-in custom pattern or user-defined entity. */
export interface RedactionPattern {
	name: string
	regex: RegExp
	secretGroup?: number
}

export interface CompiledCustomEntity extends RedactionPattern {
	category: string
}

/**
 * The executable view one redaction pass runs against. Immutable once
 * resolved; the redactor rebuilds its snapshot when {@link signature}
 * changes.
 */
export interface ResolvedRedaction {
	/** Entities excluded at engine level (sorted). */
	engineExclusions: readonly string[]
	/**
	 * Entities whose non-engine coverage is suspended: custom-pattern passes
	 * with this name skip, and SECRET_FIELD JSON-key force-redaction stops.
	 */
	disabledEntities: ReadonlySet<string>
	/** Compiled user-defined patterns, appended after the built-in customs. */
	customPatterns: readonly CompiledCustomEntity[]
	/** Every universe entity → its category (registry ∪ custom definitions). */
	categories: ReadonlyMap<string, string>
	/** Stable string identifying this view; changes trigger an engine rebuild. */
	signature: string
}

// ---------------------------------------------------------------------------
// Validation limits (shared by local parse, managed parse, and the wire)
// ---------------------------------------------------------------------------

const CUSTOM_ENTITY_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/
const CUSTOM_ENTITY_FLAGS_RE = /^[imsu]{0,4}$/
const MAX_CUSTOM_ENTITIES = 50
const MAX_PATTERN_LENGTH = 512
/**
 * ReDoS gate: reject a quantified group whose BODY — including every
 * nested group — contains alternation or another quantifier (`(a|a)*`,
 * `(a|aa)+c`, `(a+)+`, `(\d{2,})*`, and nested wrappings like `((a)|(a))*`
 * or `(a|(b|a))*`). These shapes backtrack exponentially, and the
 * settle-bounded scan CANNOT preempt them — `String.replace` runs
 * synchronously, so the Promise.race timeout never fires while the event
 * loop is stuck inside the regex (verified: `(a|a)*b` over a 34-char run
 * of `a` does not return in 180s on Node 22). Pattern validation is
 * therefore the only line of defense for custom entities. Deliberately
 * approximate: full detection needs a real parser, and safe alternations
 * like `(emp|hr)_id?` get rejected when the group is quantified — the
 * gate exists so catastrophic shapes fail visibly at parse, not as a
 * guarantee.
 */
export function hasReDoSRisk(pattern: string): boolean {
	// Per-open-group bookkeeping: does its subtree (itself + nested groups)
	// contain alternation or a quantifier at any depth. A group whose
	// closing paren is followed by a quantifier is rejected when either
	// signal propagated to its frame.
	const stack: { alt: boolean; quant: boolean }[] = []
	let inClass = false
	const isQuantifierAt = (i: number): boolean => {
		const c = pattern[i + 1]
		return c === "*" || c === "+" || (c === "{" && /\d/.test(pattern[i + 2] ?? ""))
	}
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]
		if (ch === "\\") {
			i++
			continue
		}
		if (inClass) {
			if (ch === "]") inClass = false
			continue
		}
		if (ch === "[") {
			inClass = true
			continue
		}
		if (ch === "(") {
			stack.push({ alt: false, quant: false })
			continue
		}
		if (ch === ")") {
			const frame = stack.pop()
			if (!frame) break // unbalanced — the compile check reports the real error
			const quantified = isQuantifierAt(i)
			if (quantified && (frame.alt || frame.quant)) return true
			const parent = stack[stack.length - 1]
			if (parent) {
				parent.alt ||= frame.alt
				parent.quant ||= frame.quant || quantified
			}
			continue
		}
		const current = stack[stack.length - 1]
		if (!current) continue
		if (ch === "|") current.alt = true
		if (ch === "*" || ch === "+" || (ch === "{" && /\d/.test(pattern[i + 1] ?? ""))) {
			current.quant = true
		}
	}
	return false
}

/**
 * The number of capture groups the compiled pattern exposes, so
 * `secretGroup` can be validated against reality: the replace callback
 * reads `args[secretGroup - 1]` and anything beyond the last group is the
 * match offset or undefined, silently corrupting the redacted output.
 * `new RegExp(pattern + "|").exec("")` always matches the empty
 * alternative, and non-participating groups keep their slots as undefined.
 */
export function countPatternCaptureGroups(pattern: string, flags?: string): number {
	const result = new RegExp(`${pattern}|`, flags ? `g${flags}`.replace("g", "") : "").exec("")
	return (result?.length ?? 1) - 1
}

const MANAGED_STATE_MAP: Record<string, RedactionState> = {
	KIMCHI_REDACTION_STATE_ON: "on",
	KIMCHI_REDACTION_STATE_OFF: "off",
	on: "on",
	off: "off",
}

/** Dropping policy convention: strict (throw — local) vs tolerant (drop — managed). */
type ParseMode = "strict" | "tolerant"

interface ParseContext {
	mode: ParseMode
	/** Tolerant mode collects reasons here; the caller logs one line. */
	dropped: string[]
	/** Custom entity names being defined in the OTHER layer (managed when parsing local) — valid `entities` keys. */
	extraEntityNames?: ReadonlySet<string>
}

function invalid(ctx: ParseContext, reason: string): undefined {
	if (ctx.mode === "strict") throw new Error(`settings.json "redaction": ${reason}`)
	ctx.dropped.push(reason)
	return undefined
}

function parseStateMap(
	raw: unknown,
	kind: "categories" | "entities",
	ctx: ParseContext,
	customNames: ReadonlySet<string>,
): Record<string, RedactionState> | undefined {
	if (raw === undefined) return undefined
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return invalid(ctx, `"${kind}" must be an object`)
	}
	const out: Record<string, RedactionState> = {}
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const state = ctx.mode === "tolerant" ? MANAGED_STATE_MAP[value as string] : value
		if (state !== "on" && state !== "off") {
			invalid(ctx, `"${kind}.${key}" must be "on" or "off"`)
			continue
		}
		if (kind === "categories") {
			if (!isRedactionCategory(key)) {
				invalid(ctx, `unknown category "${key}"`)
				continue
			}
		} else {
			if (!isKnownEntity(key) && !customNames.has(key) && !ctx.extraEntityNames?.has(key)) {
				invalid(ctx, `unknown entity "${key}"`)
				continue
			}
			if (!customNames.has(key) && !ctx.extraEntityNames?.has(key) && getEntityCategory(key) === undefined) {
				invalid(ctx, `entity "${key}" is not configurable`)
				continue
			}
		}
		out[key] = state
	}
	return out
}

function parseCustomEntities(raw: unknown, ctx: ParseContext): CustomEntityDef[] | undefined {
	if (raw === undefined) return undefined
	if (!Array.isArray(raw)) {
		return invalid(ctx, `"customEntities" must be an array`)
	}
	if (raw.length > MAX_CUSTOM_ENTITIES) {
		return invalid(ctx, `"customEntities" may hold at most ${MAX_CUSTOM_ENTITIES} entries`)
	}
	const out: CustomEntityDef[] = []
	const seen = new Set<string>()
	for (const [index, entry] of raw.entries()) {
		const label = `customEntities[${index}]`
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			invalid(ctx, `${label} is not an object`)
			continue
		}
		const e = entry as Record<string, unknown>
		const name = e.name
		if (typeof name !== "string" || !CUSTOM_ENTITY_NAME_RE.test(name)) {
			invalid(ctx, `${label}.name must match ${CUSTOM_ENTITY_NAME_RE.source}`)
			continue
		}
		if (isKnownEntity(name)) {
			invalid(ctx, `${label}.name collides with built-in entity "${name}"`)
			continue
		}
		if (seen.has(name)) {
			invalid(ctx, `${label}.name is duplicated`)
			continue
		}
		const category = e.category
		if (typeof category !== "string" || !isRedactionCategory(category)) {
			invalid(ctx, `${label}.category must be one of the known categories`)
			continue
		}
		const pattern = e.pattern
		if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
			invalid(ctx, `${label}.pattern must be 1..${MAX_PATTERN_LENGTH} characters`)
			continue
		}
		const flags = e.flags
		if (flags !== undefined && (typeof flags !== "string" || !CUSTOM_ENTITY_FLAGS_RE.test(flags))) {
			invalid(ctx, `${label}.flags must be a subset of "imsu"`)
			continue
		}
		const secretGroup = e.secretGroup
		if (secretGroup !== undefined && (!Number.isInteger(secretGroup) || (secretGroup as number) < 1)) {
			invalid(ctx, `${label}.secretGroup must be a positive integer`)
			continue
		}
		if (hasReDoSRisk(pattern)) {
			invalid(ctx, `${label}.pattern has a quantified group with alternation or a nested quantifier (ReDoS risk)`)
			continue
		}
		const compiled = `${pattern}`
		try {
			new RegExp(`(?:${compiled})`, `g${typeof flags === "string" ? flags : ""}`)
		} catch (err) {
			invalid(ctx, `${label}.pattern does not compile: ${err instanceof Error ? err.message : String(err)}`)
			continue
		}
		if (
			secretGroup !== undefined &&
			(secretGroup as number) > countPatternCaptureGroups(compiled, typeof flags === "string" ? flags : undefined)
		) {
			invalid(ctx, `${label}.secretGroup exceeds the pattern's capture-group count`)
			continue
		}
		seen.add(name)
		out.push({
			name,
			category,
			pattern,
			flags: typeof flags === "string" ? flags : undefined,
			secretGroup: typeof secretGroup === "number" ? secretGroup : undefined,
		})
	}
	return out
}

function parsePolicy(raw: unknown, ctx: ParseContext): RedactionPolicy | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return invalid(ctx, "must be an object")
	}
	const block = raw as Record<string, unknown>
	const customEntities = parseCustomEntities(block.customEntities, ctx)
	const customNames = new Set((customEntities ?? []).map((c) => c.name))
	const categories = parseStateMap(block.categories, "categories", ctx, customNames)
	const entities = parseStateMap(block.entities, "entities", ctx, customNames)
	if (
		ctx.mode === "tolerant" &&
		Object.keys(categories ?? {}).length === 0 &&
		Object.keys(entities ?? {}).length === 0 &&
		(customEntities ?? []).length === 0
	) {
		// A managed block whose entries all dropped (unknown or unspecified)
		// parses as absent — an empty policy must not shadow the local one.
		return undefined
	}
	const policy: RedactionPolicy = {}
	if (categories !== undefined) policy.categories = categories as Partial<Record<RedactionCategory, RedactionState>>
	if (entities !== undefined) policy.entities = entities
	if (customEntities !== undefined) policy.customEntities = customEntities
	return policy
}

/**
 * Parse a LOCAL settings.json `redaction` block. Strict: unknown category or
 * entity names, malformed custom entities, and invalid states throw — a
 * settings typo must be visible, not silently switch redaction behavior.
 */
export function parseLocalPolicy(raw: unknown, extraEntityNames?: ReadonlySet<string>): RedactionPolicy {
	return parsePolicy(raw, { mode: "strict", dropped: [], extraEntityNames }) ?? {}
}

/**
 * Parse the MANAGED platform policy. Tolerant: unknown entries are dropped
 * (collected reasons logged once by the caller); the harness never knows
 * every category/entity name the platform may send, and a wire value it
 * predates must not disable the pipeline. Returns undefined when the input
 * is not a usable policy.
 */
export function parseManagedPolicy(raw: unknown, onDropped?: (reasons: string[]) => void): RedactionPolicy | undefined {
	const ctx: ParseContext = { mode: "tolerant", dropped: [] }
	const parsed = parsePolicy(raw, ctx)
	if (ctx.dropped.length > 0) onDropped?.(ctx.dropped)
	return parsed
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolution memo: the inputs are plain parsed data, so identical settings
 * resolve once for the process lifetime. Bounded — a distinct policy shows
 * up at most per settings.json edit; the oldest entry goes after 16.
 */
const resolutionCache = new Map<string, ResolvedRedaction>()
const RESOLUTION_CACHE_MAX = 16

/**
 * Resolve managed and local policies into the executable view. When local
 * input is the legacy excluded list, it replaces the engine exclusions
 * wholesale (its pre-policy meaning) and the managed policy still applies
 * per key on top.
 *
 * CONTRACT: policy inputs must come from parseLocalPolicy / parseManagedPolicy
 * (or be assembled with identical validation in tests) — this function
 * compiles custom patterns without revalidating; a direct construction
 * would bypass the ReDoS gate, the entry/pattern caps, and the name-
 * collision check.
 */
export function resolveRedactionPolicy(managed?: RedactionPolicy, local?: LocalRedactionInput): ResolvedRedaction {
	const key = JSON.stringify([managed ?? null, local ?? null])
	const hit = resolutionCache.get(key)
	if (hit) return hit
	const resolved = resolveRedactionPolicyUncached(managed, local)
	resolutionCache.set(key, resolved)
	if (resolutionCache.size > RESOLUTION_CACHE_MAX) {
		const oldest = resolutionCache.keys().next().value
		if (oldest !== undefined) resolutionCache.delete(oldest)
	}
	return resolved
}

function resolveRedactionPolicyUncached(managed?: RedactionPolicy, local?: LocalRedactionInput): ResolvedRedaction {
	const legacy = local !== undefined && "legacyExcluded" in local ? local.legacyExcluded : undefined
	const localPolicy = legacy !== undefined ? undefined : (local as RedactionPolicy | undefined)

	// Universe: registered entities (all categorized) plus the
	// custom definitions from both layers. Managed custom definitions win on
	// a name collision with local ones.
	const customDefs = new Map<string, CustomEntityDef>()
	for (const def of localPolicy?.customEntities ?? []) customDefs.set(def.name, def)
	for (const def of managed?.customEntities ?? []) customDefs.set(def.name, def)

	const categories = new Map<string, string>()
	for (const { entity, category } of listRedactionCatalog()) categories.set(entity, category)
	for (const [name, def] of customDefs) categories.set(name, def.category)

	// Explicit states only: entities named by either policy adjust the
	// baseline below. DEFAULTS ARE NEVER APPLIED AS STATES — the baseline
	// already is the default behavior (bare shapes excluded at engine; all
	// custom patterns live), so applying defaultOn entries would wrongly
	// un-exclude bare detectors (TELEGRAM_BOT_TOKEN/OKTA_TOKEN) and undo the
	// tier registry's precision work.
	const explicitStates = new Map<string, boolean>()
	for (const [entity, category] of categories) {
		const state =
			managed?.entities?.[entity] ??
			managed?.categories?.[category as RedactionCategory] ??
			localPolicy?.entities?.[entity] ??
			localPolicy?.categories?.[category as RedactionCategory]
		if (state !== undefined) explicitStates.set(entity, state === "on")
	}

	let engineExclusions: string[]
	const disabled = new Set<string>()
	if (legacy !== undefined) {
		// The legacy list replaces the tier-driven baseline wholesale — except
		// PERMANENT_ENGINE_EXCLUSIONS, which no path may un-exclude.
		engineExclusions = [...new Set([...legacy, ...PERMANENT_ENGINE_EXCLUSIONS])]
		for (const name of legacy) disabled.add(name)
	} else {
		engineExclusions = getDefaultExcludedEntities()
	}

	for (const [entity, on] of explicitStates) {
		if (on) {
			disabled.delete(entity)
			// anchor_required: the engine bare detector stays excluded — ON
			// means the anchored custom coverage, never the bare shape. Custom
			// entities have no engine detector to un-exclude.
			if (getEntityTier(entity) !== "anchor_required" && !customDefs.has(entity)) {
				engineExclusions = engineExclusions.filter((name) => name !== entity)
			}
		} else {
			disabled.add(entity)
			// Custom entities have no engine detector to exclude; only engine
			// names join the engine list (mirroring the ON branch's guard).
			if (!customDefs.has(entity) && !engineExclusions.includes(entity)) engineExclusions.push(entity)
		}
	}
	engineExclusions.sort()

	const customPatterns: CompiledCustomEntity[] = []
	for (const [name, def] of customDefs) {
		if (explicitStates.get(name) === false) continue // OFF custom entities never compile in
		customPatterns.push({
			name,
			category: def.category,
			regex: new RegExp(`(?:${def.pattern})`, `g${def.flags ?? ""}`),
			secretGroup: def.secretGroup,
		})
	}

	const signature = JSON.stringify([
		engineExclusions,
		[...disabled].sort(),
		customPatterns.map((c) => [c.name, c.category, c.regex.source, c.regex.flags, c.secretGroup ?? 0]),
	])
	// The result is memoized in a process-global cache — freeze the one mutable
	// field so no consumer (TUI or ACP session) can corrupt the shared view.
	return {
		engineExclusions: Object.freeze(engineExclusions),
		disabledEntities: disabled,
		customPatterns,
		categories,
		signature,
	}
}

/**
 * Validate the legacy `redaction.excludedEntities` setting: an array of
 * known entity names. Throws fail-visible — the same convention as the
 * policy keys, owned here so all redaction-input rules live in one module.
 */
export function parseLegacyExcludedEntities(raw: unknown): string[] {
	if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
		throw new Error('settings.json "redaction.excludedEntities" must be an array of strings')
	}
	for (const name of raw as string[]) {
		// PERMANENT_ENGINE_EXCLUSIONS names describe real engine detectors we
		// suppress without a registry entry, so they are valid things to keep
		// off; users copying the default exclusion list into settings must not
		// hit "unknown entity".
		if (!isKnownEntity(name) && !PERMANENT_ENGINE_EXCLUSIONS.includes(name)) {
			throw new Error(`settings.json "redaction.excludedEntities": unknown entity "${name}"`)
		}
	}
	return raw as string[]
}
