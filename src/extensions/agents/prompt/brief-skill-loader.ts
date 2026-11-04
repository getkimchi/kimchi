// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * brief-skill-loader.ts — Deterministic skill auto-load for subagent task briefs.
 *
 * Mirrors the parent session's trigger-based auto-load
 * (skills-manager/auto-load.ts) at subagent spawn time: the orchestrator's
 * task brief is matched against the same `triggers.prompt` grammar, and
 * matched skills are injected into the child's system prompt via
 * `PromptExtras.skillBlocks` — compaction-safe by construction, with no
 * steer or one-shot bookkeeping needed for a single injection at spawn.
 *
 * One scan per spawn feeds both consumers: the compact Available Skills
 * list (metadata) and the trigger-matched preloads (full bodies), replacing
 * the previous separate `listAvailableSkillNames` pass.
 *
 * Tier policy mirrors the parent:
 * - `agent_created` harness skills never auto-load (the flag lives in the
 *   skill dir's `.usage.json` sidecar, not frontmatter — see
 *   skill-manager.ts `_scanDir`).
 * - `disable-model-invocation: true` skills are user-facing only; their
 *   bodies are never pushed at a model.
 * - `requires-resource` skills are gated on the resource store.
 * - Project content only reaches the registry after project trust
 *   (resolve-skill-roots.ts skips untrusted project-scoped roots).
 * - Skills a bundled skill shadows via `disables-skills` are excluded from
 *   the discovered (config/project) roots, exactly like the parent's
 *   discovery channels (prompt-enrichment.ts, claude-code-skills).
 *
 * The registry is built strongest-first (project > config > harness >
 * bundled) because `buildTriggerRegistry` keeps the first occurrence of a
 * name — the same precedence `skill-loader.ts` produces with later-wins.
 */

import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../../resources/store.js"
import {
	collectBundledDisabledSkillNames,
	resolveSkillRoots,
	type SkillRootKind,
} from "../../../shared/skill-discovery/resolve-skill-roots.js"
import {
	buildTriggerRegistry,
	HARNESS_SKILL_LABEL,
	isAgentCreatedSkillDir,
	isModelInvocationDisabled,
	MAX_AUTOLOAD_PER_PROMPT,
	matchPrompt,
	provenanceSentence,
	requiresResource,
	type SkillTriggerHit,
	type SkillTriggerSource,
	type TriggerOrigin,
} from "../../skills-manager/skill-triggers.js"
import type { SkillListEntry } from "./skill-loader.js"

/** Kind → tier mapping as one declared table (mirrors the parent's tier
 *  labels), so adding a root kind means touching one place. */
const KIND_META: Record<SkillRootKind, { origin: TriggerOrigin; label?: string }> = {
	bundled: { origin: "bundled" },
	harness: { origin: "harness", label: HARNESS_SKILL_LABEL },
	agent: { origin: "harness", label: HARNESS_SKILL_LABEL },
	config: { origin: "discovered", label: "a user skill from your configured skill paths" },
	project: { origin: "discovered", label: "a project skill" },
}

export interface MatchedBriefSkill extends SkillTriggerHit {
	/** Full SKILL.md text (frontmatter + body), as injected by preload. */
	content: string
	/** Provenance phrase for non-bundled tiers; undefined for bundled. */
	label?: string
}

/** Result of the per-spawn skill scan: the metadata list for the Available
 *  Skills block and the trigger-matched skills to preload. */
export interface BriefSkillScan {
	available: SkillListEntry[]
	matched: MatchedBriefSkill[]
}

export interface ScanBriefSkillsOptions {
	/** Override for os.homedir() (tests). */
	homeDir?: string
	/** Override for the bundled skills dir; null disables the root (tests). */
	bundledDir?: string | null
	/** Resource-toggle probe for `requires-resource` gating; injectable so
	 *  tests don't touch the org-policy store. Defaults to the store. */
	isResourceEnabled?: (id: string) => boolean
	/** Set false to skip brief matching (inherit_context agents: the forked
	 *  parent history already carries the parent's loaded skills). The
	 *  Available Skills list is still produced. Default true. */
	matchBrief?: boolean
}

/** Collapse skill-authorable text (frontmatter names) to a single
 *  prompt-safe line: pi keeps skill names even when they fail validation,
 *  so a name can carry newlines or control characters that would forge
 *  system-prompt structure or tool-result lines. Exported for tests. */
export function sanitizeLine(text: string): string {
	// \p{C} covers control/format characters (Cc, Cf, Co, Cn) — the same
	// set as the C0 range plus DEL — without literal control characters in
	// the regex source (noControlCharactersInRegex).
	return text
		.replace(/[\s\p{C}]+/gu, " ")
		.trim()
		.slice(0, 200)
}

/** True when the skill dir's `.usage.json` sidecar marks it agent-created
 *  (shared probe — see skill-triggers.ts `isAgentCreatedSkillDir`). */
const isAgentCreated = isAgentCreatedSkillDir

