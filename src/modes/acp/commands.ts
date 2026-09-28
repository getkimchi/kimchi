import type { AvailableCommand } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

import { SLASH_COMMANDS } from "../../extensions/slash-commands.js"
import {
	type AcpSkillInfo,
	buildSkillAvailableCommands,
	discoverAcpSkillCommands,
	invalidateSkillListBlock,
} from "./skill-commands.js"

export const CAPABILITIES_KEY = "kimchi.dev"

type AcpAvailableCommand = AvailableCommand & {
	name: keyof typeof SLASH_COMMANDS
}

export const AVAILABLE_COMMANDS: AcpAvailableCommand[] = [
	{
		name: "bug",
		description: SLASH_COMMANDS.bug.hint,
		input: {
			hint: "Provide a concise title (3-5 words) to describe the issue.",
		},
	},
]

/** Full session palette: static commands first, then skill commands. */
export function composeAvailableCommands(skillCommands: ReadonlyMap<string, AcpSkillInfo>): AvailableCommand[] {
	return [...AVAILABLE_COMMANDS, ...buildSkillAvailableCommands(Array.from(skillCommands.values()))]
}

/** Snapshot the loader's current skills without rescanning (session setup). */
export function discoverSkillCommandsMap(session: AgentSession): Map<string, AcpSkillInfo> {
	return new Map(discoverAcpSkillCommands(session.resourceLoader).map((s) => [s.name, s]))
}

/**
 * Rescan the session's skills. The loader's own reload() drops extension-
 * contributed resources (bundled/project/configured/Claude skills), so the
 * private extendResourcesFromExtensions re-derives them afterwards — the
 * same step bindExtensions() runs after session_start (upstream:
 * packages/coding-agent/src/core/agent-session.ts). The check below fails
 * loudly if upstream renames it; drop the cast once a public refresh API
 * exists.
 */
export async function reloadSkillCommandsMap(session: AgentSession): Promise<Map<string, AcpSkillInfo>> {
	await session.resourceLoader.reload()
	const refreshable = session as unknown as Record<string, unknown>
	if (typeof refreshable.extendResourcesFromExtensions !== "function") {
		throw new TypeError("AgentSession.extendResourcesFromExtensions missing (upstream pi rename?)")
	}
	await (refreshable.extendResourcesFromExtensions as (reason: "reload") => Promise<void>).call(session, "reload")
	// The loader's skill set is now fresh: drop any cached system-prompt
	// skill-list block HERE — after the reload, not before requesting it — so
	// a prompt rebuild that raced the reload cannot permanently re-cache
	// stale content (nothing later would invalidate it: trust decisions are
	// not filesystem events the watcher can observe). This also keeps
	// watcher-driven skill uploads from leaving a stale block behind.
	invalidateSkillListBlock(session.resourceLoader)
	return discoverSkillCommandsMap(session)
}

/** Minimal session surface the refresher needs (satisfied by SessionRecord). */
export interface CommandsRefreshSession {
	session: AgentSession
	skillCommands: Map<string, AcpSkillInfo>
}

export interface CommandsRefresher {
	/** Kick a refresh sweep. Coalesces repeated kicks within the debounce window. */
	request(): void
	/** Drop any pending sweep (connection shutdown). */
	cancel(): void
}

// Debounce window for the sweep: a skills change can fire in bursts (e.g.
// multi-skill uploads), and each sweep reloads every session's loader.
// Shared with the skill watcher so event coalescing and the sweep land in
// the same window.
export const REFRESH_DEBOUNCE_MS = 250

/** Advertised-content equality: names + descriptions of the skill commands. */
export function skillCommandsEqual(
	a: ReadonlyMap<string, AcpSkillInfo>,
	b: ReadonlyMap<string, AcpSkillInfo>,
): boolean {
	if (a.size !== b.size) return false
	for (const [name, prev] of a) {
		const next = b.get(name)
		if (!next || next.description !== prev.description) return false
	}
	return true
}

/**
 * Re-advertise every session's palette after the skills set changes. Each
 * session reloads its own loader (keeping project-local shadowing intact),
 * then `broadcast` re-emits its available_commands_update; sessions whose
 * reload fails keep their stale palette. The reloaded palette is recorded
 * even when nothing is re-broadcast, so non-advertised fields (filePath)
 * stay current; a broadcast that throws reverts the palette so the next
 * sweep retries the notification. Sessions whose palette survived the
 * reload unchanged are not re-broadcast: fs watchers emit deletion/rewrite
 * bursts as several events spread over hundreds of ms, so one deliberate
 * change can kick several sweeps — only the first has anything new to say.
 */
export function createCommandsRefresher(opts: {
	sessions: () => Iterable<[string, CommandsRefreshSession]>
	broadcast: (sessionId: string) => void
	debounceMs?: number
}): CommandsRefresher {
	let timer: ReturnType<typeof setTimeout> | undefined
	let sweeping = false
	let pending = false
	let cancelled = false

	const sweep = async (): Promise<void> => {
		// Snapshot so sessions created mid-sweep (already holding a fresh
		// palette from session setup) aren't reloaded redundantly.
		for (const [sessionId, record] of Array.from(opts.sessions())) {
			if (cancelled) return
			let fresh: Map<string, AcpSkillInfo>
			try {
				fresh = await reloadSkillCommandsMap(record.session)
			} catch (err) {
				const msg = `acp refresh_available_commands: reload failed for session ${sessionId}: ${String(err)}\n`
				process.stderr.write(msg)
				continue
			}
			if (cancelled) return
			// Record the reloaded palette unconditionally — the equality check
			// gates only the notification. Skipping the assignment on equal
			// palettes would drop fields outside the advertised-content
			// comparison (e.g. filePath after a skill move or shadowing).
			const prev = record.skillCommands
			record.skillCommands = fresh
			if (skillCommandsEqual(prev, fresh)) continue
			try {
				opts.broadcast(sessionId)
			} catch (err) {
				// A broadcast failure reverts the palette so a later sweep
				// retries the notification — otherwise the committed fresh
				// palette makes every subsequent sweep short-circuit at the
				// equality check and the client stays out of sync forever.
				record.skillCommands = prev
				throw err
			}
		}
	}

	// Serializes sweeps: a kick while one is in flight schedules exactly one
	// follow-up, so overlapping reload() calls on the same loader can't race
	// to assign record.skillCommands.
	const run = async (): Promise<void> => {
		sweeping = true
		try {
			do {
				pending = false
				await sweep()
			} while (pending && !cancelled)
		} catch (err) {
			// A sweep escape (e.g. broadcast or sessions() throwing) must not
			// wedge the refresher: without the finally, sweeping would stay true
			// for the connection's lifetime and palettes would silently stop.
			process.stderr.write(`acp refresh_available_commands: sweep failed: ${String(err)}\n`)
		} finally {
			sweeping = false
		}
	}

	return {
		request() {
			if (cancelled) return
			if (sweeping) {
				pending = true
				return
			}
			if (timer !== undefined) return
			timer = setTimeout(() => {
				timer = undefined
				void run()
			}, opts.debounceMs ?? REFRESH_DEBOUNCE_MS)
		},
		cancel() {
			cancelled = true
			if (timer !== undefined) {
				clearTimeout(timer)
				timer = undefined
			}
		},
	}
}
