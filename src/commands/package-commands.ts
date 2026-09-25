import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { COMMANDS } from "./registry.js"

/**
 * Terminal subcommands contributed by installed pi packages.
 *
 * A package opts in via its package.json:
 *
 *   "kimchi": { "commands": { "ssh": "./dist/commands/ssh.js" } }
 *
 * Each command module exports `run(args: string[]) => Promise<number | undefined>`
 * — the exit-code contract of CommandDefinition in ./registry.ts.
 *
 * Strictly additive: packages without the field (every pi package today)
 * are unaffected — this module only ever reads, never writes, pi's own
 * package machinery (settings.packages, <agentDir>/npm). Discovery is lazy
 * and cached per agent dir; a command module is imported only when its
 * command is actually invoked.
 */

export interface PackageCommand {
	/** Command name as typed after `kimchi`. */
	name: string
	/** Package providing it (for diagnostics and help). */
	packageName: string
	/** Absolute path of the module exporting run(). */
	modulePath: string
}

interface KimchiManifest {
	commands?: Record<string, unknown>
}

/** kimchi's compiled-in subcommand names — always win over packages. */
const KIMCHI_COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name))

/**
 * pi's own CLI subcommands (package-manager-cli.js + main.js routing:
 * install / remove / uninstall / update / list / config). These reach pi
 * only via kimchi's dispatch fallthrough — without this guard a package
 * declaring e.g. "install" would intercept pi's installer.
 * Keep in sync when pi adds CLI subcommands.
 */
const PI_RESERVED_COMMAND_NAMES = new Set(["install", "remove", "uninstall", "update", "list", "config"])

function isReservedCommandName(name: string): boolean {
	return KIMCHI_COMMAND_NAMES.has(name) || PI_RESERVED_COMMAND_NAMES.has(name)
}

function agentDir(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? resolve(homedir(), ".config", "kimchi", "harness")
}

/** Cache per agent dir: re-keyed when the env var points elsewhere. */
let cache: { dir: string; commands: Map<string, PackageCommand> } | undefined

export function findPackageCommand(name: string): PackageCommand | undefined {
	if (name === "" || name.startsWith("-")) return undefined
	if (!cache || cache.dir !== agentDir()) {
		cache = { dir: agentDir(), commands: discoverPackageCommands() }
	}
	return cache.commands.get(name)
}

/** All discovered commands, by name — for the merged help output. */
export function listPackageCommands(): PackageCommand[] {
	if (!cache || cache.dir !== agentDir()) {
		cache = { dir: agentDir(), commands: discoverPackageCommands() }
	}
	return [...cache.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function discoverPackageCommands(): Map<string, PackageCommand> {
	const commands = new Map<string, PackageCommand>()
	const dir = agentDir()

	let packages: unknown
	try {
		const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")) as { packages?: unknown }
		packages = settings.packages
	} catch {
		return commands // absent/corrupt settings → nothing installed
	}
	if (!Array.isArray(packages)) return commands

	for (const entry of packages) {
		if (typeof entry !== "string" || !entry.startsWith("npm:")) continue
		const packageName = entry.slice("npm:".length)
		const pkgRoot = join(dir, "npm", "node_modules", packageName)
		// Defense-in-depth: an npm: entry containing ../ resolves outside the
		// package store — skip it (same trust model as the module-path check).
		const npmRoot = resolve(dir, "npm", "node_modules")
		if (!resolve(pkgRoot).startsWith(npmRoot + sep)) continue
		const pkgJsonPath = join(pkgRoot, "package.json")
		if (!existsSync(pkgJsonPath)) continue

		let declared: Record<string, unknown> | undefined
		try {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { kimchi?: KimchiManifest }
			const commands = pkg.kimchi?.commands
			if (commands && typeof commands === "object" && !Array.isArray(commands)) declared = commands
		} catch {
			continue // corrupt package.json — skip the package, keep scanning
		}
		if (!declared) continue

		for (const [name, modulePath] of Object.entries(declared)) {
			// Packages can never shadow kimchi built-ins or pi's own CLI
			// commands — reserved names are simply not discovered.
			if (isReservedCommandName(name)) continue
			if (typeof modulePath !== "string" || modulePath === "") continue
			// Defense-in-depth: the module must live inside the package.
			// (Installed packages run arbitrary code anyway via their
			// extension entries — this just keeps the manifest honest.)
			const resolved = resolve(pkgRoot, modulePath)
			if (resolved !== pkgRoot && !resolved.startsWith(pkgRoot + sep)) continue
			// First package in settings order wins a name collision, and
			// built-ins (checked before this module) always beat packages.
			if (!commands.has(name)) {
				commands.set(name, { name, packageName, modulePath: resolved })
			}
		}
	}
	return commands
}

export async function runPackageCommand(command: PackageCommand, args: string[]): Promise<number> {
	let mod: { run?: unknown }
	try {
		mod = (await import(pathToFileURL(command.modulePath).href)) as { run?: unknown }
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err)
		console.error(`✗ failed to load "${command.name}" from ${command.packageName}: ${detail}`)
		return 1
	}
	if (typeof mod.run !== "function") {
		console.error(`✗ ${command.packageName} declares "${command.name}" but its module exports no run()`)
		return 1
	}
	let code: unknown
	try {
		code = await (mod.run as (args: string[]) => Promise<unknown>)(args)
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err)
		console.error(`✗ "${command.name}" from ${command.packageName} failed: ${detail}`)
		return 1
	}
	// A package returning a non-number (or undefined) must not leak into
	// process.exit() — coerce garbage to 0, not a stack trace.
	if (typeof code === "number" && Number.isInteger(code)) return code
	return 0
}
