/**
 * Skill suggester — harness-side matching of user input against the
 * discovered skill inventory, producing a lightweight existence reminder.
 *
 * Matching is English-oriented: tokens are `[a-z0-9']` sequences, so
 * non-ASCII prompts (CJK, accented scripts) yield few or no tokens and
 * simply never match — no suggestion, no error. Documented in
 * docs/skills.md.
 *
 * The <available_skills> system-prompt block advertises skills as name +
 * description + location and relies on model discipline to read the
 * SKILL.md. In practice models skip that read regardless of description
 * quality, so the harness performs the match itself and delivers a short
 * reminder naming the skill and how to load it. The reminder is a nudge,
 * not a directive — the model decides whether the skill applies.
 *
 * Pure scoring functions plus a per-session suggester instance that holds
 * the latch state. No module-level mutable state: the caller creates one
 * suggester per session (same pattern as the continuation-nudge maps in
 * prompt-enrichment.ts).
 */

import type { Skill } from "@earendil-works/pi-coding-agent"

/**
 * Minimum weighted score for a skill to be suggested. The score is the
 * fraction of the user's content words covered by the skill's
 * name/description tokens, doubled when a match hit the skill *name*
 * specifically. 0.5 ≈ "most of the input is about this skill" or
 * "a third of the input matched the skill's name".
 */
export const SKILL_SUGGEST_THRESHOLD = 0.5

/**
 * A match at or above this score re-arms the once-per-skill latch once —
 * the user is clearly repeating the topic, so remind a second time even
 * if the skill was already suggested. After that one re-arm the skill is
 * done for the session: repeating a strong topic while never loading the
 * skill is a decline, and re-firing every turn would nag.
 */
export const SKILL_SUGGEST_STRONG = SKILL_SUGGEST_THRESHOLD * 2

/** Maximum skills named in one reminder. */
export const SKILL_SUGGEST_MAX = 2

/** Shared-prefix length at which two tokens count as the same word
 *  (commit/committing, branch/branching, proofread/proofreader). */
const TOKEN_PREFIX_MIN = 4

/**
 * Cap on the description length embedded in the reminder body. The
 * reminder must stay cheap; full detail lives in the SKILL.md itself.
 */
const REMINDER_DESCRIPTION_MAX_CHARS = 140

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"but",
	"not",
	"you",
	"all",
	"can",
	"her",
	"was",
	"one",
	"our",
	"out",
	"day",
	"get",
	"has",
	"him",
	"his",
	"how",
	"its",
	"new",
	"now",
	"old",
	"see",
	"two",
	"way",
	"who",
	"did",
	"yes",
	"that",
	"this",
	"with",
	"from",
	"they",
	"have",
	"were",
	"about",
	"which",
	"their",
	"there",
	"what",
	"when",
	"your",
	"will",
	"would",
	"could",
	"should",
	"into",
	"than",
	"then",
	"them",
	"some",
	"just",
	"like",
	"also",
	"because",
	"these",
	"those",
	"first",
	"please",
	"me",
	"we",
	"us",
	"here",
	"where",
	"while",
	"before",
	"after",
	"over",
	"own",
	"same",
	"only",
	"very",
	"such",
	"other",
	"more",
	"most",
])

/**
 * Content words: lowercased, ≥3 chars, stopword-filtered. Hyphens and
 * underscores are not in the character class, so "vcs-workflow" tokenizes
 * as ["vcs", "workflow"] — skill names and user input tokenize consistently.
 */
export function contentWords(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w))
}

/**
 * Light inflection normalization: strip common suffixes when a ≥4-char
 * base remains, so write/writing, story/stories, and hooks/hook compare
 * equal. Applied to both sides inside tokensMatch — a full stemmer is
 * deliberately avoided; irregular forms (wrote) stay unmatched and that
 * miss is accepted.
 */
function normalizeToken(token: string): string {
	if (token.endsWith("ies") && token.length >= 5) return `${token.slice(0, -3)}y` // stories → story
	if (token.endsWith("ing") && token.length >= 6) return token.slice(0, -3) // writing → writ
	if (token.endsWith("ed") && token.length >= 5) return token.slice(0, -2) // drafted → draft
	if (token.endsWith("s") && !token.endsWith("ss") && token.length >= 4) return token.slice(0, -1) // essays → essay
	return token
}

