// `kimchi mcp <add|list|remove>` — manage MCP server configs.
// Modeled after `claude mcp add` — simple CLI for registering servers
// without hand-editing JSON.
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { intro, note, outro, spinner, text } from "@clack/prompts"
import { loadMcpConfig, saveMcpConfig } from "../extensions/mcp-adapter/config.js"
import { getAgentDir } from "../extensions/mcp-adapter/utils.js"
import type { McpConfig, ServerEntry } from "../extensions/mcp-adapter/types.js"
import { popScope } from "./_helpers.js"

function getScope(args: string[]): "global" | "project" {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--project" || args[i] === "--scope=project") {
			args.splice(i, 1)
			return "project"
		}
		if (args[i] === "--global" || args[i] === "--scope=global") {
			args.splice(i, 1)
			return "global"
		}
	}
	return "global"
}

function resolveConfigPath(scope: "global" | "project"): string {
	if (scope === "project") {
		return resolve(process.cwd(), ".kimchi/mcp.json")
	}
	return join(getAgentDir(), "mcp.json")
}

function isUrl(value: string): boolean {
	return value.startsWith("http://") || value.startsWith("https://")
}

function loadRawConfig(configPath: string): McpConfig {
	if (existsSync(configPath)) {
		return loadMcpConfig(configPath)
	}
	return { mcpServers: {} }
}

async function runAdd(rawArgs: string[], configPath: string): Promise<number> {
	const name = rawArgs[0]
	if (!name) {
		console.error("Usage: kimchi mcp add <name> <url>  or  kimchi mcp add <name> -- <command> [args...]")
		return 1
	}

	// Detect -- separator for stdio vs URL
	const dashIdx = rawArgs.indexOf("--")
	let entry: ServerEntry

	if (dashIdx >= 0) {
		// stdio: everything after -- is the command + args
		const commandParts = rawArgs.slice(dashIdx + 1)
		if (commandParts.length === 0) {
			console.error("Usage: kimchi mcp add <name> -- <command> [args...]")
			return 1
		}
		entry = { command: commandParts[0], args: commandParts.slice(1) }
	} else {
		// URL-based (HTTP)
		const value = rawArgs[1]
		if (!value) {
			console.error("Usage: kimchi mcp add <name> <url>  or  kimchi mcp add <name> -- <command> [args...]")
			return 1
		}
		if (!isUrl(value)) {
			console.error(`Expected URL starting with http:// or https://, got: ${value}`)
			console.error("For stdio commands, use: kimchi mcp add <name> -- <command> [args...]")
			return 1
		}
		entry = { url: value }
	}

	const config = loadRawConfig(configPath)

	// Warn if replacing existing server
	let action = "Added"
	if (config.mcpServers[name]) {
		action = "Updated"
	}

	config.mcpServers[name] = entry
	saveMcpConfig(config, configPath)

	const scopeLabel = configPath.includes(".kimchi") ? "project" : "global"
	console.log(`${action} MCP server "${name}" (${scopeLabel} config)`)
	if (entry.url) {
		console.log(`  Type: streamable-http`)
		console.log(`  URL:  ${entry.url}`)
	}
	if (entry.command) {
		console.log(`  Type: stdio`)
		console.log(`  Command: ${entry.command}${entry.args?.length ? " " + entry.args.join(" ") : ""}`)
	}
	console.log(`  Config: ${configPath}`)
	return 0
}

async function runList(configPath: string): Promise<number> {
	const config = loadRawConfig(configPath)
	const servers = Object.entries(config.mcpServers)

	if (servers.length === 0) {
		console.log("No MCP servers configured.")
		console.log(`  Config file: ${configPath}`)
		return 0
	}

	console.log(`MCP servers (${servers.length}):`)
	for (const [name, entry] of servers) {
		const type = entry.url ? "http" : entry.command ? "stdio" : "unknown"
		const detail = entry.url ?? (entry.command + (entry.args?.length ? ` ${entry.args.join(" ")}` : ""))
		console.log(`  ${name} (${type})  ${detail}`)
	}
	console.log(`  Config: ${configPath}`)
	return 0
}

async function runRemove(rawArgs: string[], configPath: string): Promise<number> {
	const name = rawArgs[0]
	if (!name) {
		console.error("Usage: kimchi mcp remove <name>")
		return 1
	}

	const config = loadRawConfig(configPath)
	if (!config.mcpServers[name]) {
		console.error(`Server "${name}" not found in config.`)
		return 1
	}

	delete config.mcpServers[name]
	saveMcpConfig(config, configPath)

	console.log(`Removed MCP server "${name}" from ${configPath}`)
	return 0
}

export async function runMcp(args: string[]): Promise<number> {
	const scope = getScope(args)
	const configPath = resolveConfigPath(scope)
	const subcommand = args[0]

	switch (subcommand) {
		case "add":
			return runAdd(args.slice(1), configPath)
		case "list":
			return runList(configPath)
		case "remove":
			return runRemove(args.slice(1), configPath)
		default:
			console.error("Usage: kimchi mcp <add|list|remove> [options]")
			console.error("")
			console.error("Examples:")
			console.error("  kimchi mcp add repro http://127.0.0.1:9876/mcp")
			console.error("  kimchi mcp add my-server -- node server.js")
			console.error("  kimchi mcp add repro http://127.0.0.1:9876/mcp --project")
			console.error("  kimchi mcp list")
			console.error("  kimchi mcp remove repro")
			return 1
	}
}