/**
 * Scan the skill roots once for a subagent spawn: produce the Available
 * Skills metadata list and, when `matchBrief` is on, the capped set of
 * trigger-matched skills to preload. Never throws: a failed scan degrades
 * to empty results so one broken skill directory cannot block a spawn.
 */
export async function scanBriefSkills(
	brief: string,
	cwd: string,
	options: ScanBriefSkillsOptions = {},
): Promise<BriefSkillScan> {
	const text = typeof brief === "string" ? brief.trim() : ""
	const matchBrief = options.matchBrief !== false && text.length > 0
	const resourceEnabled = options.isResourceEnabled ?? isResourceEnabled

	try {
		// resolveSkillRoots returns weakest-first; reverse it so the first
		// occurrence of a name in buildTriggerRegistry is the strongest tier.
		const roots = resolveSkillRoots({
			cwd,
			...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
			...(options.bundledDir !== undefined ? { bundledDir: options.bundledDir } : {}),
		}).reverse()
		// Shadowed names are excluded from the discovered (config/project)
		// roots only — the same channels the parent's discovery gates
		// (prompt-enrichment.ts, claude-code-skills); harness and bundled
		// roots are loaded natively and never shadowed.
		const disabledByBundled = collectBundledDisabledSkillNames(
			options.bundledDir === undefined ? undefined : (options.bundledDir ?? "/nonexistent-skills"),
		)

		const sources: SkillTriggerSource[] = []
		const available: SkillListEntry[] = []
		const seen = new Set<string>()
		let skipped = 0
		for (const root of roots) {
			let skills: ReturnType<typeof loadSkillsFromDir>["skills"]
			try {
				skills = loadSkillsFromDir({ dir: root.dir, source: root.dir }).skills
			} catch {
				continue // directory missing or unreadable
			}
			const meta = KIND_META[root.kind]
			for (const skill of skills) {
				const name = sanitizeLine(skill.name)
				if (seen.has(name)) continue
				if (
					(root.kind === "config" || root.kind === "project") &&
					(disabledByBundled.has(name) || disabledByBundled.has(name.toLowerCase()))
				) {
					continue
				}
				seen.add(name)
				const entry: SkillListEntry = { name, description: skill.description ?? "", filePath: skill.filePath }
				try {
					// Same shape as the parent's auto-load steer (formatSkillViewResult):
					// the entry-file body plus the skill directory, so bundled skills
					// that reference linked files keep their fallback route even though
					// the note tells the model not to re-load via skill_view.
					const content = `${readFileSync(skill.filePath, "utf-8")}\nSkill directory: ${dirname(skill.filePath)}`
					const agentCreated = meta.origin === "harness" && isAgentCreated(dirname(skill.filePath))
					const required = requiresResource(content)
					const resourceOff = required !== undefined && !resourceEnabled(required)
					if (isModelInvocationDisabled(content) || resourceOff) {
						// The parent's model-facing catalog excludes these entirely —
						// advertise nothing, preload nothing. Seen above, so a same-name
						// skill in a weaker root cannot resurrect it.
						continue
					}
					// agent_created harness skills stay in the catalog (the parent
					// advertises them); only auto-load excludes them.
					available.push(entry)
					if (!agentCreated) {
						sources.push({ name, content, origin: meta.origin, ...(meta.label ? { label: meta.label } : {}) })
					}
				} catch {
					// Unreadable body: gates can't be checked — list it best-effort,
					// never preload it.
					skipped += 1
					available.push(entry)
				}
			}
		}
		if (skipped > 0) {
			console.warn(`[skill-autoload] ${skipped} skill body(ies) unreadable during subagent brief scan`)
		}

		const matched: MatchedBriefSkill[] = []
		if (matchBrief) {
			const registry = buildTriggerRegistry(sources)
			const byName = new Map(sources.map((s) => [s.name, s]))
			for (const hit of matchPrompt(registry, text)) {
				if (matched.length >= MAX_AUTOLOAD_PER_PROMPT) break
				const source = byName.get(hit.name)
				if (!source) continue
				matched.push({
					name: hit.name,
					matched: hit.matched,
					content: source.content,
					...(source.label ? { label: source.label } : {}),
				})
			}
		}
		return { available, matched }
	} catch (err) {
		console.warn(`[skill-autoload] subagent brief scan failed:`, err)
		return { available: [], matched: [] }
	}
}

/** Render a matched skill as a `PromptExtras.skillBlocks` entry: an
 *  auto-load note (so the model does not re-load it via skill_view), the
 *  provenance sentence for non-bundled tiers (shared template with the
 *  parent steer), then the full SKILL.md text. */
export function renderBriefSkillBlock(match: MatchedBriefSkill): string {
	const note = `Auto-loaded: this task brief matched the skill's declared trigger (${match.matched}). Its instructions are already in context — do not call skill_view for it.`
	const provenance = match.label ? provenanceSentence(match.label) : ""
	return `${note}${provenance}\n\n${match.content}`
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
