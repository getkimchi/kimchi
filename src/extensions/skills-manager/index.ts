import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { ExtensionAPI, Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { resolveBundledSkillsDir } from "../../shared/skill-discovery/resolve-skill-roots.js"
import { createSkillAutoLoader, SKILL_AUTOLOAD_LOADED_TYPE, type SkillAutoLoadData } from "./auto-load.js"
import { SkillManager } from "./skill-manager.js"
import { createSkillManageTool, createSkillViewTool } from "./tool.js"
import { UsageTracker } from "./usage.js"

export interface SkillsManagerOptions {
	skillsDir?: string
	/** Register the skill_manage (write-side) tool. The view-side skill_view
	 *  is always registered. skill_manage has been disabled at the CLI wiring
	 *  point since #235 ("temporarily", May 2026) — its autonomous
	 *  skill-creation guidance proved noisy in practice. Re-enable here only
	 *  with a deliberate decision. */
	registerSkillManageTool?: boolean
}

export default function skillsManagerExtension(pi: ExtensionAPI, options?: SkillsManagerOptions): void {
	const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
	// Bundled skills ship with the harness (resources/skills in dev, staged share
	// dir in binaries) and are discoverable read-only — no home-dir deploy needed.
	const bundled = resolveBundledSkillsDir()
	const manager = new SkillManager(skillsDir, bundled ? { bundledRoots: [bundled] } : undefined)
	const tracker = new UsageTracker(skillsDir)

	// Feed pi's resolved skill inventory (project .kimchi/skills, npm packages,
	// .cursor/skills, configured skillPaths — everything behind the prompt's
	// skills catalog) into the manager as the last resolution
	// tier, so skill_view can load any advertised skill, not just harness/
	// bundled ones. Updated on every agent start; the closure lives with this
	// pi instance, so in-process subagents keep their own inventories.
	//
	// The `input` event (skill auto-load's trigger surface) fires BEFORE the
	// first before_agent_start, so pi's authoritative list is not populated
	// yet on a session's first prompt — seed from pi's skill commands, which
	// list every loaded skill with its source info. before_agent_start
	// replaces the seed with the authoritative list (which carries the real
	// disableModelInvocation flags) before the model can call skill_view.
	// Managed roots (the harness dir and the bundled roots) are excluded:
	// those tiers are enumerated by listInventory() under their directory
	// names, and re-admitting one here under its frontmatter name would give
	// it the wrong tier label and a duplicate registry entry.
	let discoveredSkills: readonly Skill[] = []
	const managedRoots = [skillsDir, ...(bundled ? [bundled] : [])]
	const discoveredProvider = () =>
		discoveredSkills.length > 0 ? discoveredSkills : skillsFromCommands(pi.getCommands(), managedRoots)
	pi.on("before_agent_start", (event) => {
		discoveredSkills = event.systemPromptOptions?.skills ?? []
	})
	pi.on("session_shutdown", () => {
		discoveredSkills = []
	})
	manager.setDiscoveredSkillsProvider(discoveredProvider)

	createSkillAutoLoader(pi, manager, { tracker, listDiscovered: discoveredProvider })

	// The auto-load itself is invisible by design (the steer body is far
	// too large to render); its persisted entry carries the one-line notice
	// instead — in the live transcript and again on session reload.
	pi.registerEntryRenderer<SkillAutoLoadData>(SKILL_AUTOLOAD_LOADED_TYPE, (entry, _options, theme) =>
		typeof entry.data?.name === "string"
			? new Text(theme.fg("dim", `⚙ ${entry.data.name} skill auto-loaded`), 1, 0)
			: undefined,
	)

	pi.registerTool(createSkillViewTool(manager, tracker))
	if (options?.registerSkillManageTool !== false) {
		pi.registerTool(createSkillManageTool(manager, tracker))
	}
}

/** Reconstruct pi `Skill` records from the skill slash-commands so the
 *  manager can resolve discovered-tier skills before the first
 *  before_agent_start. `disableModelInvocation` is not derivable from
 *  commands (pi lists hidden skills there too) — it defaults to false and
 *  is corrected by the authoritative before_agent_start list; the
 *  auto-load registry re-checks the flag from the skill file itself.
 *
 *  Hardening: pi loads skills even when the frontmatter name fails its
 *  validation (warnings only), so names are re-checked here against pi's
 *  own rule — a malformed name never enters the discovered tier (it would
 *  land in steer headers and the manager's resolution). Entries under the
 *  managed roots are skipped: those tiers are enumerated by listInventory()
 *  keyed by directory name. */
function skillsFromCommands(commands: readonly SlashCommandInfo[], managedRoots: readonly string[]): Skill[] {
	const out: Skill[] = []
	for (const command of commands) {
		if (command.source !== "skill" || !command.name.startsWith("skill:")) continue
		const path = command.sourceInfo.path
		if (!path || !/^[a-z0-9-]+$/.test(command.name.slice("skill:".length))) continue
		if (managedRoots.some((root) => isUnder(path, root))) continue
		out.push({
			name: command.name.slice("skill:".length),
			description: command.description ?? "",
			filePath: path,
			baseDir: command.sourceInfo.baseDir ?? dirname(path),
			sourceInfo: command.sourceInfo,
			disableModelInvocation: false,
		})
	}
	return out
}

/** True when `path` is `root` itself or inside it. Both sides are
 *  canonicalized with real symlinks where the path exists (falling back to
 *  lexical resolution), so a `/var` vs `/private/var` spelling difference
 *  on macOS cannot fail the containment check open. */
function isUnder(path: string, root: string): boolean {
	const resolvedPath = canonicalize(path)
	const resolvedRoot = canonicalize(root)
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`)
}

function canonicalize(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}
