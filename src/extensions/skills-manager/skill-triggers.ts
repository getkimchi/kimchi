/**
 * Machine-readable `triggers:` frontmatter for skills — the deterministic
 * auto-load schema.
 *
 * A skill opts into deterministic loading by declaring:
 *
 *   ---
 *   triggers:
 *     prompt:
 *       extensions: [pdf]
 *       keywords: [powerpoint, slide deck]
 *   ---
 *
 * `extensions` matches file names (a whitespace-delimited token ending in
 * `.<ext>`); `keywords` matches whole words or phrases, case-insensitive,
 * with an optional trailing "s" on the final word. Both are plain data:
 * matching compiles them with string operations only — no `RegExp` is
 * ever constructed from skill content, so a hostile skill cannot slow the
 * prompt path (the ReDoS review finding that killed an earlier
 * regex-based design). One grammar for every tier: bundled, harness
 * (user), and discovered (project / npm / skillPaths) skills declare the
 * same schema; auto-load.ts applies the per-tier policy.
 *
 * The parser tolerates the older decorative forms — a prose list
 * (`triggers: ["user asks to …"]`, carried by dap-debugging / improve) and
 * the never-released regex-array form (`prompt: ['\.pdf\b']`) — which
 * parse to "no triggers".
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import type { SkillOrigin } from "./skill-manager.js"

export interface SkillTriggers {
	/** File extensions this skill should auto-load on (`report.pdf`). */
	extensions: string[]
	/** Whole words / phrases this skill should auto-load on. */
	keywords: string[]
}

/** Registry tiers, in resolution order (mirrors SkillManager._findSkill). */
export type TriggerOrigin = SkillOrigin

export interface SkillTriggerSource {
	name: string
	/** Full SKILL.md text (frontmatter + body), as returned by view(). */
	content: string
	origin: TriggerOrigin
	/** Human-readable provenance phrase for non-bundled tiers (shown in
	 *  the steer header so the model can weigh third-party content). */
	label?: string
}

export interface RegistryEntry {
	triggers: SkillTriggers
	origin: TriggerOrigin
	label?: string
}

export type TriggerRegistry = Map<string, RegistryEntry>

const MAX_TRIGGER_ENTRIES = 16
const MAX_KEYWORD_LENGTH = 64

interface TriggerFrontmatter {
	[key: string]: unknown
	triggers?: unknown
	"requires-resource"?: unknown
	"disable-model-invocation"?: unknown
}

function emptyTriggers(): SkillTriggers {
	return { extensions: [], keywords: [] }
}

/**
 * Parse a SKILL.md document (frontmatter + body) into its trigger set.
 * Never throws: absent, prose-list, and malformed triggers all yield an
 * empty set, and each invalid entry is dropped with a console warning so
 * one bad value can't take down the others — or the whole skill registry.
 */
export function parseSkillTriggers(skillContent: string): SkillTriggers {
	let yaml: TriggerFrontmatter
	try {
		yaml = parseFrontmatter<TriggerFrontmatter>(skillContent).frontmatter
	} catch (err) {
		console.warn(`[skill-triggers] frontmatter parse failed, ignoring triggers: ${String(err)}`)
		return emptyTriggers()
	}

	const triggers = yaml.triggers
	// legacy prose-list form: `triggers: ["user asks to …"]` — documentation
	// only, never machine-matched
	if (!triggers || Array.isArray(triggers) || typeof triggers !== "object") return emptyTriggers()

	const promptRaw = (triggers as Record<string, unknown>).prompt
	if (!promptRaw || typeof promptRaw !== "object" || Array.isArray(promptRaw)) {
		if (Array.isArray(promptRaw)) {
			// the regex-array form from the unreleased v1 — warn so authors notice
			console.warn("[skill-triggers] triggers.prompt is an array; expected { extensions, keywords }")
		}
		return emptyTriggers()
	}

	const prompt = promptRaw as Record<string, unknown>
	return {
		extensions: parseEntryList(prompt.extensions, "extensions", normalizeExtension),
		keywords: parseEntryList(prompt.keywords, "keywords", normalizeKeyword),
	}
}