/**
 * Two tokens are the same word when their normalized forms are equal, or
 * when they share a prefix of at least TOKEN_PREFIX_MIN characters and both
 * are long enough for the prefix to be meaningful. This catches remaining
 * inflection variants (commit/committing, proofread/proofreader, and
 * writ/write after suffix-stripping) without a stemmer.
 */
function tokensMatch(a: string, b: string): boolean {
	const na = normalizeToken(a)
	const nb = normalizeToken(b)
	if (na === nb) return true
	if (na.length < TOKEN_PREFIX_MIN || nb.length < TOKEN_PREFIX_MIN) return false
	const shorter = Math.min(na.length, nb.length)
	return na.slice(0, shorter) === nb.slice(0, shorter) && shorter >= TOKEN_PREFIX_MIN
}

function anyTokenMatches(token: string, candidates: readonly string[]): boolean {
	return candidates.some((c) => tokensMatch(token, c))
}

export interface SkillSuggestion {
	readonly name: string
	readonly description: string
	readonly filePath: string
	readonly score: number
}

function toSuggestion(skill: Skill, score: number): SkillSuggestion {
	return { name: skill.name, description: skill.description, filePath: skill.filePath, score }
}

/**
 * Score one skill against the tokenized input. Returns the fraction of
 * input tokens covered by the skill's name or description tokens,
 * doubled when at least one match hit the skill name specifically.
 * Returns 0 when the input has no content words.
 */
export function scoreSkill(inputTokens: readonly string[], skill: Skill): number {
	const uniqueTokens = [...new Set(inputTokens)]
	if (uniqueTokens.length === 0) return 0
	const nameTokens = contentWords(skill.name)
	const descriptionTokens = contentWords(skill.description)

	let matched = 0
	let nameHit = false
	for (const token of uniqueTokens) {
		if (anyTokenMatches(token, nameTokens)) {
			matched += 1
			nameHit = true
		} else if (anyTokenMatches(token, descriptionTokens)) {
			matched += 1
		}
	}
	if (matched === 0) return 0
	let coverage = matched / uniqueTokens.length
	// Imperative prompts lead with the action verb ("write a story",
	// "debug the parser") while the topic nouns are exactly the tokens that
	// cannot match any skill — short prompts structurally cap coverage. A
	// leading-word match against the skill NAME is the strongest single signal
	// available, so treat it as half the input being about the skill. Name-only:
	// a leading word that merely matches a description token ("read" against
	// "READMEs") gets no floor. The reminder is non-directive and latched once
	// per session, so residual false positives ("write a test" nudging the
	// writing skill) cost one ignored reminder the model self-rejects using the
	// skill's own "do not load for code" clause.
	if (anyTokenMatches(uniqueTokens[0], nameTokens)) {
		coverage = Math.max(coverage, 0.5)
	}
	return coverage * (nameHit ? 2 : 1)
}

/**
 * Pure suggestion pass: score every invocable skill against the input and
 * return the top matches (score ≥ SKILL_SUGGEST_THRESHOLD, capped at
 * SKILL_SUGGEST_MAX, highest score first). Empty result is the normal
 * outcome — nothing matched, nothing gets injected.
 */
export function suggestSkills(input: string, skills: readonly Skill[]): SkillSuggestion[] {
	const inputTokens = contentWords(input)
	if (inputTokens.length === 0) return []

	const scored: SkillSuggestion[] = []
	for (const skill of skills) {
		if (skill.disableModelInvocation) continue
		const score = scoreSkill(inputTokens, skill)
		if (score >= SKILL_SUGGEST_THRESHOLD) scored.push(toSuggestion(skill, score))
	}
	scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
	return scored.slice(0, SKILL_SUGGEST_MAX)
}

/**
 * Per-session suggester: holds the current skill inventory and the
 * once-per-skill latch. The latch releases when a later input matches at
 * SKILL_SUGGEST_STRONG or above — the user repeating the topic clearly.
 */
export class SkillSuggester {
	private skills: readonly Skill[] = []
	private readonly suggested = new Map<string, number>()
	private readonly loaded = new Set<string>()
	private historyScanned = false

	/** Refresh the inventory; called on every before_agent_start. */
	updateSkills(skills: readonly Skill[]): void {
		this.skills = skills
	}

	/** True once the session history has been scanned for prior loads. */
	get hasScannedHistory(): boolean {
		return this.historyScanned
	}

	/**
	 * Mark a skill as loaded into the conversation. Loaded skills are never
	 * suggested — recommending an already-loaded skill is what nudged the
	 * model into redundant skill_view calls (session 01a0a5f1).
	 */
	markLoaded(name: string): void {
		if (name) this.loaded.add(name)
	}

