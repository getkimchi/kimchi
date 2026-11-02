import type { AvailableCommand } from "@agentclientprotocol/sdk"
import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent"

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

/** Minimal session surface the refresher's skill refresh needs. */
interface SkillRefreshLoader extends ResourceLoader {
	/** Provided by AcpSessionResourceLoader (see session-resource-loader.ts):
	 *  a resources-only discovery pass that never re-runs extension factories.
	 *  "discarded" means the pass lost its race with a full reload or the
	 *  session's disposal — nothing was committed. */
	refreshSkills: (session: AgentSession) => Promise<"committed" | "discarded">
}

/**
 * Rescan the session's skills WITHOUT reloading extensions. The session's
 * loader must be the ACP adapter (AcpSessionResourceLoader) — its
 * refreshSkills runs a resources-only discovery pass (bundled, configured,
 * project, and Claude sources via the same cwd/agentDir/trusted settings,
 * plus the live runner's resources_discover contributions staged through
 * the public extendResources) and commits the new snapshot only when the
 * pass succeeds, so a failed rescan keeps the previous palette. The old
 * flow called session.resourceLoader.reload() — a full reload that
 * re-ran every inline extension factory (another MCP adapter, watcher,
 * and lifecycle) just to re-read a directory listing.
 */
export async function reloadSkillCommandsMap(session: AgentSession): Promise<Map<string, AcpSkillInfo>> {
	const loader = session.resourceLoader as unknown as SkillRefreshLoader
	if (typeof loader.refreshSkills !== "function") {
		throw new TypeError("session resourceLoader has no refreshSkills (ACP adapter wiring drift?)")
	}
	const outcome = await loader.refreshSkills(session)
	if (outcome === "discarded") {
		// The pass lost its race (full reload / session disposal): nothing was
		// committed — keep the previous palette and prompt untouched.
		return discoverSkillCommandsMap(session)
	}
	// The snapshot is committed: drop any cached system-prompt skill-list block
	// and rebuild the prompt options against it — a prompt rebuild that raced
	// the refresh cannot permanently re-cache stale content (nothing later
	// would invalidate it: trust decisions are not filesystem events the
	// watcher can observe). Rebuilding goes through the public
	// setActiveToolsByName with the SAME active list: prompt options only,
	// no runner or tool-set change during an active turn.
	invalidateSkillListBlock(session.resourceLoader)
	session.setActiveToolsByName(session.getActiveToolNames())
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
			// Record the reloaded palette unconditionally; the equality check
			// only controls whether to send the notification. Skipping the
			// assignment on equal palettes would drop fields outside the
			// advertised-content comparison (e.g. filePath after a skill move
			// or shadowing).
			const prev = record.skillCommands
			record.skillCommands = fresh
			if (skillCommandsEqual(prev, fresh)) continue
			try {
				opts.broadcast(sessionId)
			} catch (err) {
				// A broadcast failure reverts the palette so a later sweep
				// retries the notification — otherwise the committed fresh
				// palette makes every subsequent sweep exit early at the
				// equality check and the notification is never retried.
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
