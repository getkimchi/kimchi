#!/usr/bin/env node

// Thin entrypoint that sets environment variables BEFORE any pi-mono code is imported.
// Static ESM imports are hoisted and initialized before the module body runs, so cli.ts
// (which statically imports extensions that transitively pull in pi-mono's config.js)
// cannot set PI_PACKAGE_DIR early enough. This module has zero pi-mono transitive deps,
// guaranteeing the env var is in place before config.js reads it.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, resolve } from "node:path"
import { pickPackageDirForBinary, resolveValidatedAuxiliaryFilesDir } from "./auxiliary-files/resolver.js"
import { installProxyAgent } from "./http/proxy.js"
import { installPasteInterceptor } from "./paste-interceptor.js"
import { isProxyMode, runProxy } from "./ssh-proxy.js"

// Must happen before installPasteInterceptor / installProxyAgent touch stdin/stdout.
// SSH ProxyCommand wires stdin/stdout as a raw binary pipe — any bytes written
// before exec corrupts the handshake.
const rawArgv = process.argv.slice(2)
if (isProxyMode(rawArgv)) {
	runProxy(rawArgv[rawArgv.indexOf("--ssh-proxy") + 1])
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
const agentDir = resolve(homedir(), ".config", "kimchi", "harness")
process.env.KIMCHI_CODING_AGENT_DIR = agentDir
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
	// Instrument global fetch (user-agent + idle timeout) BEFORE the auto-update
	// fetches below: under Bun the wrapper is the only layer that bounds a
	// stalled connection, and an unbounded stall in the update download would
	// hang launch until the OS TCP timeout (~11 min). Must run after
	// installProxyAgent() — its undici.install() replaces globalThis.fetch and
	// would wipe the wrapper. Dynamic import: the wrapper's settings resolution
	// transitively imports pi-mono, which must not load before PI_PACKAGE_DIR is
	// set above. The billing hook attaches later, in cli.ts, once config loading
	// is available.
	{
		const { installGlobalFetchInstrumentation } = await import("./http/instrument-fetch.js")
		const { getVersion } = await import("./utils.js")
		installGlobalFetchInstrumentation({ userAgent: `kimchi/${getVersion()}` })
	}

	// Phase 2 of the auto-update plan: on-launch update check + swap. Dynamic
	// import keeps the network deps in ./update/workflow.js out of every test
	// that touches entry.ts. The call never throws (see auto-update.ts).
	//
	// The deadline is managed INSIDE maybeAutoUpdateOnLaunch: only the
	// checkForUpdate phase is raced against the timeout. Once we commit to
	// applyUpdate it is awaited fully — a Promise.race here would abandon
	// the install mid-swap, letting cli.js boot while files are still being
	// copied/renamed.
	const { maybeAutoUpdateOnLaunch } = await import("./update/auto-update.js")
	try {
		await maybeAutoUpdateOnLaunch()
	} catch (err) {
		console.warn(`[kimchi-auto-update] failed: ${err instanceof Error ? err.message : err}`)
	}

	// Register the embedded QuickJS wasm path (set by binary-entry.ts from a Bun file
	// import) with pi-mono's config module — only relevant in the compiled binary.
	// The binary name gate keeps an externally-set env var from being honored in
	// dev/source launches (same guard as maybeAutoUpdateOnLaunch).
	// Dynamic import: pi-mono must not load before PI_PACKAGE_DIR is set above.
	const compiledBinName = process.platform === "win32" ? "kimchi.exe" : "kimchi"
	if (process.env.KIMCHI_QUICKJS_WASM_PATH && basename(process.execPath) === compiledBinName) {
		const { setEmbeddedQuickJSWasmPath } = await import("@earendil-works/pi-coding-agent")
		setEmbeddedQuickJSWasmPath(process.env.KIMCHI_QUICKJS_WASM_PATH)
	}

	// Install before the dynamic cli.js import - the interceptor must wrap process.stdin.emit before any pi-* listener attaches. See src/paste-interceptor.ts for the rationale (LLM-1358).
	installPasteInterceptor()

	await import("./cli.js")
}

void main()