	/**
	 * Record /skill expansions embedded in a prompt. The harness expands
	 * `/skill:name` into a `<skill name="...">` block before
	 * before_agent_start fires, so scanning the prompt catches user-side
	 * loads — including the same-turn case.
	 */
	notePrompt(prompt: string): void {
		for (const match of prompt.matchAll(/<skill name="([^"]+)"/g)) {
			this.markLoaded(match[1])
		}
	}

	/**
	 * Scan the session history once per tracker for skills already loaded
	 * before this tracker existed — /skill expansions in earlier user
	 * messages and skill_view calls the agent already made. Covers resumed
	 * sessions, where the conversation predates the suggester.
	 */
	scanHistory(entries: readonly unknown[]): void {
		if (this.historyScanned) return
		this.historyScanned = true
		for (const entry of entries) {
			const typed = entry as { type?: string; message?: { role?: string; content?: unknown } }
			if (typed?.type !== "message" || !typed.message) continue
			const { role, content } = typed.message
			if (role === "user") {
				this.notePrompt(messageText(content))
			} else if (role === "assistant") {
				for (const block of asBlockArray(content)) {
					if (block.type !== "toolCall" || block.name !== "skill_view") continue
					const args = block.arguments
					const name = typeof args === "object" && args !== null ? (args as Record<string, unknown>).name : undefined
					if (typeof name === "string") this.markLoaded(name)
				}
			}
		}
	}

	suggest(input: string): { suggestions: SkillSuggestion[]; latched: number } {
		const candidates = suggestSkills(input, this.skills)
		const suggestions: SkillSuggestion[] = []
		let latched = 0
		for (const candidate of candidates) {
			// Loaded skills are never suggested — the content is already in the
			// conversation. Not counted as latched: that metric tracks the
			// once-per-skill reminder latch, a different suppression.
			if (this.loaded.has(candidate.name)) continue
			const previous = this.suggested.get(candidate.name)
			if (previous !== undefined && candidate.score < SKILL_SUGGEST_STRONG) {
				latched += 1
				continue
			}
			if (previous !== undefined) {
				// Strong re-fire: the one-shot re-arm. The user has now been
				// reminded twice about the same skill and declined both times —
				// remind again on every subsequent strong turn and the reminder
				// becomes nagging. Infinity latches the skill for the rest of the
				// session regardless of future match strength.
				this.suggested.set(candidate.name, Number.POSITIVE_INFINITY)
				suggestions.push(candidate)
				continue
			}
			this.suggested.set(candidate.name, candidate.score)
			suggestions.push(candidate)
		}
		return { suggestions, latched }
	}
}

function asBlockArray(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content)
		? (content.filter((b) => b && typeof b === "object") as Array<Record<string, unknown>>)
		: []
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content
	return asBlockArray(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
}

/** Domain event channel for skill suggestions, published via pi.events.
 *  The prompt-construction wiring emits it; the telemetry extension
 *  subscribes to keep the layers decoupled (same pattern as FERMENT_EVENTS). */
export const SKILL_SUGGEST_EVENT = "skill-suggest:fired" as const

/** Payload for SKILL_SUGGEST_EVENT. */
export interface SkillSuggestEventPayload {
	/** Skills named in the delivered reminder. */
	skills: ReadonlyArray<{ name: string; filePath: string }>
	/** Matches suppressed by the once-per-skill latch this input. */
	latched: number
}

function truncateAtWord(text: string, max: number): string {
	if (text.length <= max) return text
	const slice = text.slice(0, max)
	const lastSpace = slice.lastIndexOf(" ")
	const cut = lastSpace > max * 0.6 ? lastSpace : max
	return `${slice.slice(0, cut).trimEnd()}…`
}

/**
 * Build the reminder body naming the suggested skills. Wording is a
 * reminder of existence — the load decision stays with the model. The
 * caller wraps this in the harness steer marker (markHarnessSteer).
 */
export function buildSkillReminder(suggestions: readonly SkillSuggestion[]): string {
	const lines = suggestions.map(
		(s) =>
			`- **${s.name}** — ${truncateAtWord(s.description, REMINDER_DESCRIPTION_MAX_CHARS)} ` +
			`(load with the \`skill_view\` tool, name: \`${s.name}\`)`,
	)
	return [
		"The following installed skills appear relevant to the current task:",
		"",
		...lines,
		"",
		"Whether to load one is your call — decide based on the task.",
	].join("\n")
}
