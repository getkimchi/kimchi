import * as clack from "@clack/prompts"
import { AGENT_DEFINITIONS, discoverAgent } from "./agent-discovery/index.js"
import { buildSkillPathOptions } from "./config.js"

export async function runSkillsWizard(): Promise<string[]> {
	clack.intro("Skills configuration")
	clack.note(
		"Kimchi will look for skill files in the selected directories.\n" +
			"Each relative path is scanned under both ~ and the current project.",
		"First-time setup",
	)

	const agents = AGENT_DEFINITIONS.map(discoverAgent)
	const discoveredDirs = agents
		.filter((a): a is typeof a & { skillsDir: string } => !!a.skillsDir && a.skillCount > 0)
		.map((a) => a.skillsDir)

	const options = buildSkillPathOptions(discoveredDirs)

	const selected = await clack.multiselect<string>({
		message: "Select skill paths to enable (a: toggle all):",
		options: options.map((p) => ({ value: p, label: p, initialChecked: true })),
		required: false,
	})

	if (clack.isCancel(selected)) {
		clack.cancel("Setup cancelled. Using default paths.")
		return options
	}

	const paths = selected as string[]

	const customInput = await clack.text({
		message: "Add a custom path (leave empty to skip):",
		placeholder: "e.g. .my-skills or /absolute/path/to/skills",
	})

	if (!clack.isCancel(customInput) && typeof customInput === "string" && customInput.trim().length > 0) {
		paths.push(customInput.trim())
	}

	clack.outro(`Saved ${paths.length} skill path(s).`)
	return paths
}
