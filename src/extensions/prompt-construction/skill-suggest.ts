/**
 * Skill suggester — harness-side matching of user input against the
 * discovered skill inventory, producing a lightweight existence reminder.
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
 * specifically. 0.6 ≈ "most of the input is about this skill" or
 * "a third of the input matched the skill's name".
 */
export const SKILL_SUGGEST_THRESHOLD = 0.5

/**
 * A match at or above this score re-arms the once-per-skill latch — the
 * user is clearly repeating the topic, so remind again even if the skill
 * was already suggested this session.
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
 * Two tokens are the same word when equal, or when they share a prefix of
 * at least TOKEN_PREFIX_MIN characters and both are long enough for the
 * prefix to be meaningful. This catches inflection variants
 * (commit/committing, branch/branching, proofread/proofreader) without a
 * stemmer.
 */
function tokensMatch(a: string, b: string): boolean {
	if (a === b) return true
	if (a.length < TOKEN_PREFIX_MIN || b.length < TOKEN_PREFIX_MIN) return false
	const shorter = Math.min(a.length, b.length)
	return a.slice(0, shorter) === b.slice(0, shorter) && shorter >= TOKEN_PREFIX_MIN
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
	const coverage = matched / uniqueTokens.length
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

	/** Refresh the inventory; called on every before_agent_start. */
	updateSkills(skills: readonly Skill[]): void {
		this.skills = skills
	}

	suggest(input: string): { suggestions: SkillSuggestion[]; latched: number } {
		const candidates = suggestSkills(input, this.skills)
		const suggestions: SkillSuggestion[] = []
		let latched = 0
		for (const candidate of candidates) {
			const previous = this.suggested.get(candidate.name)
			if (previous !== undefined && candidate.score < SKILL_SUGGEST_STRONG) {
				latched += 1
				continue
			}
			this.suggested.set(candidate.name, candidate.score)
			suggestions.push(candidate)
		}
		return { suggestions, latched }
	}
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
			`(load with \`skill_view\` (name: \`${s.name}\`) or read \`${s.filePath}\`)`,
	)
	return [
		"The following installed skills appear relevant to the current task:",
		"",
		...lines,
		"",
		"Whether to load one is your call — decide based on the task.",
	].join("\n")
}
