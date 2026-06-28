import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import * as clack from "@clack/prompts"
import { AGENT_DEFINITIONS, type AgentDiscovery, discoverAgent } from "./agent-discovery/index.js"
import { buildSkillPathOptions, getAgentConfigDir } from "./config.js"
import type { ServerEntry } from "./extensions/mcp-adapter/types.js"

export type MigrationState = "done" | "skip-forever"

export interface SetupResult {
	cancelled: boolean
	skillPaths: string[]
	migrationState?: MigrationState
}

type MigrationAction = "migrate" | "skip-once" | "skip-forever" | "cancelled"

interface MergedDiscovery {
	mcpServers: Record<string, ServerEntry>
	serverOrigins: Record<string, string>
	agents: AgentDiscovery[]
	hasAnythingMigratable: boolean
}

function mergeDiscoveries(): MergedDiscovery {
	const agents = AGENT_DEFINITIONS.map(discoverAgent)
	// Merge MCP servers in *reverse* registry order so earlier-registered
	// agents win on name collisions. Today: CC is registered first → CC
	// wins, matching previous behaviour.
	const mcpServers: Record<string, ServerEntry> = {}
	const serverOrigins: Record<string, string> = {}
	for (let i = agents.length - 1; i >= 0; i--) {
		for (const name of Object.keys(agents[i].mcpServers)) {
			mcpServers[name] = agents[i].mcpServers[name]
			serverOrigins[name] = agents[i].displayName
		}
	}
	const hasAnythingMigratable = agents.some(
		(a) => Object.keys(a.mcpServers).length > 0 || a.skillCount > 0 || a.commandsCount > 0,
	)
	return { mcpServers, serverOrigins, agents, hasAnythingMigratable }
}

