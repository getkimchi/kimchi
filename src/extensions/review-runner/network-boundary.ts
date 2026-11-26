import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import type { ReviewWorktree } from "./types.js"

export interface ReviewNetworkBoundary {
	kind: "sandbox-exec" | "bwrap"
	/** Enclose a command in outbound-network and private-worktree write boundaries. */
	wrap: (command: string, worktree: ReviewWorktree) => string
}

const MACOS_DETECTION_PROFILE = `(version 1)
(allow default)
(deny network-outbound)`
let detection: Promise<ReviewNetworkBoundary | undefined> | undefined

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

function privateWritePaths(worktree: ReviewWorktree): string[] {
	return [
		...new Set(
			[worktree.path, worktree.scratchDir, worktree.buildDir, worktree.cacheDir, worktree.homeDir].map((path) =>
				realpathSync(path),
			),
		),
	]
}

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
	if (process.platform === "linux") {
		if (!(await succeeds("bwrap", ["--unshare-net", "--ro-bind", "/", "/", process.execPath, "--version"]))) {
			return undefined
		}
		return {
			kind: "bwrap",
			wrap: (command, worktree) => {
				const writeBinds = privateWritePaths(worktree)
					.map((path) => `--bind ${shellQuote(path)} ${shellQuote(path)}`)
					.join(" ")
				return `bwrap --unshare-net --ro-bind / / ${writeBinds} -- /bin/sh -c ${shellQuote(command)}`
			},
		}
	}
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
