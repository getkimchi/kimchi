import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import * as clack from "@clack/prompts"
import { discoverCcConfig } from "./cc-discovery.js"
import { DEFAULT_SKILL_PATHS, getAgentConfigDir } from "./config.js"
import type { ServerEntry } from "./extensions/mcp-adapter/types.js"
import { discoverOcConfig } from "./oc-discovery.js"

export type MigrationState = "done" | "skip-forever"

export interface SetupResult {
	skillPaths: string[]
	migrationState?: MigrationState
}

type MigrationAction = "migrate" | "skip-once" | "skip-forever"

interface MergedDiscovery {
	mcpServers: Record<string, ServerEntry>
	cc: { skillCount: number; skillsDir?: string; hadServers: boolean }
	oc: { skillCount: number; skillsDir?: string; hadServers: boolean }
	hasAnything: boolean
}

function mergeDiscoveries(): MergedDiscovery {
	const cc = discoverCcConfig()
	const oc = discoverOcConfig()
	// CC wins on conflicts (it's the historical default users have come from);
	// both can coexist for distinct names.
	const mcpServers = { ...oc.mcpServers, ...cc.mcpServers }
	const ccBlock = {
		skillCount: cc.skillCount,
		skillsDir: cc.skillsDir,
		hadServers: Object.keys(cc.mcpServers).length > 0,
	}
	const ocBlock = {
		skillCount: oc.skillCount,
		skillsDir: oc.skillsDir,
		hadServers: Object.keys(oc.mcpServers).length > 0,
	}
	const hasAnything =
		ccBlock.hadServers || ocBlock.hadServers || cc.skillsDir !== undefined || oc.skillsDir !== undefined
	return { mcpServers, cc: ccBlock, oc: ocBlock, hasAnything }
}

function prettyHome(p: string): string {
	const h = homedir()
	return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

async function runMigrationPhase(d: MergedDiscovery): Promise<MigrationAction> {
	const lines: string[] = []
	const names = Object.keys(d.mcpServers)
	if (names.length > 0) lines.push(`MCP servers: ${names.join(", ")}`)
	if (d.cc.skillsDir) {
		lines.push(`Claude Code skills: ${d.cc.skillCount} in ${prettyHome(d.cc.skillsDir)}`)
	}
	if (d.oc.skillsDir) {
		lines.push(`OpenCode skills: ${d.oc.skillCount} in ${prettyHome(d.oc.skillsDir)}`)
	}

	const ccPresent = d.cc.hadServers || d.cc.skillsDir !== undefined
	const ocPresent = d.oc.hadServers || d.oc.skillsDir !== undefined
	const title =
		ccPresent && ocPresent
			? "Claude Code + OpenCode configuration found"
			: ocPresent
				? "OpenCode configuration found"
				: "Claude Code configuration found"

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
		return "skip-once"
	}

	const validActions: MigrationAction[] = ["migrate", "skip-once", "skip-forever"]
	return validActions.includes(action as MigrationAction) ? (action as MigrationAction) : "skip-once"
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

async function runSkillsPhase(): Promise<string[]> {
	const selected = await clack.multiselect<string>({
		message: "Select skill paths to enable:",
		options: DEFAULT_SKILL_PATHS.map((p) => ({ value: p, label: p, initialChecked: true })),
		required: false,
	})

	if (clack.isCancel(selected) || !Array.isArray(selected)) {
		return DEFAULT_SKILL_PATHS
	}

	const paths = selected

	const customInput = await clack.text({
		message: "Add a custom path (leave empty to skip):",
		placeholder: "e.g. .my-skills or /absolute/path/to/skills",
	})

	if (!clack.isCancel(customInput) && typeof customInput === "string" && customInput.trim().length > 0) {
		paths.push(customInput.trim())
	}

	return paths
}

export async function runSetupWizard(options: {
	needsSkillsSetup: boolean
	needsMigrationCheck: boolean
}): Promise<SetupResult> {
	clack.intro("Kimchi first-time setup")

	let migrationState: MigrationState | undefined
	const merged = options.needsMigrationCheck ? mergeDiscoveries() : null

	if (merged?.hasAnything) {
		const action = await runMigrationPhase(merged)
		if (action === "migrate") {
			writeMcpServers(merged.mcpServers)
			migrationState = "done"
			clack.log.success(`Migrated ${Object.keys(merged.mcpServers).length} MCP server(s) to Kimchi.`)
		} else if (action === "skip-forever") {
			migrationState = "skip-forever"
		}
		// skip-once: leave migrationState undefined so wizard runs again next time
	} else if (options.needsMigrationCheck) {
		migrationState = "done"
	}

	let skillPaths = DEFAULT_SKILL_PATHS
	if (options.needsSkillsSetup) {
		clack.note(
			"Kimchi will look for skill files in the selected directories.\n" +
				"Each relative path is scanned under both ~ and the current project.",
			"Skills",
		)
		skillPaths = await runSkillsPhase()
	}

	clack.outro("Setup complete.")
	return { skillPaths, migrationState }
}
