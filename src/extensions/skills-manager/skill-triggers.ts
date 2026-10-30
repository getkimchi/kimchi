/**
 * Machine-readable `triggers:` frontmatter for skills — the deterministic
 * auto-load schema.
 *
 * A skill opts into deterministic loading by declaring:
 *
 *   ---
 *   triggers:
 *     prompt:
 *       - '\.pdf\b'
 *   ---
 *
 * `prompt` holds regex source strings matched case-insensitively against the
 * user prompt text (pi's `input` event). A match makes `auto-load.ts` inject
 * the skill body as a one-shot steer — no model discretion involved.
 *
 * The schema tolerates the older decorative form — a YAML list of prose
 * strings (`triggers: ["user asks to …"]`), carried by dap-debugging /
 * improve — which parses to "no triggers" and keeps working as documentation.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent"

export interface SkillTriggers {
	/** Compiled, case-insensitive matchers for the user prompt text. */
	prompt: RegExp[]
}

interface TriggerFrontmatter {
	[key: string]: unknown
	triggers?: unknown
	"requires-resource"?: unknown
}

/**
 * Parse a SKILL.md document (frontmatter + body) into its trigger set.
 * Never throws: absent/prose-list/malformed triggers all yield an empty set,
 * and each invalid regex is dropped with a console warning so one bad
 * pattern can't take down the others — or the whole skill registry.
 */
export function parseSkillTriggers(skillContent: string): SkillTriggers {
	let yaml: TriggerFrontmatter
	try {
		yaml = parseFrontmatter<TriggerFrontmatter>(skillContent).frontmatter
	} catch (err) {
		console.warn(`[skill-triggers] frontmatter parse failed, ignoring triggers: ${String(err)}`)
		return { prompt: [] }
	}

	const triggers = yaml.triggers
	// legacy prose-list form: `triggers: ["user asks to …"]` — documentation
	// only, never machine-matched
	if (!triggers || Array.isArray(triggers)) return { prompt: [] }
	if (typeof triggers !== "object") return { prompt: [] }

	const promptRaw = (triggers as Record<string, unknown>).prompt
	if (!Array.isArray(promptRaw)) return { prompt: [] }

	const prompt: RegExp[] = []
	for (const entry of promptRaw) {
		if (typeof entry !== "string" || entry.length === 0) {
			console.warn(`[skill-triggers] dropping non-string prompt trigger: ${JSON.stringify(entry)}`)
			continue
		}
		try {
			prompt.push(new RegExp(entry, "i"))
		} catch (err) {
			console.warn(`[skill-triggers] dropping invalid prompt regex '${entry}': ${String(err)}`)
		}
	}
	return { prompt }
}

export interface SkillTriggerSource {
	name: string
	/** Full SKILL.md text (frontmatter + body), as returned by view(). */
	content: string
}

/**
 * Build the per-session trigger registry: skill name → prompt matchers.
 * Skills whose trigger set is empty are omitted. Input order decides
 * shadowing — callers pass sources strongest-first and the first occurrence
 * of a name wins (mirrors SkillManager's harness → bundled → discovered
 * tiers).
 */
export function buildTriggerRegistry(sources: readonly SkillTriggerSource[]): Map<string, RegExp[]> {
	const registry = new Map<string, RegExp[]>()
	for (const source of sources) {
		if (registry.has(source.name)) continue
		const { prompt } = parseSkillTriggers(source.content)
		if (prompt.length > 0) registry.set(source.name, prompt)
	}
	return registry
}

/** First pattern of a skill's set that matches `text`, for observability. */
export function matchPrompt(
	registry: ReadonlyMap<string, RegExp[]>,
	text: string,
): Array<{ name: string; pattern: string }> {
	const hits: Array<{ name: string; pattern: string }> = []
	for (const [name, patterns] of registry) {
		const hit = patterns.find((re) => re.test(text))
		if (hit) hits.push({ name, pattern: hit.source })
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
 *  listInventory() does not filter them (pi filters at prompt-build time). */
export function isModelInvocationDisabled(skillContent: string): boolean {
	try {
		return parseFrontmatter<TriggerFrontmatter>(skillContent).frontmatter["disable-model-invocation"] === true
	} catch {
		return false
	}
}

const SKILL_COMMAND_RE = /^\/skill:(\S+)/
const SKILL_INVOKE_RE = /^Invoking skill: (\S+)/

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
 *  `Invoking skill: <name>\n<content>` (server.ts rewrites before
 *  prompt()). Explicit invocations must not be auto-loaded on top. */
export function parseSkillCommand(text: string): SkillCommandMatch | undefined {
	const raw = SKILL_COMMAND_RE.exec(text)
	if (raw) return { name: raw[1], matchText: text.slice(raw[0].length) }
	const invoke = SKILL_INVOKE_RE.exec(text)
	if (invoke) return { name: invoke[1] }
	return undefined
}
