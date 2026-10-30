/**
 * Deterministic skill auto-load on prompt keywords.
 *
 * When a user prompt matches a skill's declared `triggers.prompt` regexes
 * (see skill-triggers.ts), this module loads the skill itself — via the same
 * `SkillManager.view()` the `skill_view` tool uses — and steers the result
 * into context, `display: false`, wrapped in the harness steer marker. The
 * model never has to notice the description match or decide to call
 * skill_view; a keyword hit IS the load.
 *
 * Scope: the harness and bundled skills tiers only. Discovered skills
 * (project, npm, skillPaths — repo- or package-controlled content) never
 * declare machine-matched triggers: their regexes would run synchronously
 * against prompt text and their bodies would arrive as user-role steers,
 * both without a model-in-the-loop step (see the ReDoS/marker-escape review
 * findings in .kimchi/plans/skill-keyword-autoload.md).
 *
 * Design rules:
 * - Steer-only delivery. Never a system-prompt mutation: a late-rendering
 *   system-prompt block invalidates the full prompt cache (the same reason
 *   behaviours deliver default tool-triggered bodies steer-only).
 * - One-shot per session per skill. `suppressed` also records names the
 *   model loads itself through skill_view, so a manual load is never
 *   followed by an injection.
 * - Session-scoped state. ACP hosts concurrent sessions in one process, so
 *   everything lives behind `Map<sessionId, …>`; teardown on
 *   `session_shutdown` touches only the shutting-down session, and in-flight
 *   async deliveries check `active` after every await so a dead session is
 *   never steered into.
 * - Race closure: `deliver()` marks the skill suppressed synchronously,
 *   before its first await, so two concurrent paths (input match, compaction
 *   re-steer) can never both deliver the same skill.
 * - Defense in depth even though trigger-declaring skills are harness-
 *   authored: matching is capped at MAX_PROMPT_CHARS, `requires-resource`
 *   gates are honored at registry build, and a literal `</system-reminder>`
 *   in a skill body is neutralized before the steer wrapper is applied.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { escapeClosingMarker, markHarnessSteer } from "../steer-marker.js"
import { survivingSteerNames } from "../steer-survival.js"
import type { SkillManager } from "./skill-manager.js"
import {
	buildTriggerRegistry,
	isModelInvocationDisabled,
	matchPrompt,
	parseSkillCommand,
	requiresResource,
	type SkillTriggerSource,
} from "./skill-triggers.js"
import { formatSkillViewResult } from "./tool.js"
import type { UsageTracker } from "./usage.js"

const MAX_PROMPT_CHARS = 32 * 1024

export const SKILL_AUTOLOAD_BODY_TYPE = "skill_autoload"
export const SKILL_AUTOLOAD_LOADED_TYPE = "skill_autoload_loaded"

export interface SkillAutoLoadData {
	name: string
	/** Winning regex source, for later false-positive analysis. */
	pattern: string
	turnIndex: number
}

interface InjectedSkill {
	pattern: string
	turnIndex: number
}

interface SessionAutoLoad {
	/** False once session_shutdown fired; in-flight async paths bail. */
	active: boolean
	/** Skills never to auto-load again this session (injected or manually
	 *  loaded through skill_view). */
	suppressed: Set<string>
	/** Injected skills keyed for compaction re-steer. */
	injected: Map<string, InjectedSkill>
	/** Turns completed in this session. The injection lands in the upcoming
	 *  run's turn: `input` fires before turn_start and pi resets the turn
	 *  index at agent start, so the entry's turnIndex is derived from
	 *  completed turns, not the previous run's last turn_start. */
	turnsCompleted: number
	registry?: Map<string, RegExp[]>
	/** In-flight registry build, so concurrent builders dedupe. */
	building?: Promise<Map<string, RegExp[]>>
}

/** Narrow seams keep tests free of SkillManager/UsageTracker plumbing. */
export type SkillViewProvider = Pick<SkillManager, "view" | "listInventory">
export type SkillUseBump = Pick<UsageTracker, "bumpUse">

export interface SkillAutoLoadOptions {
	tracker?: SkillUseBump
	/** Resource-toggle probe for `requires-resource` gating; injectable so
	 *  tests don't touch the org-policy store. Defaults to the store. */
	isResourceEnabled?: (id: string) => boolean
}

