import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"

/**
 * `kimchi bridge setup|disable|remove|status` — manage the work-reporting
 * plugins for Claude Code and Codex (getkimchi/kimchi-bridge) that the
 * installer bundles and, with consent, registers.
 *
 * Routing inference through the Kimchi gateway is opt-in: signing into Kimchi
 * does not enable it. `kimchi bridge setup` is the explicit opt-in — it
 * installs/updates the plugins AND enables gateway routing when a sign-in
 * exists. `disable` pauses recording and turns the gateway off; `remove`
 * uninstalls the plugins from both clients (local records are kept).
 *
 * Path resolution matches the updater: the bundled package lives in the share
 * dir next to the binary's auxiliary files, and the bridge CLI the installer
 * maintained at ~/.local/bin/kimchi-bridge.
 */
export async function runBridge(args: string[]): Promise<number | undefined> {
	const verb = args[0]
	if (verb === "setup") return bridgeSetup()
	if (verb === "disable") return bridgeDisable()
	if (verb === "remove") return bridgeRemove()
	if (verb === "status") return bridgeStatus()
	console.error(
		"Usage: kimchi bridge setup|disable|remove|status",
	)
	return 1
}

function shareDir(): string {
	const execPath = process.execPath
	return resolveAuxiliaryFilesDir(process.env, homedir(), execPath)
}

function bridgeCliPath(): string {
	// The installer maintains the shim in ~/.local/bin (or the env override).
	return process.env.KIMCHI_BRIDGE_BIN_DIR
		? join(process.env.KIMCHI_BRIDGE_BIN_DIR, "kimchi-bridge")
		: join(homedir(), ".local", "bin", "kimchi-bridge")
}

/** Run a bundled installer action for both clients, without a shell. */
function runInstaller(action: string, ...clients: string[]): boolean {
	const installer = join(shareDir(), "bridge", "install.sh")
	if (!existsSync(installer)) {
		console.error(`kimchi bridge: bundled installer not found (${installer}) — is kimchi installed by its installer?`)
		return false
	}
	const result = spawnSync(installer, [action, ...clients], {
		encoding: "utf8",
		env: { ...process.env, KIMCHI_BIN: process.execPath },
		stdio: "inherit",
	})
	if (result.status === null) {
		console.error("kimchi bridge: installer failed to start:", result.error?.message ?? "unknown")
		return false
	}
	return result.status === 0
}

function runBridgeCli(args: string[]): boolean {
	const cli = bridgeCliPath()
	if (!existsSync(cli)) {
		console.error("kimchi bridge: kimchi-bridge CLI not found — run `kimchi bridge setup` first.")
		return false
	}
	const result = spawnSync(cli, args, { encoding: "utf8", stdio: "inherit" })
	if (result.status === null) {
		console.error("kimchi bridge: kimchi-bridge failed to start:", result.error?.message ?? "unknown")
		return false
	}
	return result.status === 0
}

async function bridgeSetup(): Promise<number> {
	if (!runInstaller("install", "claude", "codex")) return 1
	console.log("")
	console.log("Work reporting is installed. Routing inference through the Kimchi gateway is a separate step:")
	// Best-effort: enable routing only when a sign-in exists; the bridge itself
	// reports "Gateway not enabled" (no sign-in) when there is none.
	runBridgeCli(["gateway", "enable"])
	return 0
}

function bridgeDisable(): number {
	let ok = true
	ok = runBridgeCli(["gateway", "disable"]) && ok
	ok = runBridgeCli(["disable"]) && ok
	return ok ? 0 : 1
}

function bridgeRemove(): number {
	return runInstaller("uninstall", "both") ? 0 : 1
}

function bridgeStatus(): number {
	return runBridgeCli(["status"]) ? 0 : 1
}