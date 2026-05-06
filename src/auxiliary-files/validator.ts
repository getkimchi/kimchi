import { existsSync } from "node:fs"
import { join } from "node:path"

const REQUIRED_THEME_FILES = ["dark.json", "light.json"]
const REQUIRED_PLUGIN_DIRS = ["orchestrator-workflows", "docs-curator"]

function recoveryHint(dir: string): string {
	return `\n\nExpected layout in ${dir}:\n  package.json\n  theme/dark.json\n  theme/light.json\n\nIf kimchi is installed elsewhere, set PI_PACKAGE_DIR to point to the correct directory.`
}

export function validateAuxiliaryFiles(dir: string): void {
	if (!existsSync(dir)) {
		throw new Error(`Auxiliary files directory not found: ${dir}${recoveryHint(dir)}`)
	}

	const packageJsonPath = join(dir, "package.json")
	if (!existsSync(packageJsonPath)) {
		throw new Error(`Required file missing: ${packageJsonPath}${recoveryHint(dir)}`)
	}

	const themeDirPath = join(dir, "theme")
	if (!existsSync(themeDirPath)) {
		throw new Error(`Required directory missing: ${themeDirPath}${recoveryHint(dir)}`)
	}

	for (const file of REQUIRED_THEME_FILES) {
		const filePath = join(themeDirPath, file)
		if (!existsSync(filePath)) {
			throw new Error(`Required theme file missing: ${filePath}${recoveryHint(dir)}`)
		}
	}

	const pluginRoot = existsSync(join(dir, "src", "plugins", "kimchi-awesome-orchestrator"))
		? join(dir, "src", "plugins", "kimchi-awesome-orchestrator")
		: join(dir, "plugins", "kimchi-awesome-orchestrator")
	for (const sub of REQUIRED_PLUGIN_DIRS) {
		const pjPath = join(pluginRoot, sub, "plugin.json")
		if (!existsSync(pjPath)) {
			throw new Error(`Required plugin file missing: ${pjPath}${recoveryHint(dir)}`)
		}
	}
}