function prettyHome(p: string): string {
	const h = homedir()
	return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

interface MigrationPhaseResult {
	action: MigrationAction
	selectedServers: Record<string, ServerEntry>
}

async function runMigrationPhase(d: MergedDiscovery): Promise<MigrationPhaseResult> {
	const lines: string[] = []
	const names = Object.keys(d.mcpServers)
	if (names.length > 0) lines.push(`MCP servers: ${names.join(", ")}`)
	for (const a of d.agents) {
		if (a.skillCount > 0 && a.skillsDir) {
			lines.push(`${a.displayName} skills: ${a.skillCount} in ${prettyHome(a.skillsDir)}`)
		}
		if (a.commandsCount > 0 && a.commandsDir) {
			lines.push(`${a.displayName} commands: ${a.commandsCount} in ${prettyHome(a.commandsDir)}`)
		}
	}

	const present = d.agents.filter(
		(a) => Object.keys(a.mcpServers).length > 0 || a.skillCount > 0 || a.commandsCount > 0,
	)
	const title =
		present.length === 0
			? "Configuration found"
			: `${present.map((a) => a.displayName).join(" + ")} configuration found`

	clack.note(lines.join("\n"), title)

	const action = await clack.select<MigrationAction>({
		message: "Migrate MCP servers to Kimchi?",
		options: [
			{ value: "migrate", label: "Migrate now" },
			{ value: "skip-once", label: "Skip this time" },
			{ value: "skip-forever", label: "Never ask again" },
		],
	})

	if (clack.isCancel(action)) {
		return { action: "cancelled", selectedServers: {} }
	}

	const validActions: MigrationAction[] = ["migrate", "skip-once", "skip-forever"]
	const resolvedAction = validActions.includes(action as MigrationAction) ? (action as MigrationAction) : "skip-once"

	if (resolvedAction !== "migrate" || names.length === 0) {
		return { action: resolvedAction, selectedServers: {} }
	}

	const chosen = await clack.multiselect<string>({
		message: "Select MCP servers to migrate (a: toggle all):",
		options: names.map((name) => ({
			value: name,
			label: name,
			hint: d.serverOrigins[name],
			initialChecked: true,
		})),
		required: false,
	})

	if (clack.isCancel(chosen) || !Array.isArray(chosen)) {
		return { action: "cancelled", selectedServers: {} }
	}

	const selectedServers = Object.fromEntries(chosen.map((name) => [name, d.mcpServers[name]]))
	return { action: resolvedAction, selectedServers }
}

function writeMcpServers(servers: Record<string, ServerEntry>): void {
	const mcpPath = join(getAgentConfigDir(), "mcp.json")
	mkdirSync(dirname(mcpPath), { recursive: true })

	let existing: Record<string, unknown> = {}
	if (existsSync(mcpPath)) {
		try {
			existing = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>
		} catch {
			// corrupt — start fresh
		}
	}

	const existingServers = (existing.mcpServers ?? {}) as Record<string, ServerEntry>
	const merged: Record<string, ServerEntry> = { ...servers, ...existingServers }

	existing.mcpServers = merged
	const tmp = `${mcpPath}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, "utf-8")
	renameSync(tmp, mcpPath)
}

export interface DiscoveredCommand {
	name: string
	relativePath: string
	absolutePath: string
	origin: string
}

export function toSkillName(rawName: string): string {
	return rawName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64)
}

export function discoverCommandFiles(commandsDir: string, origin: string): DiscoveredCommand[] {
	const result: DiscoveredCommand[] = []
	for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			const stem = basename(entry.name, ".md")
			result.push({
				name: toSkillName(stem),
				relativePath: entry.name,
				absolutePath: join(commandsDir, entry.name),
				origin,
			})
		}
	}
	return result
}

export function discoverSubdirectoryCommandFiles(commandsDir: string, origin: string): DiscoveredCommand[] {
	const result: DiscoveredCommand[] = []

	function walk(dir: string, prefix: string, relPrefix: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name)
			if (entry.isFile() && entry.name.endsWith(".md")) {
				const stem = basename(entry.name, ".md")
				const rawName = prefix ? `${prefix}-${stem}` : stem
				result.push({
					name: toSkillName(rawName),
					relativePath: join(relPrefix, entry.name),
					absolutePath: fullPath,
					origin,
				})
			} else if (entry.isDirectory()) {
				walk(fullPath, prefix ? `${prefix}-${entry.name}` : entry.name, join(relPrefix, entry.name))
			}
		}
	}

	for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			walk(join(commandsDir, entry.name), entry.name, entry.name)
		}
	}
	return result
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m

export function extractExistingFrontmatter(content: string): { description?: string; body: string } {
	const match = content.match(FRONTMATTER_REGEX)
	if (!match) return { body: content }

	const yaml = match[1]
	const body = match[2]
	const descLine = yaml.split("\n").find((l) => l.trimStart().startsWith("description:"))
	let description: string | undefined
	if (descLine) {
		const afterColon = descLine.slice(descLine.indexOf(":") + 1).trim()
		if (afterColon.startsWith("|") || afterColon.startsWith(">")) {
			const isFolded = afterColon.startsWith(">")
			const lines: string[] = []
			const yamlLines = yaml.split("\n")
			const startIdx = yamlLines.indexOf(descLine) + 1
			for (let i = startIdx; i < yamlLines.length; i++) {
				const line = yamlLines[i]
				if (line.match(/^\s/) && !line.match(/^[a-z]/)) {
					lines.push(line.trim())
				} else {
					break
				}
			}
			// For folded style (>), collapse newlines to spaces; for literal (|), preserve
			description = isFolded ? lines.join(" ").trim() : lines.join("\n").trim()
		} else {
			description = afterColon.replace(/^["']|["']$/g, "")
		}
	}
	return { description, body }
}

export function deriveDescription(content: string): string {
	const lines = content.split("\n").filter((l) => l.trim().length > 0)
	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed.startsWith("#")) {
			return trimmed.replace(/^#+\s*/, "").slice(0, 200)
		}
		if (trimmed.length > 10) {
			return trimmed.slice(0, 200)
		}
	}
	return "Migrated command"
}

export function migrateCommandToPrompt(cmd: DiscoveredCommand): boolean {
	const promptPath = join(getAgentConfigDir(), "prompts", cmd.relativePath)
	if (existsSync(promptPath)) return false

	const content = readFileSync(cmd.absolutePath, "utf-8")
	const { description: existingDescription, body } = extractExistingFrontmatter(content)
	const description = existingDescription || deriveDescription(content)

	const frontmatter = `---\nname: ${cmd.name}\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n`
	const promptContent = `${frontmatter}\n${body.trimStart() || content}`

	mkdirSync(dirname(promptPath), { recursive: true })
	writeFileSync(promptPath, promptContent, "utf-8")
	return true
}

async function runCommandsMigrationPhase(agents: AgentDiscovery[]): Promise<number | "cancelled"> {
	const withCommands = agents.filter(
		(a): a is typeof a & { commandsDir: string } => a.commandsCount > 0 && !!a.commandsDir,
	)
	if (withCommands.length === 0) return 0

	const topLevelCommands: DiscoveredCommand[] = []
	const subdirCommands: DiscoveredCommand[] = []
	for (const a of withCommands) {
		topLevelCommands.push(...discoverCommandFiles(a.commandsDir, a.displayName))
		subdirCommands.push(...discoverSubdirectoryCommandFiles(a.commandsDir, a.displayName))
	}

	if (topLevelCommands.length === 0 && subdirCommands.length === 0) return 0

	let selected: Set<string>
	if (topLevelCommands.length > 0) {
		const chosen = await clack.multiselect<string>({
			message: "Select commands to migrate as prompts (a: toggle all):",
			options: topLevelCommands.map((cmd) => ({
				value: cmd.name,
				label: cmd.name,
				hint: cmd.origin,
				initialChecked: true,
			})),
			required: false,
		})

		if (clack.isCancel(chosen) || !Array.isArray(chosen)) return "cancelled"
		selected = new Set(chosen)
	} else {
		selected = new Set()
	}

	let migrated = 0
	for (const cmd of topLevelCommands) {
		if (selected.has(cmd.name) && migrateCommandToPrompt(cmd)) {
			migrated++
		}
	}
	for (const cmd of subdirCommands) {
		migrateCommandToPrompt(cmd)
	}
	return migrated
}

async function runSkillsPhase(discoveredSkillDirs: string[]): Promise<string[] | "cancelled"> {
	const options = buildSkillPathOptions(discoveredSkillDirs)

	const selected = await clack.multiselect<string>({
		message: "Select skill paths to enable (a: toggle all):",
		options: options.map((p) => ({ value: p, label: p, initialChecked: true })),
		required: false,
	})

	if (clack.isCancel(selected) || !Array.isArray(selected)) {
		return "cancelled"
	}

	const paths = selected

	const customInput = await clack.text({
		message: "Add a custom path (leave empty to skip):",
		placeholder: "e.g. .my-skills or /absolute/path/to/skills",
	})

	if (clack.isCancel(customInput)) return "cancelled"

	if (typeof customInput === "string" && customInput.trim().length > 0) {
		paths.push(customInput.trim())
	}

	return paths
}

function cancelSetup(skillPaths: string[] = []): SetupResult {
	clack.cancel("Cancelled.")
	return { cancelled: true, skillPaths }
}

export async function runSetupWizard(options: {
	needsSkillsSetup: boolean
	needsMigrationCheck: boolean
}): Promise<SetupResult> {
	clack.intro("Kimchi first-time setup")

	let migrationState: MigrationState | undefined
	let migrationRan = false
	const merged = options.needsMigrationCheck ? mergeDiscoveries() : null

	if (merged?.hasAnythingMigratable) {
		const { action, selectedServers } = await runMigrationPhase(merged)
		if (action === "cancelled") {
			return cancelSetup()
		}
		if (action === "migrate") {
			const serverCount = Object.keys(selectedServers).length
			if (serverCount > 0) {
				writeMcpServers(selectedServers)
				clack.log.success(`Migrated ${serverCount} MCP server(s) to Kimchi.`)
			}
			const commandsCopied = await runCommandsMigrationPhase(merged.agents)
			if (commandsCopied === "cancelled") {
				return cancelSetup()
			}
			if (commandsCopied > 0) {
				clack.log.success(`Migrated ${commandsCopied} command(s) to Kimchi prompts.`)
			}
			migrationRan = true
		} else if (action === "skip-forever") {
			migrationState = "skip-forever"
		}
		// skip-once: leave migrationState undefined so wizard runs again next time
	} else if (options.needsMigrationCheck) {
		migrationState = "done"
	}

	const discoveredSkillDirs = merged
		? merged.agents
				.filter((a): a is typeof a & { skillsDir: string } => !!a.skillsDir && a.skillCount > 0)
				.map((a) => a.skillsDir)
		: []

	let skillPaths = buildSkillPathOptions(discoveredSkillDirs)
	if (options.needsSkillsSetup) {
		clack.note(
			"Kimchi will look for skill files in the selected directories.\n" +
				"Each relative path is scanned under both ~ and the current project.",
			"Skills",
		)
		const selectedSkillPaths = await runSkillsPhase(discoveredSkillDirs)
		if (selectedSkillPaths === "cancelled") return cancelSetup(skillPaths)
		skillPaths = selectedSkillPaths
	}

	if (migrationRan) {
		migrationState = "done"
	}

	clack.outro("Setup complete.")
	return { cancelled: false, skillPaths, migrationState }
}
