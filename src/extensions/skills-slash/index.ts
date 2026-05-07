/**
 * skills-slash — `/skills` slash command listing discovered skills.
 *
 * Pi has no built-in `/skills` command; skills are discovered at session
 * start and injected into the system prompt. This command shows the user
 * (and the model, via the assistant's reading of ctx.ui.notify echoes) what
 * was actually loaded — useful for debugging "why isn't my skill showing up?"
 * after `kimchi extension add`.
 */

import { homedir } from "node:os"
import { isAbsolute, normalize, resolve } from "node:path"
import {
	DefaultPackageManager,
	type ExtensionAPI,
	SettingsManager,
	getAgentDir,
	loadSkills,
} from "@mariozechner/pi-coding-agent"
import { DEFAULT_SKILL_PATHS } from "../../config.js"

function expandSkillPaths(configuredPaths: string[], cwd: string): string[] {
	const home = homedir()
	const expanded: string[] = []
	for (const p of configuredPaths) {
		if (isAbsolute(p)) {
			expanded.push(normalize(p))
		} else if (p.startsWith("~/")) {
			expanded.push(resolve(home, p.slice(2)))
		} else {
			const fromHome = resolve(home, p)
			const fromCwd = resolve(cwd, p)
			if (fromHome.startsWith(`${home}/`) || fromHome === home) expanded.push(fromHome)
			if (fromCwd.startsWith(`${cwd}/`) || fromCwd === cwd) expanded.push(fromCwd)
		}
	}
	return expanded
}

async function resolveInstalledPackageSkillPaths(cwd: string): Promise<string[]> {
	try {
		const agentDir = getAgentDir()
		const settingsManager = SettingsManager.create(cwd, agentDir)
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		const resolved = await pm.resolve()
		return resolved.skills.filter((r) => r.enabled).map((r) => r.path)
	} catch {
		return []
	}
}

export default function skillsSlashCommand(pi: ExtensionAPI): void {
	pi.registerCommand("skills", {
		description: "List discovered skills (project, user, package)",
		handler: async (_args, ctx) => {
			const allSkillPaths = [
				...expandSkillPaths(DEFAULT_SKILL_PATHS, ctx.cwd),
				...(await resolveInstalledPackageSkillPaths(ctx.cwd)),
			]
			const result = loadSkills({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				skillPaths: allSkillPaths,
				includeDefaults: false,
			})

			if (result.skills.length === 0) {
				const msg = `No skills discovered.\n\nSkill paths searched:\n${allSkillPaths.map((p) => `  ${p}`).join("\n")}`
				if (ctx.hasUI) ctx.ui.notify(msg, "info")
				else console.log(msg)
				return
			}

			const lines: string[] = [`Discovered ${result.skills.length} skill(s):`, ""]
			const sorted = [...result.skills].sort((a, b) => a.name.localeCompare(b.name))
			for (const skill of sorted) {
				const desc = skill.description.length > 80 ? `${skill.description.slice(0, 77)}...` : skill.description
				lines.push(`  ${skill.name}`)
				lines.push(`    ${desc}`)
			}
			if (result.diagnostics.length > 0) {
				lines.push("", `Diagnostics: ${result.diagnostics.length}`)
				for (const d of result.diagnostics.slice(0, 5)) {
					lines.push(`  [${d.type}] ${d.message}`)
				}
			}

			const output = lines.join("\n")
			if (ctx.hasUI) ctx.ui.notify(output, "info")
			else console.log(output)
		},
	})
}
