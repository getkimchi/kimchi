import { homedir } from "node:os"
import { join } from "node:path"
import { getBundledPlugin, listBundledPlugins } from "../plugins/registry.js"
import { readPluginState, setPluginEnabled } from "../plugins/state.js"
import { linkPlugin, unlinkPlugin } from "../plugins/symlinks.js"

export async function runPlugin(args: string[]): Promise<number> {
	const claudeHome = process.env.KIMCHI_CLAUDE_HOME ?? join(homedir(), ".claude")
	const configPath = process.env.KIMCHI_CONFIG_PATH ?? undefined

	if (args.length === 0) {
		printUsageToStderr()
		return 1
	}

	if (args[0] === "--help" || args[0] === "-h") {
		printUsageToStdout()
		return 0
	}

	const sub = args[0]
	const rest = args.slice(1)

	switch (sub) {
		case "list":
			return handleList(claudeHome, configPath)
		case "enable":
			return handleEnable(rest[0], claudeHome, configPath)
		case "disable":
			return handleDisable(rest[0], claudeHome, configPath)
		case "refresh":
			return handleRefresh(claudeHome, configPath)
		default:
			console.error(`unknown subcommand "${sub}"`)
			printUsageToStderr()
			return 2
	}
}

async function handleList(claudeHome: string, configPath: string | undefined): Promise<number> {
	const state = readPluginState(configPath)
	const plugins = await listBundledPlugins()
	for (const plugin of plugins) {
		const status = state[plugin.name]?.enabled === true ? "enabled" : "disabled"
		console.log(`${plugin.name}  ${plugin.version}  ${status}  ${plugin.description}`)
	}
	return 0
}

async function handleEnable(
	name: string | undefined,
	claudeHome: string,
	configPath: string | undefined,
): Promise<number> {
	if (!name) {
		console.error("plugin enable: name is required")
		return 1
	}
	const plugin = await getBundledPlugin(name)
	if (!plugin) {
		console.error(`unknown plugin: ${name}`)
		return 1
	}
	const result = linkPlugin({ name, sourceDir: plugin.sourceDir, claudeHome })
	if (!result.ok) {
		console.error(`plugin enable: ${result.reason} at ${result.path}`)
		return 1
	}
	setPluginEnabled(name, true, "bundled", configPath)
	console.log(`Enabled ${name}`)
	return 0
}

async function handleDisable(
	name: string | undefined,
	claudeHome: string,
	configPath: string | undefined,
): Promise<number> {
	if (!name) {
		console.error("plugin disable: name is required")
		return 1
	}
	const plugin = await getBundledPlugin(name)
	if (!plugin) {
		console.error(`unknown plugin: ${name}`)
		return 1
	}
	const result = unlinkPlugin({ name, claudeHome })
	if (!result.ok) {
		console.error(`plugin disable: ${result.reason} at ${result.path}`)
		return 1
	}
	setPluginEnabled(name, false, "bundled", configPath)
	console.log(`Disabled ${name}`)
	return 0
}

async function handleRefresh(claudeHome: string, configPath: string | undefined): Promise<number> {
	const state = readPluginState(configPath)
	const enabled = Object.entries(state).filter(([, v]) => v.enabled)
	if (enabled.length === 0) {
		console.log("No plugins enabled. Use 'kimchi plugin enable <name>' to activate a plugin.")
		return 0
	}
	const successNames: string[] = []
	const errors: Array<{ name: string; reason: string }> = []
	for (const [name] of enabled) {
		const plugin = await getBundledPlugin(name)
		if (!plugin) {
			errors.push({ name, reason: `unknown plugin: ${name}` })
			continue
		}
		const result = linkPlugin({ name, sourceDir: plugin.sourceDir, claudeHome })
		if (!result.ok) {
			errors.push({ name, reason: `${result.reason} at ${result.path}` })
		} else {
			successNames.push(name)
		}
	}
	console.log(`Refreshed ${successNames.length} plugin(s): ${successNames.join(", ")}`)
	if (errors.length > 0) {
		for (const err of errors) {
			console.error(`plugin refresh: ${err.name}: ${err.reason}`)
		}
		return 1
	}
	return 0
}

function printUsageToStderr(): void {
	console.error("Usage: kimchi plugin <subcommand>")
	console.error("")
	console.error("Subcommands:")
	console.error("  list              List bundled plugins and their status")
	console.error("  enable <name>     Enable a plugin (creates symlinks in ~/.claude)")
	console.error("  disable <name>    Disable a plugin (removes symlinks)")
	console.error("  refresh           Re-sync symlinks for all enabled plugins")
}

function printUsageToStdout(): void {
	console.log("Usage: kimchi plugin <subcommand>")
	console.log("")
	console.log("Subcommands:")
	console.log("  list              List bundled plugins and their status")
	console.log("  enable <name>     Enable a plugin (creates symlinks in ~/.claude)")
	console.log("  disable <name>    Disable a plugin (removes symlinks)")
	console.log("  refresh           Re-sync symlinks for all enabled plugins")
}
