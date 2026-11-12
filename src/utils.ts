import { execFile, execSync } from "node:child_process"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** The working tree's answer, read from .git/HEAD without spawning Git. */
interface HeadBranch {
	/** True when the branch is known exactly; false when Git itself must be asked. */
	confident: true
	branch: string | undefined
}

/**
 * Reads the branch name from the nearest .git/HEAD. Spawning Git from a large process
 * blocks the event loop that renders the TUI, so the common case — a .git directory or
 * worktree pointer with a symbolic HEAD — must not launch a child process. Unusual
 * layouts return `{ confident: false }` so the caller can fall back to Git.
 */
function readHeadBranch(cwd: string): HeadBranch | { confident: false } {
	try {
		let directory = realpathSync(resolve(cwd))
		for (;;) {
			const gitPath = join(directory, ".git")
			const stats = lstatSync(gitPath, { throwIfNoEntry: false })
			if (stats) {
				let gitDirectory = gitPath
				if (stats.isFile()) {
					// A linked worktree keeps a `gitdir: <path>` pointer instead of the directory.
					const pointer = readFileSync(gitPath, "utf8").trim()
					if (!pointer.startsWith("gitdir:")) return { confident: false }
					gitDirectory = resolve(directory, pointer.slice("gitdir:".length).trim())
				}
				// The reftable backend stores the real HEAD in its tables and leaves a spec-mandated
				// `ref: refs/heads/.invalid` stub on disk, which would parse below as a confident
				// branch. The backend's marker file is present in the repository and in each linked
				// worktree's git directory; when found, only Git can answer.
				if (lstatSync(join(gitDirectory, "reftable", "tables.list"), { throwIfNoEntry: false })) {
					return { confident: false }
				}
				const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim()
				const ref = /^ref: (.+)$/.exec(head)
				// A ref outside refs/heads/ has no short form worth guessing; ask Git.
				if (!ref) return { confident: true, branch: undefined }
				if (!ref[1].startsWith("refs/heads/")) return { confident: false }
				return { confident: true, branch: ref[1].slice("refs/heads/".length) || undefined }
			}
			const parent = dirname(directory)
			if (parent === directory) return { confident: false }
			directory = parent
		}
	} catch {
		return { confident: false }
	}
}

export function refreshGitBranch(onResult: (branch: string | undefined) => void, cwd?: string): void {
	const directory = cwd ?? process.cwd()
	// Variables that redirect or constrain repository discovery keep Git as the authority:
	// the direct walk-up cannot see them, so its confident answer could diverge from git's.
	const redirected =
		process.env.GIT_DIR ||
		process.env.GIT_WORK_TREE ||
		process.env.GIT_COMMON_DIR ||
		process.env.GIT_CEILING_DIRECTORIES ||
		process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM
	const direct = redirected ? ({ confident: false } as const) : readHeadBranch(directory)
	if (direct.confident) {
		onResult(direct.branch)
		return
	}
	// Detached layouts and environments like GIT_DIR keep Git as the authority.
	execFile(
		"git",
		["symbolic-ref", "--short", "HEAD"],
		{
			cwd: directory,
			encoding: "utf8",
			timeout: 500,
		},
		(err, stdout) => {
			onResult(err ? undefined : stdout.trim() || undefined)
		},
	)
}

export function getGitBranch(cwd?: string): string | undefined {
	try {
		return (
			execSync("git symbolic-ref --short HEAD", {
				cwd: cwd ?? process.cwd(),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		)
	} catch {
		return undefined
	}
}

export function getFolder(): string {
	const cwd = process.cwd()
	const home = homedir()
	if (cwd === home) return "~"
	if (cwd.startsWith(home + sep)) return `~${cwd.slice(home.length)}`
	return cwd
}

let cachedVersion: string | undefined
export function getVersion(): string {
	if (cachedVersion !== undefined) return cachedVersion
	try {
		const pkgDir = process.env.PI_PACKAGE_DIR
		const pkgPath = pkgDir
			? resolve(pkgDir, "package.json")
			: resolve(dirname(fileURLToPath(import.meta.url)), "../package.json")
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
		let version = pkg.version ?? "unknown"
		// When the version field is the development placeholder (0.0.0)
		// report a simple "dev" string so that the transform backend does
		// not have to deal with stale/partial git-describe noise.
		if (version === "0.0.0") {
			version = "dev"
		}
		cachedVersion = version
	} catch {
		cachedVersion = "unknown"
	}
	return cachedVersion ?? "unknown"
}

/** Root of the tree this module was loaded from: the repo root for source runs; inside the bundle for binaries. */
export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** `dev` when `sourceRoot` is a kimchi source checkout (unreleased placeholder version), else the reported version. */
export function detectVersion(sourceRoot: string, reportedVersion: string): string {
	try {
		const pkg = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8")) as {
			name?: string
			version?: string
		}
		// The placeholder version is load-bearing: real versions are stamped at
		// build time in CI (canary as 0.0.0-canary.<date>.<sha>, releases from the
		// tag via scripts/set-version.js), so the in-tree package.json must stay
		// 0.0.0. A committed bump would silently classify every source run from
		// that tree as a release — losing commit/branch/dirty and naming a version
		// whose tag may not exist.
		if (pkg.name === "@kimchi-dev/cli" && pkg.version === "0.0.0") return "dev"
	} catch {
		// No readable package.json here: a bundled binary.
	}
	return reportedVersion
}

let cachedDetectedVersion: string | undefined

/**
 * `getVersion()` with source-run detection applied: a run from a kimchi source checkout
 * reports `dev` even when `PI_PACKAGE_DIR` points at an installed release's share dir
 * (which makes `getVersion()` report that release). The `kimchi_build` session entry
 * and telemetry both report this value; see docs/session-build-entry.md.
 */
export function getDetectedVersion(): string {
	cachedDetectedVersion ??= detectVersion(SOURCE_ROOT, getVersion())
	return cachedDetectedVersion
}