interface SteerDetails {
	name: string
	reason?: string
}

export function createSkillAutoLoader(
	pi: ExtensionAPI,
	manager: SkillViewProvider,
	options: SkillAutoLoadOptions = {},
): void {
	const sessions = new Map<string, SessionAutoLoad>()
	const resourceEnabled = options.isResourceEnabled ?? isResourceEnabled

	function sessionState(sessionId: string): SessionAutoLoad {
		let state = sessions.get(sessionId)
		if (!state) {
			state = { active: true, suppressed: new Set(), injected: new Map(), turnsCompleted: 0 }
			sessions.set(sessionId, state)
		}
		return state
	}

	async function buildRegistry(): Promise<Map<string, RegExp[]>> {
		const sources: SkillTriggerSource[] = []
		const seen = new Set<string>()
		// Harness + bundled tiers only (scope note in the module header). The
		// build is best-effort per skill: one unreadable skill must not
		// disable auto-load for the rest.
		let inventory: Awaited<ReturnType<SkillViewProvider["listInventory"]>>
		try {
			inventory = await manager.listInventory()
		} catch (err) {
			console.warn(`[skill-autoload] inventory scan failed, triggers skipped: ${String(err)}`)
			return buildTriggerRegistry(sources)
		}
		for (const entry of inventory) {
			if (seen.has(entry.name)) continue
			seen.add(entry.name)
			try {
				const result = await manager.view(entry.name)
				if (!result.success || !result.content) continue
				// A skill gated behind a disabled resource toggle (user- or org-
				// forced off) never auto-loads — the same consent semantics the
				// prompt catalog enforces (resolve-skill-roots.ts).
				const required = requiresResource(result.content)
				if (required && !resourceEnabled(required)) continue
				// `disable-model-invocation: true` skills are user-facing only:
				// pi keeps them out of the model's prompt catalog, so auto-load
				// must not push their bodies at the model either.
				if (isModelInvocationDisabled(result.content)) continue
				sources.push({ name: entry.name, content: result.content })
			} catch {
				// skip unreadable skill
			}
		}
		return buildTriggerRegistry(sources)
	}

	function ensureRegistry(state: SessionAutoLoad): Promise<Map<string, RegExp[]>> {
		if (state.registry) return Promise.resolve(state.registry)
		if (!state.building) {
			state.building = buildRegistry()
				.then((registry) => {
					state.registry = registry
					return registry
				})
				.finally(() => {
					state.building = undefined
				})
		}
		return state.building
	}

	/**
	 * Load and steer a skill. Marks it suppressed synchronously (before the
	 * first await) so concurrent input/compaction paths dedupe; on a failed
	 * view the mark is rolled back so a later match can retry. Callers must
	 * hold the session state and pass turn metadata for the appended entry.
	 */
	async function deliver(
		state: SessionAutoLoad,
		name: string,
		meta: { pattern: string; reason?: string },
	): Promise<void> {
		state.suppressed.add(name)
		const result = await manager.view(name)
		if (!state.active) return
		if (!result.success || !result.content) {
			state.suppressed.delete(name)
			return
		}
		state.injected.set(name, { pattern: meta.pattern, turnIndex: state.turnsCompleted })
		// Header interpolates the pattern source, which could itself contain
		// the closing marker — escape it alongside the body.
		const header = meta.reason
			? `Skill "${name}" is back in context after compaction (originally auto-loaded on /${escapeClosingMarker(meta.pattern)}/). Its instructions follow and still apply.`
			: `Skill "${name}" was auto-loaded because the prompt matched its declared trigger (/${escapeClosingMarker(meta.pattern)}/). Its full instructions follow — they are already loaded for this session, so use them directly instead of calling skill_view("${name}").`
		pi.sendMessage(
			{
				customType: SKILL_AUTOLOAD_BODY_TYPE,
				// Neutralize a literal closing marker inside the body: the steer is
				// delivered as a user-role message wrapped in <system-reminder>, and
				// an early close would let trailing body text read as a genuine user
				// prompt. Harness-authored skills are trusted, but the harness dir is
				// user-editable — escape anyway.
				content: markHarnessSteer(`${header}\n\n${escapeClosingMarker(formatSkillViewResult(result))}`),
				display: false,
				details: { name, ...(meta.reason ? { reason: meta.reason } : {}) } satisfies SteerDetails,
			},
			{ deliverAs: "steer" },
		)
		if (!meta.reason) {
			pi.appendEntry<SkillAutoLoadData>(SKILL_AUTOLOAD_LOADED_TYPE, {
				name,
				pattern: meta.pattern,
				turnIndex: state.turnsCompleted,
			})
			try {
				await options.tracker?.bumpUse(name)
			} catch {
				// usage stats are best-effort
			}
		}
	}

	pi.on("turn_end", (_event, ctx: ExtensionContext) => {
		const state = sessions.get(ctx.sessionManager.getSessionId())
		if (state) state.turnsCompleted += 1
	})

	pi.on("input", async (event, ctx: ExtensionContext) => {
		// Extension-sourced input (subagent task briefs, sent messages) never
		// triggers auto-load — the mechanism keys on the human's prompt text.
		if (event.source === "extension") return
		if (typeof event.text !== "string" || event.text.length === 0) return
		const state = sessionState(ctx.sessionManager.getSessionId())
		// A skill the user invoked explicitly (/skill:<name>, or the ACP
		// server's "Invoking skill: <name>" rewrite) is already loaded for this
		// turn — never auto-load it on top. For pi's raw command form the args
		// remain the user's prompt and still trigger-match; the ACP rewrite
		// embeds the skill body, so it is not matched at all (the body can name
		// other skills' file extensions).
		let matchSource: string | undefined = event.text
		const invoked = parseSkillCommand(event.text)
		if (invoked) {
			state.suppressed.add(invoked.name)
			matchSource = invoked.matchText
		}
		if (matchSource === undefined) return
		const registry = await ensureRegistry(state)
		if (!state.active) return
		// Very long pastes are capped: skill bodies are large enough that a
		// megabyte of prompt never needs trigger matching on its tail.
		const text = matchSource.length > MAX_PROMPT_CHARS ? matchSource.slice(0, MAX_PROMPT_CHARS) : matchSource
		for (const hit of matchPrompt(registry, text)) {
			if (state.suppressed.has(hit.name)) continue
			await deliver(state, hit.name, { pattern: hit.pattern })
		}
	})

	// A skill the model loads itself through skill_view is suppressed from
	// auto-load for the rest of the session. Recorded on tool_call (before
	// execution) for simplicity: a failed skill_view also suppresses, which is
	// acceptable — the model already took the hint and acted on it.
	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		if (event.toolName !== "skill_view") return
		const input = event.input as { name?: unknown }
		if (typeof input.name !== "string") return
		sessionState(ctx.sessionManager.getSessionId()).suppressed.add(input.name)
	})

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()
		const state = sessions.get(sessionId)
		// Scope teardown to the shutting-down session: mark first so in-flight
		// async deliveries bail at their next await, then forget the state.
		if (state) state.active = false
		sessions.delete(sessionId)
	})

	// Compaction re-steer: a steer folded into the summary stops being
	// actionable — re-send it, mirroring the behaviours wiring contract.
	// Steers inside the keep-recent window survive verbatim and must NOT be
	// duplicated (registerCompactionResteer, below).
	registerCompactionResteer(pi, sessions, deliver)
}

function registerCompactionResteer(
	pi: ExtensionAPI,
	sessions: Map<string, SessionAutoLoad>,
	deliver: (state: SessionAutoLoad, name: string, meta: { pattern: string; reason?: string }) => Promise<void>,
): void {
	pi.on("session_compact", async (event, ctx: ExtensionContext) => {
		const state = sessions.get(ctx.sessionManager.getSessionId())
		if (!state || state.injected.size === 0) return
		const keptNames = survivingSteerNames(event, ctx, SKILL_AUTOLOAD_BODY_TYPE)
		for (const [name, meta] of state.injected) {
			if (keptNames?.has(name)) continue
			await deliver(state, name, { pattern: meta.pattern, reason: "compaction" })
		}
	})
}
