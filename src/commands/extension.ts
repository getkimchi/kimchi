import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@mariozechner/pi-coding-agent"

const USAGE = `Usage: kimchi extension <subcommand> [args]

Subcommands:
  add <source>          Install and enable a pi package
                        Sources: npm:@scope/pkg, git:github.com/user/repo, /local/path, ./relative/path
  remove <source>       Remove and unpersist
  list                  Show configured packages
  enable <source>       Enable a disabled package
  disable <source>      Disable an enabled package without removing
  update [source]       Update one or all packages

Options:
  -l, --local           Apply to project settings instead of global`

function printUsage(): void {
	console.log(USAGE)
}

interface ParsedFlags {
	local: boolean
	remaining: string[]
}

function parseFlags(args: string[]): ParsedFlags {
	const remaining: string[] = []
	let local = false
	for (const arg of args) {
		if (arg === "--local" || arg === "-l") {
			local = true
		} else {
			remaining.push(arg)
		}
	}
	return { local, remaining }
}

function getSettingsPath(local: boolean): string {
	if (local) {
		return join(process.cwd(), ".pi", "settings.json")
	}
	return join(getAgentDir(), "settings.json")
}

function buildPackageManager(local: boolean): DefaultPackageManager {
	const cwd = process.cwd()
	const agentDir = getAgentDir()
	const settingsManager = SettingsManager.create(cwd, agentDir)
	return new DefaultPackageManager({ cwd, agentDir, settingsManager })
}

async function handleAdd(source: string, local: boolean): Promise<number> {
	const pm = buildPackageManager(local)
	try {
		await pm.installAndPersist(source, { local })
		console.log(`Extension added: ${source}`)
		return 0
	} catch (err) {
		console.error(`kimchi extension add: ${(err as Error).message}`)
		return 1
	}
}

async function handleRemove(source: string, local: boolean): Promise<number> {
	const pm = buildPackageManager(local)
	try {
		const removed = await pm.removeAndPersist(source, { local })
		if (!removed) {
			console.error(`kimchi extension remove: package not found: ${source}`)
			return 1
		}
		console.log(`Extension removed: ${source}`)
		return 0
	} catch (err) {
		console.error(`kimchi extension remove: ${(err as Error).message}`)
		return 1
	}
}

function handleList(local: boolean): number {
	const pm = buildPackageManager(local)
	const packages = pm.listConfiguredPackages()
	if (packages.length === 0) {
		console.log("No extensions configured.")
		return 0
	}
	for (const pkg of packages) {
		const status = pkg.filtered ? "filtered" : "enabled"
		const scope = pkg.scope === "project" ? " [project]" : " [global]"
		console.log(`  ${pkg.source}  ${status}${scope}`)
	}
	return 0
}

type PackageEntry = string | { source: string; disabled?: boolean; [key: string]: unknown }

function readSettingsJson(path: string): { packages?: PackageEntry[] } {
	try {
		const raw = readFileSync(path, "utf-8")
		return JSON.parse(raw) as { packages?: PackageEntry[] }
	} catch {
		return {}
	}
}

function writeSettingsJson(path: string, data: unknown): void {
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

function handleEnable(source: string, local: boolean): number {
	const settingsPath = getSettingsPath(local)
	const settings = readSettingsJson(settingsPath)
	const packages = settings.packages ?? []
	const idx = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === source)
	if (idx === -1) {
		console.error(`kimchi extension enable: package not found: ${source}`)
		return 1
	}
	const entry = packages[idx]
	if (typeof entry === "string") {
		console.log(`Extension already enabled: ${source}`)
		return 0
	}
	const updated: PackageEntry = Object.fromEntries(
		Object.entries(entry).filter(([k]) => k !== "disabled"),
	) as PackageEntry
	packages[idx] = updated
	writeSettingsJson(settingsPath, { ...settings, packages })
	console.log(`Extension enabled: ${source}`)
	return 0
}

function handleDisable(source: string, local: boolean): number {
	const settingsPath = getSettingsPath(local)
	const settings = readSettingsJson(settingsPath)
	const packages = settings.packages ?? []
	const idx = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === source)
	if (idx === -1) {
		console.error(`kimchi extension disable: package not found: ${source}`)
		return 1
	}
	const entry = packages[idx]
	const updated: PackageEntry =
		typeof entry === "string" ? { source: entry, disabled: true } : { ...entry, disabled: true }
	packages[idx] = updated
	writeSettingsJson(settingsPath, { ...settings, packages })
	console.log(`Extension disabled: ${source}`)
	return 0
}

async function handleUpdate(source: string | undefined, local: boolean): Promise<number> {
	const pm = buildPackageManager(local)
	try {
		await pm.update(source)
		if (source) {
			console.log(`Extension updated: ${source}`)
		} else {
			console.log("All extensions updated.")
		}
		return 0
	} catch (err) {
		console.error(`kimchi extension update: ${(err as Error).message}`)
		return 1
	}
}

export async function runExtension(args: string[]): Promise<number> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage()
		return args.length === 0 ? 1 : 0
	}

	const { local, remaining } = parseFlags(args)
	const [sub, ...rest] = remaining

	if (sub === "--help" || sub === "-h") {
		printUsage()
		return 0
	}

	switch (sub) {
		case "add": {
			if (rest.length === 0) {
				console.error("kimchi extension add: missing <source>")
				printUsage()
				return 2
			}
			return handleAdd(rest[0], local)
		}
		case "remove": {
			if (rest.length === 0) {
				console.error("kimchi extension remove: missing <source>")
				printUsage()
				return 2
			}
			return handleRemove(rest[0], local)
		}
		case "list": {
			return handleList(local)
		}
		case "enable": {
			if (rest.length === 0) {
				console.error("kimchi extension enable: missing <source>")
				printUsage()
				return 2
			}
			return handleEnable(rest[0], local)
		}
		case "disable": {
			if (rest.length === 0) {
				console.error("kimchi extension disable: missing <source>")
				printUsage()
				return 2
			}
			return handleDisable(rest[0], local)
		}
		case "update": {
			return handleUpdate(rest[0], local)
		}
		default: {
			console.error(`kimchi extension: unknown subcommand "${sub}"`)
			printUsage()
			return 2
		}
	}
}