function parseEntryList(raw: unknown, field: string, normalize: (value: string) => string | null): string[] {
	if (!Array.isArray(raw)) return []
	const out: string[] = []
	for (const entry of raw) {
		if (typeof entry !== "string") {
			console.warn(`[skill-triggers] dropping non-string ${field} trigger: ${JSON.stringify(entry)}`)
			continue
		}
		const normalized = normalize(entry)
		if (normalized === null) {
			console.warn(`[skill-triggers] dropping invalid ${field} trigger: ${JSON.stringify(entry)}`)
			continue
		}
		if (out.includes(normalized)) continue
		if (out.length >= MAX_TRIGGER_ENTRIES) {
			console.warn(`[skill-triggers] truncating ${field} at ${MAX_TRIGGER_ENTRIES} entries`)
			break
		}
		out.push(normalized)
	}
	return out
}

/** Lowercase, leading `.` stripped, `[a-z0-9]{1,10}`. */
function normalizeExtension(value: string): string | null {
	const ext = value.trim().toLowerCase().replace(/^\./, "")
	return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null
}

/** Lowercase, internal whitespace collapsed, 2–64 chars. */
function normalizeKeyword(value: string): string | null {
	const keyword = value.trim().toLowerCase().replace(/\s+/g, " ")
	return keyword.length >= 2 && keyword.length <= MAX_KEYWORD_LENGTH ? keyword : null
}

/**
 * Build the per-session trigger registry: skill name → trigger set + tier.
 * Skills whose trigger set is empty are omitted. Input order decides
 * shadowing — callers pass sources strongest-first and the first occurrence
 * of a name wins (mirrors SkillManager's harness → bundled → discovered
 * tiers).
 */
export function buildTriggerRegistry(sources: readonly SkillTriggerSource[]): TriggerRegistry {
	const registry: TriggerRegistry = new Map()
	for (const source of sources) {
		if (registry.has(source.name)) continue
		const triggers = parseSkillTriggers(source.content)
		if (triggers.extensions.length === 0 && triggers.keywords.length === 0) continue
		registry.set(source.name, { triggers, origin: source.origin, ...(source.label ? { label: source.label } : {}) })
	}
	return registry
}

const PUNCTUATION = "\"'`()[]{}<>,;:!?*."

/** True when some whitespace-delimited token of `text` is a file name ending
 *  in `.${ext}` — leading/trailing punctuation stripped, case-insensitive.
 *  Covers `report.pdf`, `` `a.pdf` ``, `(a.pdf).`, and URLs ending `.pdf`;
 *  not `a.pdfx`, and not a bare `docx` with no dot (bare words are
 *  keywords). */
