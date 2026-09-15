import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { ensureAgentColabExtension } from "./agent-colab.js"

let sourceDir: string
let agentDir: string

function makeSourcePackage(version: string): void {
	writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "pi-agent-colab", version }))
	writeFileSync(join(sourceDir, "index.ts"), "export default () => {}")
	writeFileSync(join(sourceDir, "registry.ts"), "export const x = 1")
	writeFileSync(join(sourceDir, "registry.test.ts"), "// tests must not be mirrored")
	writeFileSync(join(sourceDir, "README.md"), "# docs stay in the package")
}

function targetDir(): string {
	return join(agentDir, "extensions", "agent-colab")
}

beforeEach(() => {
	sourceDir = mkdtempSync(join(tmpdir(), "agent-colab-src-"))
	agentDir = mkdtempSync(join(tmpdir(), "agent-colab-agent-"))
	makeSourcePackage("0.1.0")
})

describe("agent-colab installer", () => {
	it("mirrors extension TS files and stamps the version", () => {
		ensureAgentColabExtension(agentDir, { sourceDir })
		const target = targetDir()
		expect(existsSync(join(target, "index.ts"))).toBe(true)
		expect(existsSync(join(target, "registry.ts"))).toBe(true)
		expect(existsSync(join(target, "registry.test.ts"))).toBe(false)
		expect(existsSync(join(target, "README.md"))).toBe(false)
		expect(readFileSync(join(target, ".kimchi-agent-colab-version"), "utf8")).toBe("0.1.0")
	})

	it("skips re-sync when the version stamp matches", () => {
		ensureAgentColabExtension(agentDir, { sourceDir })
		// Mutate the source without bumping the version — stamp gate must skip.
		writeFileSync(join(sourceDir, "index.ts"), "export default () => 'changed'")
		ensureAgentColabExtension(agentDir, { sourceDir })
		expect(readFileSync(join(targetDir(), "index.ts"), "utf8")).toBe("export default () => {}")
	})

	it("re-mirrors when the version changes", () => {
		ensureAgentColabExtension(agentDir, { sourceDir })
		writeFileSync(join(sourceDir, "index.ts"), "export default () => 'v2'")
		writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "pi-agent-colab", version: "0.2.0" }))
		ensureAgentColabExtension(agentDir, { sourceDir })
		expect(readFileSync(join(targetDir(), "index.ts"), "utf8")).toBe("export default () => 'v2'")
		expect(readFileSync(join(targetDir(), ".kimchi-agent-colab-version"), "utf8")).toBe("0.2.0")
	})

	it("recovers from a corrupted/partial target dir", () => {
		ensureAgentColabExtension(agentDir, { sourceDir })
		// Simulate a partial copy: stamp present but index.ts missing.
		const target = targetDir()
		rmSync(join(target, "index.ts"), { force: true })
		rmSync(join(target, "registry.ts"), { force: true })
		ensureAgentColabExtension(agentDir, { sourceDir })
		expect(existsSync(join(target, "index.ts"))).toBe(true)
	})

	it("warns and continues when the source package is missing", () => {
		expect(() => ensureAgentColabExtension(agentDir, { sourceDir: join(sourceDir, "missing") })).not.toThrow()
		expect(existsSync(targetDir())).toBe(false)
	})
})
