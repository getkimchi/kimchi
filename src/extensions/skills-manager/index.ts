import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { SkillManager } from "./skill-manager.js"
import { createSkillManageTool, createSkillViewTool } from "./tool.js"
import { UsageTracker } from "./usage.js"

export interface SkillsManagerOptions {
	skillsDir?: string
}

export default function skillsManagerExtension(pi: ExtensionAPI, options?: SkillsManagerOptions): void {
	const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
	const manager = new SkillManager(skillsDir)
	const tracker = new UsageTracker(skillsDir)
	pi.registerTool(createSkillManageTool(manager, tracker))
	pi.registerTool(createSkillViewTool(manager, tracker))
}