export function matchesExtension(text: string, ext: string): boolean {
	for (const raw of text.split(/\s+/)) {
		let start = 0
		let end = raw.length
		while (start < end && PUNCTUATION.includes(raw[start])) start += 1
		while (end > start && PUNCTUATION.includes(raw[end - 1])) end -= 1
		if (raw.slice(start, end).toLowerCase().endsWith(`.${ext}`)) return true
	}
	return false
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** True when `keyword` occurs in `text` on word boundaries
 *  (case-insensitive, whitespace collapsed), with an optional trailing
 *  "s" on the final word — `spreadsheet` matches `spreadsheets`, not
 *  `spreadsheeting`. */
export function matchesKeyword(text: string, keyword: string): boolean {
	const haystack = text.toLowerCase().replace(/\s+/g, " ")
	let at = haystack.indexOf(keyword)
	while (at !== -1) {
		if (wordBoundaryBefore(haystack, at) && wordBoundaryAfter(haystack, at + keyword.length)) return true
		at = haystack.indexOf(keyword, at + 1)
	}
	return false
}

function wordBoundaryBefore(text: string, at: number): boolean {
	return at === 0 || !WORD_CHAR.test(text[at - 1])
}

function wordBoundaryAfter(text: string, at: number): boolean {
	if (at >= text.length) return true
	const next = text[at]
	if (!WORD_CHAR.test(next)) return true
	return next === "s" && (at + 1 >= text.length || !WORD_CHAR.test(text[at + 1]))
}

/** First of a skill's triggers that matches `text`, in reporting form
 *  (`ext:.pdf` / `kw:powerpoint`), for the steer header and stats entry. */
function firstMatch(triggers: SkillTriggers, text: string): string | undefined {
	for (const ext of triggers.extensions) {
		if (matchesExtension(text, ext)) return `ext:.${ext}`
	}
	for (const keyword of triggers.keywords) {
		if (matchesKeyword(text, keyword)) return `kw:${keyword}`
	}
	return undefined
}

/** Each registry skill whose triggers match `text`, in registry (tier)
 *  order, with the winning trigger in reporting form. */
export function matchPrompt(
	registry: ReadonlyMap<string, RegistryEntry>,
	text: string,
): Array<{ name: string; matched: string }> {
	const hits: Array<{ name: string; matched: string }> = []
	for (const [name, entry] of registry) {
		const matched = firstMatch(entry.triggers, text)
		if (matched) hits.push({ name, matched })
	}
	return hits
}

/** The `requires-resource:` id a skill's frontmatter declares, if any.
 *  Consumers gate the skill behind the org resource store the same way the
 *  prompt catalog does (resolve-skill-roots.ts). */
export function requiresResource(skillContent: string): string | undefined {
	try {
		const value = parseFrontmatter<TriggerFrontmatter>(skillContent).frontmatter["requires-resource"]
		return typeof value === "string" && value.length > 0 ? value : undefined
	} catch {
		return undefined
	}
}

/** True when the skill's frontmatter sets `disable-model-invocation: true`.
 *  Such skills are user-facing only (pi keeps them out of the model's prompt
 *  catalog), so auto-load must not push their bodies at the model either —
 *  neither listInventory() nor pi's skill commands filter them. */
export function isModelInvocationDisabled(skillContent: string): boolean {
	try {
		return parseFrontmatter<TriggerFrontmatter>(skillContent).frontmatter["disable-model-invocation"] === true
	} catch {
		return false
	}
}

/** Header the ACP server writes when it rewrites a skill command into a
 *  prompt (skill-commands.ts composes from this constant; the regex below
 *  parses it — one source of truth so the two cannot drift). */
export const SKILL_INVOKE_PREFIX = "Invoking skill: "

const SKILL_COMMAND_RE = /^\/skill:(\S+)/
// Built from the module constant above — never from skill content.
const SKILL_INVOKE_RE = new RegExp(`^${SKILL_INVOKE_PREFIX}(\\S+)`)

export interface SkillCommandMatch {
	name: string
	/** Text that is safe to trigger-match: the args after pi's raw
	 *  `/skill:<name>` command. Undefined for the ACP rewrite form, whose text
	 *  embeds the skill body — matching it would inject unrelated skills whose
	 *  extensions the body happens to mention. */
	matchText?: string
}

/** The skill explicitly invoked by this input, if it is a skill command.
 *  Two shapes reach the `input` handler: pi's raw `/skill:<name> args`
 *  (expansion runs after input handlers), and the ACP server's rewrite
 *  `Invoking skill: <name>\n<content>` (skill-commands.ts rewrites before
 *  prompt()). Explicit invocations must not be auto-loaded on top. */
export function parseSkillCommand(text: string): SkillCommandMatch | undefined {
	const raw = SKILL_COMMAND_RE.exec(text)
	if (raw) return { name: raw[1], matchText: text.slice(raw[0].length) }
	const invoke = SKILL_INVOKE_RE.exec(text)
	if (invoke) return { name: invoke[1] }
	return undefined
}
