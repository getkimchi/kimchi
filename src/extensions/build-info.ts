/**
 * Records which harness build produced a session: one `kimchi_build` entry per
 * `session_start`. The entry's contract (fields, channels, how source runs are
 * detected) is documented in docs/session-build-entry.md.
 *
 * Source-run detection lives in `src/utils.ts` (`detectVersion`/`getDetectedVersion`):
 * it looks at where the code is loaded from, not at `PI_PACKAGE_DIR`/`getVersion()` —
 * `entry.ts` may point the package dir at an installed release's share dir when the
 * checkout lacks built resources, and `getVersion()` then reports that release's
 * version. The entry records `dev` in that case.
 *
 * Build info is resolved once per process, off the session_start path: the
 * entry is appended when git answers, so session startup never waits on git.
 * A session_shutdown handler holds the shutdown until pending appends settle,
 * so a short-lived session (the ACP server disposes sessions after the
 * awaited shutdown) still gets its entry. A partial entry (a git read failed)
 * is appended but not cached — the next session_start retries git.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getDetectedVersion, SOURCE_ROOT } from "../utils.js"
import { isStaleCtxError } from "./stale-ctx.js"

export const KIMCHI_BUILD_ENTRY_TYPE = "kimchi_build"
export const KIMCHI_BUILD_SCHEMA_VERSION = 1

export type BuildChannel = "release" | "canary" | "dev" | "unknown"

export interface KimchiBuildEntry {
	schemaVersion: typeof KIMCHI_BUILD_SCHEMA_VERSION
	version: string
	channel: BuildChannel
	commit?: string
	branch?: string
	dirty?: boolean
}

/** Runs git with `args` in `cwd` and returns stdout. Rejects on failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>

const CANARY_VERSION = /^0\.0\.0-canary\.\d+\.([0-9a-f]{7,40})$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export function classifyVersion(version: string): { channel: BuildChannel; commit?: string } {
	if (version === "dev") return { channel: "dev" }
	const canary = CANARY_VERSION.exec(version)
	if (canary) return { channel: "canary", commit: canary[1] }
	if (version.includes("-canary.")) return { channel: "unknown" }
	if (SEMVER.test(version)) return { channel: "release" }
	return { channel: "unknown" }
}

/** Runs a git read; a failure yields `undefined` so that field is simply left out. */
async function bestEffort<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read()
	} catch {
		return undefined
	}
}

/** Reads commit, branch and dirty state of the checkout at `dir`; each field is omitted when git can't answer. */
export async function readGitState(
	dir: string,
	git: GitRunner,
): Promise<Pick<KimchiBuildEntry, "commit" | "branch" | "dirty">> {
	const [commit, branch, status] = await Promise.all([
		bestEffort(() => git(["rev-parse", "HEAD"], dir)),
		bestEffort(() => git(["rev-parse", "--abbrev-ref", "HEAD"], dir)),
		bestEffort(() => git(["status", "--porcelain", "--untracked-files=no"], dir)),
	])
	const state: Pick<KimchiBuildEntry, "commit" | "branch" | "dirty"> = {}
	if (commit) state.commit = commit.trim()
	const branchName = branch?.trim()
	if (branchName && branchName !== "HEAD") state.branch = branchName
	if (status !== undefined) state.dirty = status.trim().length > 0
	return state
}

export async function resolveBuildInfo(version: string, packageDir: string, git: GitRunner): Promise<KimchiBuildEntry> {
	const { channel, commit } = classifyVersion(version)
	const entry: KimchiBuildEntry = { schemaVersion: KIMCHI_BUILD_SCHEMA_VERSION, version, channel }
	if (commit) entry.commit = commit
	if (channel === "dev") Object.assign(entry, await readGitState(packageDir, git))
	return entry
}

const execFileAsync = promisify(execFile)

/** The environment without any `GIT_*` variable, so nothing in the user's environment redirects git. */
export function gitFreeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")))
}

/** Git pinned to `cwd`: no `GIT_*` variable (GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_CONFIG, …) can point it elsewhere. */
export const runGit: GitRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: gitFreeEnv(process.env),
		timeout: 2000,
		maxBuffer: 1024 * 1024,
	})
	return stdout
}

/**
 * @param resolve produces the build info; called once per process (again when it rejects or yields a partial entry).
 * @returns the extension, plus `settled()` — resolves once every pending append has run (for tests).
 */
export function createBuildInfoExtension(resolve: () => Promise<KimchiBuildEntry>) {
	let buildInfo: Promise<KimchiBuildEntry> | undefined
	const pending = new Set<Promise<void>>()

	/** A complete entry is cached for the process. A dev entry missing `commit` or
	 *  `dirty` had a git read fail — that answer is transient (a missing binary, a
	 *  lock, a timeout), so it must not be cached: the next session_start retries.
	 *  A missing `branch` is legitimate (detached HEAD) and still complete. */
	const complete = (entry: KimchiBuildEntry): boolean =>
		entry.channel !== "dev" || (entry.commit !== undefined && entry.dirty !== undefined)

	const load = (): Promise<KimchiBuildEntry> => {
		if (buildInfo) return buildInfo
		const resolving = resolve().then(
			(entry) => {
				if (!complete(entry)) buildInfo = undefined // partial: retry git on the next session_start
				return entry
			},
			(err: unknown) => {
				buildInfo = undefined // a failure must not be cached for the rest of the process
				throw err
			},
		)
		buildInfo = resolving
		return resolving
	}

	const settled = (): Promise<void> => Promise.all([...pending]).then(() => undefined)

	const extension = (pi: ExtensionAPI): void => {
		// Not awaited: session_start handlers run in sequence, and startup must not wait on git.
		pi.on("session_start", () => {
			const append = load()
				.then((entry) => pi.appendEntry(KIMCHI_BUILD_ENTRY_TYPE, entry))
				.catch((err: unknown) => {
					// Stale: the session was replaced while git answered; its successor gets its own entry.
					// Anything else: the entry is best-effort and must never fail the session.
					if (!isStaleCtxError(err)) console.warn(`kimchi_build entry not recorded: ${String(err)}`)
				})
				.finally(() => pending.delete(append))
			pending.add(append)
		})
		// A short-lived session must not lose its entry to the async append: the
		// ACP server emits session_shutdown and awaits every handler before it
		// disposes the session, so holding this handler until the pending appends
		// settle (bounded by git's per-call timeout) lets the entry land while
		// the ctx is still live.
		pi.on("session_shutdown", () => settled())
	}

	return Object.assign(extension, { settled })
}

export default createBuildInfoExtension(() => resolveBuildInfo(getDetectedVersion(), SOURCE_ROOT, runGit))
