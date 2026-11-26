import { execFile, execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ReviewWorktree } from "./types.js"

export interface ReviewNetworkBoundary {
	kind: "sandbox-exec" | "bwrap" | "unshare-net"
	/** Enclose a command in its detected network boundary. The unshare-net
	 * fallback does not provide the other kinds' private-worktree write boundary. */
	wrap: (command: string, worktree: ReviewWorktree) => string
}

const MACOS_DETECTION_PROFILE = `(version 1)
(allow default)
(deny network-outbound)`
let detection: Promise<ReviewNetworkBoundary | undefined> | undefined

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

function strictlyContained(parent: string, candidate: string): boolean {
	const remainder = relative(parent, candidate)
	return remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder)
}

function gitPath(worktreePath: string, option: "--git-dir" | "--git-common-dir"): string {
	return execFileSync("git", ["-C", worktreePath, "rev-parse", option], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function linkedWorktreeGitAdminDirectory(worktreePath: string): string | undefined {
	if (!existsSync(join(worktreePath, ".git"))) return undefined
	const gitAdminDir = realpathSync(resolve(worktreePath, gitPath(worktreePath, "--git-dir")))
	const commonDir = realpathSync(resolve(worktreePath, gitPath(worktreePath, "--git-common-dir")))
	const commonWorktrees = realpathSync(join(commonDir, "worktrees"))
	if (!strictlyContained(commonWorktrees, gitAdminDir)) {
		throw new Error(`Reviewer Git admin directory ${gitAdminDir} must be inside ${commonWorktrees}.`)
	}
	return gitAdminDir
}

function privateWritePaths(worktree: ReviewWorktree): string[] {
	const gitAdminDir = linkedWorktreeGitAdminDirectory(worktree.path)
	return [
		...new Set(
			[
				worktree.path,
				worktree.scratchDir,
				worktree.buildDir,
				worktree.cacheDir,
				worktree.homeDir,
				...(gitAdminDir ? [gitAdminDir] : []),
			].map((path) => realpathSync(path)),
		),
	]
}

function linuxBoundaryArguments(worktree: ReviewWorktree, command: string): string[] {
	return [
		"bwrap",
		"--unshare-net",
		"--ro-bind",
		"/",
		"/",
		...privateWritePaths(worktree).flatMap((path) => ["--bind", path, path]),
		"--",
		"/bin/sh",
		"-c",
		command,
	]
}

export const REVIEW_NETWORK_BOUNDARY_TESTING = { linuxBoundaryArguments, detectLinuxBoundary }

function macosProfile(worktree: ReviewWorktree): string {
	const writeAllows = privateWritePaths(worktree)
		.map((path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`)
		.join("\n")
	return `${MACOS_DETECTION_PROFILE}
(deny file-write*)
(allow file-write* (literal "/dev/null"))
${writeAllows}`
}

function succeeds(command: string, args: readonly string[]): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, [...args], { timeout: 5000, env: { PATH: process.env.PATH } }, (error) => resolve(!error))
	})
}

async function detectLinuxBoundary(
	probe: (command: string, args: readonly string[]) => Promise<boolean> = succeeds,
): Promise<ReviewNetworkBoundary | undefined> {
	if (await probe("bwrap", ["--unshare-net", "--ro-bind", "/", "/", process.execPath, "--version"])) {
		return {
			kind: "bwrap",
			wrap: (command, worktree) => linuxBoundaryArguments(worktree, command).map(shellQuote).join(" "),
		}
	}
	if (await probe("unshare", ["--net", "--map-root-user", process.execPath, "--version"])) {
		return {
			kind: "unshare-net",
			wrap: (command) => `unshare --net --map-root-user -- /bin/sh -c ${shellQuote(command)}`,
		}
	}
	return undefined
}

async function detectPlatformBoundary(): Promise<ReviewNetworkBoundary | undefined> {
	if (process.platform === "darwin") {
		if (!(await succeeds("sandbox-exec", ["-p", MACOS_DETECTION_PROFILE, process.execPath, "--version"])))
			return undefined
		return {
			kind: "sandbox-exec",
			wrap: (command, worktree) =>
				`sandbox-exec -p ${shellQuote(macosProfile(worktree))} /bin/sh -c ${shellQuote(command)}`,
		}
	}
	if (process.platform === "linux") return detectLinuxBoundary()
	return undefined
}

/** Detect actual enforcement once per process. An unavailable result never
 * degrades to an environment-only "offline" execution. */
export function detectReviewNetworkBoundary(): Promise<ReviewNetworkBoundary | undefined> {
	detection ??= detectPlatformBoundary()
	return detection
}

/** Variables whose values are guaranteed by ReviewWorktree to point into the
 * reviewer's private scratch/HOME/cache directories. */
const PRIVATE_WORKTREE_VARIABLES = new Set([
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"npm_config_cache",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	"PNPM_STORE_PATH",
	"YARN_CACHE_FOLDER",
	"COREPACK_HOME",
	"GOPATH",
	"GOMODCACHE",
	"GOCACHE",
	"GOTMPDIR",
	"PIP_CACHE_DIR",
	"UV_CACHE_DIR",
	"POETRY_CACHE_DIR",
	"CARGO_HOME",
	"CARGO_TARGET_DIR",
	"GRADLE_USER_HOME",
	"COMPOSER_HOME",
	"COMPOSER_CACHE_DIR",
	"BUNDLE_PATH",
	"DENO_DIR",
	"KIMCHI_REVIEW_WORKTREE",
	"KIMCHI_REVIEW_SCRATCH_DIR",
])

/** Narrow, non-secret execution/toolchain inputs. Proxy, registry, auth,
 * arbitrary *_OPTS, and command-injection variables are deliberately omitted. */
const SAFE_VARIABLES = new Set([
	"PATH",
	"TERM",
	"LANG",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"JAVA_HOME",
	"JDK_HOME",
	"GRADLE_JAVA_HOME",
	"VIRTUAL_ENV",
	"RUSTUP_TOOLCHAIN",
	"RUSTUP_HOME",
	"GOFLAGS",
	"CI",
])

/** Build a local offline environment from a narrow allowlist, not from a
 * subtractive scrub of the invoking process. Registry/index/user-config values
 * always use fixed credential-free/public defaults or private paths. */
export function offlineEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue
		if (SAFE_VARIABLES.has(key) || key.startsWith("LC_") || PRIVATE_WORKTREE_VARIABLES.has(key)) {
			environment[key] = value
		}
	}
	environment.NPM_CONFIG_USERCONFIG = join(environment.HOME ?? base.HOME ?? "", ".npmrc")
	environment.NPM_CONFIG_GLOBALCONFIG = join(environment.HOME ?? base.HOME ?? "", ".npmrc-global")
	environment.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/"
	environment.npm_config_offline = "true"
	environment.NPM_CONFIG_OFFLINE = "true"
	environment.NPM_CONFIG_UPDATE_NOTIFIER = "false"
	environment.NPM_CONFIG_FETCH_RETRIES = "0"
	environment.NPM_CONFIG_FETCH_TIMEOUT = "1000"
	environment.YARN_ENABLE_NETWORK = "0"
	environment.BUN_CONFIG_OFFLINE = "true"
	environment.GOPROXY = "off"
	environment.GOTOOLCHAIN = "local"
	environment.GOFLAGS = `${environment.GOFLAGS ?? ""} -mod=mod`.trim()
	environment.PIP_NO_INDEX = "1"
	environment.PIP_DISABLE_PIP_VERSION_CHECK = "1"
	environment.UV_OFFLINE = "1"
	environment.UV_NO_INDEX = "1"
	environment.CARGO_NET_OFFLINE = "true"
	environment.COMPOSER_DISABLE_NETWORK = "1"
	environment.BUNDLE_ALLOW_OFFLINE_INSTALL = "true"
	environment.BUNDLE_DISABLE_VERSION_CHECK = "1"
	environment.DENO_CACHED_ONLY = "1"
	environment.GIT_CONFIG_NOSYSTEM = "1"
	environment.GIT_TERMINAL_PROMPT = "0"
	return environment
}
