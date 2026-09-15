import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent"
import { resolveBundledSkillsDir } from "../../shared/skill-discovery/resolve-skill-roots.js"
import { SkillManager } from "./skill-manager.js"
import { createSkillManageTool, createSkillViewTool } from "./tool.js"
import { UsageTracker } from "./usage.js"

export interface SkillsManagerOptions {
	skillsDir?: string
}

export default function skillsManagerExtension(pi: ExtensionAPI, options?: SkillsManagerOptions): void {
	const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
	// Bundled skills ship with the harness (resources/skills in dev, staged share
	// dir in binaries) and are discoverable read-only — no home-dir deploy needed.
	const bundled = resolveBundledSkillsDir()
	const manager = new SkillManager(skillsDir, bundled ? { bundledRoots: [bundled] } : undefined)
	const tracker = new UsageTracker(skillsDir)

	// Feed pi's resolved skill inventory (project .kimchi/skills, npm packages,
	// .cursor/skills, configured skillPaths — everything behind the
	// <available_skills> prompt block) into the manager as the last resolution
	// tier, so skill_view can load any advertised skill, not just harness/
	// bundled ones. Updated on every agent start; the closure lives with this
	// pi instance, so in-process subagents keep their own inventories.
	let discoveredSkills: readonly Skill[] = []
	pi.on("before_agent_start", (event) => {
		discoveredSkills = event.systemPromptOptions?.skills ?? []
	})
	pi.on("session_shutdown", () => {
		discoveredSkills = []
	})
	manager.setDiscoveredSkillsProvider(() => discoveredSkills)

	pi.registerTool(createSkillManageTool(manager, tracker))
	pi.registerTool(createSkillViewTool(manager, tracker))
}
