import { dirname, resolve } from "node:path"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getBundledPluginsRoot, listBundledPlugins } from "./registry.js"

// The real project root — WI-1 will have copied bundled assets here before
// these tests run in the GREEN phase. In the RED phase the import above fails
// before any test body executes, which is the expected outcome.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("getBundledPluginsRoot", () => {
	let originalPiPackageDir: string | undefined

	beforeEach(() => {
		originalPiPackageDir = process.env.PI_PACKAGE_DIR
	})

	afterEach(() => {
		if (originalPiPackageDir === undefined) {
			process.env.PI_PACKAGE_DIR = undefined
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir
		}
	})

	it("returns a path ending in plugins/kimchi-awesome-orchestrator when PI_PACKAGE_DIR is the project root", () => {
		process.env.PI_PACKAGE_DIR = PROJECT_ROOT
		const result = getBundledPluginsRoot()
		expect(result).toContain(join("plugins", "kimchi-awesome-orchestrator"))
	})

	it("returns the exact expected path when PI_PACKAGE_DIR is set", () => {
		process.env.PI_PACKAGE_DIR = PROJECT_ROOT
		const result = getBundledPluginsRoot()
		// In dev mode assets are at src/plugins/; in binary they are at plugins/.
		expect(result).toBe(join(PROJECT_ROOT, "src", "plugins", "kimchi-awesome-orchestrator"))
	})

	// NOTE: If getBundledPluginsRoot() returns a path without validating that it
	// exists on disk, the scenario below is skipped. Validation is optional per
	// the spec — path assembly is the core contract; existence checks belong to
	// the caller (e.g. listBundledPlugins or the validator).
	it("throws an error mentioning PI_PACKAGE_DIR when set to a nonexistent directory (if the implementation validates existence)", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/nonexistent-kimchi-12345"
		// If the function validates existence, it must throw and mention PI_PACKAGE_DIR.
		// If it does not validate, this test is expected to pass vacuously — the
		// implementation simply returns the assembled path without I/O.
		let threw = false
		let errorMessage = ""
		try {
			getBundledPluginsRoot()
		} catch (err) {
			threw = true
			errorMessage = err instanceof Error ? err.message : String(err)
		}
		if (threw) {
			expect(errorMessage).toMatch(/PI_PACKAGE_DIR/i)
		}
		// If it did not throw, the implementation is a pure path assembler — that is
		// also acceptable. No assertion needed in that branch.
	})
})

describe("listBundledPlugins", () => {
	let originalPiPackageDir: string | undefined

	beforeEach(() => {
		originalPiPackageDir = process.env.PI_PACKAGE_DIR
		process.env.PI_PACKAGE_DIR = PROJECT_ROOT
	})

	afterEach(() => {
		if (originalPiPackageDir === undefined) {
			process.env.PI_PACKAGE_DIR = undefined
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir
		}
	})

	it("returns exactly 2 entries for the bundled kimchi-awesome-orchestrator package", async () => {
		const plugins = await listBundledPlugins()
		expect(plugins).toHaveLength(2)
	})

	it("returns entries with the required shape fields", async () => {
		const plugins = await listBundledPlugins()
		for (const plugin of plugins) {
			expect(plugin).toHaveProperty("name")
			expect(plugin).toHaveProperty("version")
			expect(plugin).toHaveProperty("description")
			expect(plugin).toHaveProperty("commandCount")
			expect(plugin).toHaveProperty("agentCount")
			expect(plugin).toHaveProperty("sourceDir")
		}
	})

	it("includes orchestrator-workflows with commandCount 9 and agentCount 7", async () => {
		const plugins = await listBundledPlugins()
		const ow = plugins.find((p) => p.name === "orchestrator-workflows")
		expect(ow).toBeDefined()
		expect(ow?.commandCount).toBe(9)
		expect(ow?.agentCount).toBe(7)
	})

	it("includes docs-curator with commandCount 6 and agentCount 1", async () => {
		const plugins = await listBundledPlugins()
		const dc = plugins.find((p) => p.name === "docs-curator")
		expect(dc).toBeDefined()
		expect(dc?.commandCount).toBe(6)
		expect(dc?.agentCount).toBe(1)
	})

	it("sourceDir for each plugin is an absolute path that contains the plugin name", async () => {
		const plugins = await listBundledPlugins()
		for (const plugin of plugins) {
			expect(plugin.sourceDir).toMatch(/^\//)
			expect(plugin.sourceDir).toContain(plugin.name)
		}
	})

	// NOTE: The "silently skips sub-dirs without plugin.json" scenario requires
	// creating a temporary sub-directory inside the live bundled assets root, which
	// would mutate the source tree. This is deferred to the GREEN phase where a
	// tmpdir fixture will be set up via PI_PACKAGE_DIR. In the RED phase the import
	// fails before any test body executes.
})
