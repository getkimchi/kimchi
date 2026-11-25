#!/usr/bin/env node

// Thin entrypoint that sets environment variables BEFORE any pi-mono code is imported.
// Static ESM imports are hoisted and initialized before the module body runs, so cli.ts
// (which statically imports extensions that transitively pull in pi-mono's config.js)
// cannot set PI_PACKAGE_DIR early enough. This module has zero pi-mono transitive deps,
// guaranteeing the env var is in place before config.js reads it.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { pickPackageDirForBinary, resolveValidatedAuxiliaryFilesDir } from "./auxiliary-files/resolver.js"
import type { ResolvedKimchiEnv } from "./env-root.js"
// MUST be imported before ./ssh-proxy.js (which transitively imports
// ./config.js, freezing config paths at evaluation time): this module
// publishes KIMCHI_ENV_ROOT as a side effect so those constants evaluate with
// the environment already resolved.
import { startupEnvError, startupResolvedEnv } from "./env-root-init.js"
import { installProxyAgent } from "./http/proxy.js"
import { installPasteInterceptor } from "./paste-interceptor.js"
import { isProxyMode, runProxy } from "./ssh-proxy.js"
import { envBinaryPath, isPackagedBinaryExecPath, reExecTarget } from "./update/paths.js"

// Must happen before installPasteInterceptor / installProxyAgent touch stdin/stdout.
// SSH ProxyCommand wires stdin/stdout as a raw binary pipe — any bytes written
// before exec corrupts the handshake.
const rawArgv = process.argv.slice(2)
if (isProxyMode(rawArgv)) {
	runProxy(rawArgv[rawArgv.indexOf("--ssh-proxy") + 1])
}

// Per-env binary: when the active env owns its own kimchi binary and this
// process is not already it, delegate to it (same argv, inherited stdio/env;
// the child re-resolves the same env from the exported KIMCHI_ENV* vars).
// Loop-safe: inside the env binary, execPath IS the env binary, so
// reExecTarget returns undefined. Dev launches (bun interpreter execPath)
// are excluded by the packaged-binary guard.
if (isPackagedBinaryExecPath(process.execPath)) {
	const delegate = reExecTarget(process.execPath, envBinaryPath())
	if (delegate) {
		const result = spawnSync(delegate, rawArgv, { stdio: "inherit", env: process.env })
		// Surface spawn failures instead of a silent exit-1, and re-raise
		// the child's signal so supervisors see the child's actual fate
		// (e.g. SIGINT surfaces as a signal death, not exit(1)).
		if (result.error) {
			console.error(`kimchi: failed to launch env binary ${delegate}: ${result.error.message}`)
		}
		if (result.signal) process.kill(process.pid, result.signal)
		else process.exit(result.status ?? 1)
	}
}

// An inherited PI_PACKAGE_DIR (e.g. kimchi started from inside another
// pi/kimchi session, which exports its own package dir) can point at a source
// checkout without the aux layout ('themes/' vs 'theme/'); the validated
// resolver recovers to the binary-adjacent share dir in that case.
let auxiliaryDir: string
const inheritedPackageDir = process.env.PI_PACKAGE_DIR
try {
	auxiliaryDir = resolveValidatedAuxiliaryFilesDir(process.env, homedir(), process.execPath)
} catch (err) {
	console.error((err as Error).message)
	process.exit(1)
}
// If an inherited PI_PACKAGE_DIR drove the choice and it belongs to a
// different kimchi version than the running binary, prefer the
// binary-adjacent share dir so theme/wasm assets match this build.
if (inheritedPackageDir) {
	auxiliaryDir = pickPackageDirForBinary(auxiliaryDir, resolve(process.execPath, "..", "..", "share", "kimchi"))
}
process.env.PI_PACKAGE_DIR = auxiliaryDir

const oauthTemplateDir = resolve(process.env.PI_PACKAGE_DIR, "resources", "oauth")
if (existsSync(oauthTemplateDir)) {
	process.env.KIMCHI_OAUTH_TEMPLATE_DIR = oauthTemplateDir
} else {
	process.env.KIMCHI_OAUTH_TEMPLATE_DIR = resolve(process.env.PI_PACKAGE_DIR, "oauth")
}

