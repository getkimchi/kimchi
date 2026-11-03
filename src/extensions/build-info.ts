/**
 * Records which harness build produced a session: one `kimchi_build` entry per
 * `session_start`. The entry's contract (fields, channels, how source runs are
 * detected) is documented in docs/session-build-entry.md.
 *
 * Source runs are detected from where this module lives, not from
 * `PI_PACKAGE_DIR`/`getVersion()`: `entry.ts` may point the package dir at an
 * installed release's share dir when the checkout lacks built resources, and
 * `getVersion()` then reports that release's version.
 *
 * Build info is resolved once per process, off the session_start path: the
 * entry is appended when git answers, so session startup never waits on git.
 */

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getVersion } from "../utils.js"
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

/** Root of the tree this module was loaded from: the repo root for source runs; inside the bundle for binaries. */
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** `dev` when `sourceRoot` is a kimchi source checkout (unreleased placeholder version), else the reported version. */
export function detectVersion(sourceRoot: string, reportedVersion: string): string {
	try {
		const pkg = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8")) as {
			name?: string
			version?: string
		}
		if (pkg.name === "@kimchi-dev/cli" && pkg.version === "0.0.0") return "dev"
	} catch {
		// No readable package.json here: a bundled binary.
	}
	return reportedVersion
}

/**
 * @param resolve produces the build info; called once per process (again only if it rejected).
 * @returns the extension, plus `settled()` — resolves once every pending append has run (for tests).
 */
export function createBuildInfoExtension(resolve: () => Promise<KimchiBuildEntry>) {
	let buildInfo: Promise<KimchiBuildEntry> | undefined
	const pending = new Set<Promise<void>>()

	const load = (): Promise<KimchiBuildEntry> => {
		buildInfo ??= resolve().catch((err: unknown) => {
			buildInfo = undefined // a failure must not be cached for the rest of the process
			throw err
		})
		return buildInfo
	}

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
	}

	return Object.assign(extension, { settled: () => Promise.all([...pending]).then(() => undefined) })
}

export default createBuildInfoExtension(() =>
	resolveBuildInfo(detectVersion(SOURCE_ROOT, getVersion()), SOURCE_ROOT, runGit),
)
