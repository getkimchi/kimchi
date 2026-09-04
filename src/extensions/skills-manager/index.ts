import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
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
	pi.registerTool(createSkillManageTool(manager, tracker))
	pi.registerTool(createSkillViewTool(manager, tracker))
}
