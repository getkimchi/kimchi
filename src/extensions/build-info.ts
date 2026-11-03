/**
 * Records which harness build produced a session.
 *
 * Writes one `kimchi_build` entry per `session_start`, so every session (and
 * every resumed segment of one) says which kimchi it ran on. Offline trace
 * analysis needs this to tell whether an issue seen in a session is already
 * fixed on master, or has come back after a fix.
 *
 * - release builds: the version is the release tag (`1.27.0` ↔ `v1.27.0`);
 * - canary builds: the version embeds the commit (`0.0.0-canary.<date>.<sha>`);
 * - dev runs (kimchi executed from a source checkout, e.g. `pnpm run dev`):
 *   version `dev`; commit, branch and dirty state are read from that checkout —
 *   the harness checkout, not the session's project.
 *
 * Source runs are detected from where this module lives, not from
 * `PI_PACKAGE_DIR`/`getVersion()`: `entry.ts` may point the package dir at an
 * installed release's share dir when the checkout lacks built resources, and
 * `getVersion()` then reports that release's version.
 *
 * Build info is resolved once per process and never blocks or fails a session.
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
	/** Version as reported by `kimchi --version` (`dev` for source runs). */
	version: string
	channel: BuildChannel
	/** Full commit for dev runs; the abbreviated canary commit for canaries; absent for releases (use the tag). */
	commit?: string
	/** Dev runs only; absent when HEAD is detached. */
	branch?: string
	/** Dev runs only: tracked files differ from the commit. */
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

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
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
		optional(() => git(["rev-parse", "HEAD"], dir)),
		optional(() => git(["rev-parse", "--abbrev-ref", "HEAD"], dir)),
		optional(() => git(["status", "--porcelain", "--untracked-files=no"], dir)),
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

/** Git pinned to `cwd`: GIT_* redirection in the user's environment must not point it at another repository. */
export const runGit: GitRunner = async (args, cwd) => {
	const { GIT_DIR: _dir, GIT_COMMON_DIR: _common, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env
	const { stdout } = await execFileAsync("git", args, { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024 })
	return stdout
}

/** Root of the tree this module was loaded from: the repo root for source runs; inside the bundle for binaries. */
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** `dev` when `sourceRoot` is a kimchi source checkout (unreleased placeholder version), else the reported version. */
export function detectVersion(sourceRoot: string, reportedVersion: () => string): string {
	try {
		const pkg = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8")) as {
			name?: string
			version?: string
		}
		if (pkg.name === "@kimchi-dev/cli" && pkg.version === "0.0.0") return "dev"
	} catch {
		// No readable package.json here: a bundled binary.
	}
	return reportedVersion()
}

export interface BuildInfoDeps {
	resolve(): Promise<KimchiBuildEntry>
}

export function createBuildInfoExtension(deps: BuildInfoDeps) {
	return (pi: ExtensionAPI): void => {
		let buildInfo: Promise<KimchiBuildEntry> | undefined

		pi.on("session_start", async () => {
			buildInfo ??= deps.resolve()
			const entry = await buildInfo
			try {
				pi.appendEntry(KIMCHI_BUILD_ENTRY_TYPE, entry)
			} catch (err) {
				// The session was replaced while git was answering; its successor gets its own session_start.
				if (!isStaleCtxError(err)) throw err
			}
		})
	}
}

export default createBuildInfoExtension({
	resolve: () => resolveBuildInfo(detectVersion(SOURCE_ROOT, getVersion), SOURCE_ROOT, runGit),
})