const inheritedPiAgentDir = process.env.PI_CODING_AGENT_DIR
// Harness environment: resolved at import time by ./env-root-init.js (see
// that module for why import order is load-bearing). This block surfaces a
// resolution failure as a clean startup error and derives the agent dir —
// and with it sessions, logins, and MCP state — from the env root.
const kimchiEnv: ResolvedKimchiEnv | undefined = startupResolvedEnv()
if (!kimchiEnv) {
	console.error(`kimchi: ${startupEnvError() ?? "harness environment resolution failed"}`)
	process.exit(1)
}
const agentDir = resolve(kimchiEnv.root, "harness")
// KIMCHI_CODING_AGENT_DIR is already set (and the inherited value preserved in
// KIMCHI_ORIGINAL_CODING_AGENT_DIR) by ./env-root-init.js — it must be
// published at import time, before config.ts freezes AGENT_CONFIG_DIR.
//
// Fresh env trees own their state dir. The legacy layout is left exactly
// as pi-mono expects to find it — it creates what it needs, when needed.
// (--version et al. also create the dir via the pre-main trust lock — the
// pre-environments behavior at the legacy path was identical.)
if (!kimchiEnv.legacyDefault) {
	mkdirSync(agentDir, { recursive: true })
}
if (inheritedPiAgentDir && !process.env.KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR) {
	process.env.KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR = inheritedPiAgentDir
}
process.env.PI_CODING_AGENT_DIR = agentDir

process.title = "kimchi"
process.env.PI_SKIP_VERSION_CHECK = "1"
process.env.KIMCHI_DISABLE_BUILTIN_PROVIDERS = "1"
// Kill switch for pi's own install telemetry: the interactive-mode ping to
// pi.dev/api/report-install and the pi attribution headers stamped onto
// OpenRouter/NVIDIA/Cloudflare requests. PI_TELEMETRY is pi's documented
// disable switch; it is read at call time and wins over the persisted
// enableInstallTelemetry setting. Unconditional override — kimchi never
// sends telemetry to pi, even when the user or pi's /settings toggle opts in.
process.env.PI_TELEMETRY = "0"

installProxyAgent()

// No top-level await anywhere in the startup graph: `bun build --compile
// --bytecode` (and --minify) reject TLA in bundled modules, so the async tail
// of startup lives in an explicit main().
async function main(): Promise<void> {
	// Instrument global fetch (user-agent + idle timeout) before any config or
	// update fetches: under Bun the wrapper is the only layer that bounds a
	// stalled connection. Must run after installProxyAgent() — its
	// undici.install() replaces globalThis.fetch and would wipe the wrapper.
	// Dynamic import: the wrapper's settings resolution transitively imports
	// pi-mono, which must not load before PI_PACKAGE_DIR is set above. The
	// billing hook attaches later, in cli.ts, once config loading is available.
	{
		const { installGlobalFetchInstrumentation } = await import("./http/instrument-fetch.js")
		const { getVersion } = await import("./utils.js")
		installGlobalFetchInstrumentation({ userAgent: `kimchi/${getVersion()}` })
	}

	// Register the embedded QuickJS wasm path (set by binary-entry.ts from a Bun file
	// import) with pi-mono's config module — only relevant in the compiled binary.
	// The binary name gate keeps an externally-set env var from being honored in
	// dev/source launches (same packaged-binary guard as the background updater).
	// Dynamic import: pi-mono must not load before PI_PACKAGE_DIR is set above.
	if (process.env.KIMCHI_QUICKJS_WASM_PATH && isPackagedBinaryExecPath(process.execPath)) {
		const { setEmbeddedQuickJSWasmPath } = await import("@earendil-works/pi-coding-agent")
		setEmbeddedQuickJSWasmPath(process.env.KIMCHI_QUICKJS_WASM_PATH)
	}

	// Install before the dynamic cli.js import - the interceptor must wrap process.stdin.emit before any pi-* listener attaches. See src/paste-interceptor.ts for the rationale (LLM-1358).
	installPasteInterceptor()

	await import("./cli.js")
}

void main()
