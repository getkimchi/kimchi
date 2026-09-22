import { type FSWatcher, watch } from "chokidar"

import { resolveSkillRoots } from "../../shared/skill-discovery/resolve-skill-roots.js"

/** Minimal session surface the watcher needs (satisfied by SessionRecord). */
export interface SkillWatchSession {
	cwd: string
}

export interface SkillWatcher {
	/** Register a session and start watching its skill roots. */
	addSession(session: SkillWatchSession): void
	/** Deregister a session; roots shared with other cwds stay watched. */
	removeSession(session: SkillWatchSession): void
	/** Close all watches (connection shutdown). */
	close(): void
}

/**
 * Skill roots to watch for one session: the central resolver answers which
 * dirs the session's skills actually come from (bundled, harness, agent,
 * config, project — trust-gated). No conventions are re-derived here.
 *
 * Known limit: a *brand-new* project skills dir in a project that had none
 * is filtered out by the resolver and only starts being watched once any
 * other change (or a session restart) re-runs this computation.
 */
function sessionSkillRoots(cwd: string, opts: { agentDir: string; extraPaths: readonly string[] }): string[] {
	return resolveSkillRoots({ cwd, agentDir: opts.agentDir, extraPaths: opts.extraPaths }).map((r) => r.dir)
}

/**
 * Watches skill roots on disk and requests a palette re-advertisement when
 * they change (skill upload/edit/delete). chokidar tolerates roots that do
 * not exist yet and reports cross-platform; the refresher's own debounce
 * absorbs burst events. One pass per change refreshes every session — each
 * reloads its own loader, so project-local shadowing stays correct.
 *
 * Watched roots are re-derived on every change event, so roots that appear
 * later (a skills dir created, trust granted) converge without bookkeeping.
 * Roots themselves are never removed until close(): contiguous sessions over
 * a connection's lifetime tend to share roots, and unwatching+rewatching a
 * dir costs more than leaving it watched briefly.
 */
export function createSkillWatcher(opts: {
	agentDir: string
	/** Kimchi-config skillPaths, read per change event so config edits are picked up. */
	getExtraSkillPaths?: () => string[]
	requestRefresh: () => void
}): SkillWatcher {
	let watcher: FSWatcher | undefined
	const watched = new Set<string>()
	const sessions = new Map<string, number>()
	const extraPaths = (): readonly string[] => opts.getExtraSkillPaths?.() ?? []

	const add = (roots: string[]): void => {
		const fresh = roots.filter((r) => !watched.has(r))
		if (fresh.length === 0) return
		for (const r of fresh) watched.add(r)
		ensure().add(fresh)
	}

	const refreshRoots = (): void => {
		for (const cwd of sessions.keys())
			add(sessionSkillRoots(cwd, { agentDir: opts.agentDir, extraPaths: extraPaths() }))
	}

	const ensure = (): FSWatcher => {
		if (!watcher) {
			// ignoreInitial: false on purpose — with true, a skills dir created
			// during chokidar's initial scan is swallowed as "initial" and the
			// very first upload on a fresh tree would never be seen. Initial
			// add events are absorbed by the refresher's debounce (a startup
			// sweep with no sessions is a no-op anyway).
			watcher = watch([], {
				ignoreInitial: false,
				// <root>/<name>/SKILL.md is two levels below a watched root.
				depth: 2,
			})
			watcher.on("all", () => {
				refreshRoots()
				opts.requestRefresh()
			})
			watcher.on("error", (err) => process.stderr.write(`acp skill watcher: ${String(err)}\n`))
		}
		return watcher
	}

	return {
		addSession(session: SkillWatchSession): void {
			const refs = sessions.get(session.cwd) ?? 0
			sessions.set(session.cwd, refs + 1)
			if (refs === 0) {
				add(sessionSkillRoots(session.cwd, { agentDir: opts.agentDir, extraPaths: extraPaths() }))
			}
		},
		removeSession(session: SkillWatchSession): void {
			const refs = sessions.get(session.cwd) ?? 0
			if (refs <= 1) sessions.delete(session.cwd)
			else sessions.set(session.cwd, refs - 1)
		},
		close(): void {
			void watcher?.close()
			watcher = undefined
			watched.clear()
			sessions.clear()
		},
	}
}
