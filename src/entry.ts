#!/usr/bin/env node

// Thin entrypoint that sets environment variables BEFORE any pi-mono code is imported.
// Static ESM imports are hoisted and initialized before the module body runs, so cli.ts
// (which statically imports extensions that transitively pull in pi-mono's config.js)
// cannot set PI_PACKAGE_DIR early enough. This module has zero pi-mono transitive deps,
// guaranteeing the env var is in place before config.js reads it.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { resolveAuxiliaryFilesDir } from "./auxiliary-files/resolver.js"
import { validateAuxiliaryFiles } from "./auxiliary-files/validator.js"
import { installPasteInterceptor } from "./paste-interceptor.js"
import { installProxyAgent } from "./proxy.js"
import { isProxyMode, runProxy } from "./ssh-proxy.js"

// Must happen before installPasteInterceptor / installProxyAgent touch stdin/stdout.
// SSH ProxyCommand wires stdin/stdout as a raw binary pipe — any bytes written
// before exec corrupts the handshake.
const rawArgv = process.argv.slice(2)
if (isProxyMode(rawArgv)) {
	runProxy(rawArgv[rawArgv.indexOf("--ssh-proxy") + 1])
}

const preSet = !!process.env.PI_PACKAGE_DIR
const auxiliaryDir = resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath)
if (!preSet) {
	try {
		validateAuxiliaryFiles(auxiliaryDir)
	} catch (err) {
		console.error((err as Error).message)
		process.exit(1)
	}
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

installProxyAgent()

// Phase 2 of the auto-update plan: on-launch update check + swap. Dynamic
// import keeps the network deps in ./update/workflow.js out of every test
// that touches entry.ts. The call never throws (see auto-update.ts).
//
// Two layers cap the startup budget, because the inner calls
// (checkForUpdate / applyUpdate) don't accept an AbortSignal and would
// otherwise block on slow network I/O:
//   1. Promise.race with a hard timeout — abandons the await at the
//      deadline regardless of inner state.
//   2. AbortSignal checkpoints inside maybeAutoUpdateOnLaunch — prevents
//      the re-exec swap if applyUpdate finishes after the deadline.
//
// A SINGLE deadline drives both: the watchdog timer aborts the controller
// AND resolves the race. Two independent timers would race each other — if
// the race-resolver fired first, the `finally` clearTimeout could cancel
// the abort before it ran, leaving maybeAutoUpdateOnLaunch to re-exec after
// cli.js had already started (tearing down the UI mid-startup).
const { maybeAutoUpdateOnLaunch, DEFAULT_AUTO_UPDATE_TIMEOUT_MS } = await import("./update/auto-update.js")
const autoUpdateController = new AbortController()
let autoUpdateTimeout: ReturnType<typeof setTimeout> | undefined
const autoUpdateDeadline = new Promise<void>((resolve) => {
	autoUpdateTimeout = setTimeout(() => {
		autoUpdateController.abort()
		resolve()
	}, DEFAULT_AUTO_UPDATE_TIMEOUT_MS)
	// Don't keep the event loop alive just for the watchdog — once installPasteInterceptor
	// + cli.js have taken over stdin, this timer is irrelevant.
	;(autoUpdateTimeout as { unref?: () => void }).unref?.()
})
try {
	await Promise.race([maybeAutoUpdateOnLaunch({ signal: autoUpdateController.signal }), autoUpdateDeadline])
} catch (err) {
	console.warn(`[kimchi-auto-update] failed: ${err instanceof Error ? err.message : err}`)
} finally {
	clearTimeout(autoUpdateTimeout)
}

// Install before the dynamic cli.js import - the interceptor must wrap process.stdin.emit before any pi-* listener attaches. See src/paste-interceptor.ts for the rationale (LLM-1358).
installPasteInterceptor()

await import("./cli.js")
