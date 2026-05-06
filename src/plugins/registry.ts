import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface BundledPlugin {
	name: string
	version: string
	description: string
	commandCount: number
	agentCount: number
	sourceDir: string
}

export function getBundledPluginsRoot(): string {
	const piPackageDir = process.env.PI_PACKAGE_DIR
	if (!piPackageDir) {
		throw new Error("PI_PACKAGE_DIR is not set. Set it to the kimchi package directory to locate bundled plugins.")
	}
	// In dev mode PI_PACKAGE_DIR is the project root; assets live under src/plugins/.
	// In the compiled binary PI_PACKAGE_DIR is dist/share/kimchi; assets are staged to plugins/.
	const devPath = join(piPackageDir, "src", "plugins", "kimchi-awesome-orchestrator")
	const binaryPath = join(piPackageDir, "plugins", "kimchi-awesome-orchestrator")
	return existsSync(devPath) ? devPath : binaryPath
}

function countMdFiles(dir: string): number {
	if (!existsSync(dir)) {
		return 0
	}
	return readdirSync(dir).filter((f) => f.endsWith(".md")).length
}

export async function listBundledPlugins(): Promise<BundledPlugin[]> {
	const root = getBundledPluginsRoot()

	if (!existsSync(root)) {
		throw new Error(`Bundled plugins directory not found: ${root}. Check that PI_PACKAGE_DIR is set correctly.`)
	}

	const entries = readdirSync(root, { withFileTypes: true })
	const plugins: BundledPlugin[] = []

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue
		}

		const sourceDir = join(root, entry.name)
		const pluginJsonPath = join(sourceDir, "plugin.json")

		if (!existsSync(pluginJsonPath)) {
			console.warn(`Skipping ${sourceDir}: no plugin.json found`)
			continue
		}

		let parsed: { name?: string; version?: string; description?: string }
		try {
			parsed = JSON.parse(readFileSync(pluginJsonPath, "utf8"))
		} catch {
			console.warn(`Skipping ${sourceDir}: failed to parse plugin.json`)
			continue
		}

		if (!parsed.name || !parsed.version || !parsed.description) {
			console.warn(`Skipping ${sourceDir}: plugin.json missing required fields`)
			continue
		}

		const commandCount = countMdFiles(join(sourceDir, "commands"))
		const agentCount = countMdFiles(join(sourceDir, "agents"))

		plugins.push({
			name: parsed.name,
			version: parsed.version,
			description: parsed.description,
			commandCount,
			agentCount,
			sourceDir,
		})
	}

	return plugins
}

export async function getBundledPlugin(name: string): Promise<BundledPlugin | undefined> {
	const plugins = await listBundledPlugins()
	return plugins.find((p) => p.name === name)
}
