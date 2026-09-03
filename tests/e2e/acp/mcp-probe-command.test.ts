import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { type McpFixture, seedMcpStdioFixture } from "../tui/support/mcp-fixture.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")

describe("compiled kimchi mcp probe command", () => {
	const tempDirs: string[] = []
	const fixtures: McpFixture[] = []

	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop().catch(() => {})))
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("discovers tools through a real stdio MCP process and emits JSON", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-probe-work-"))
		tempDirs.push(homeDir, workDir)
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const fixture = seedMcpStdioFixture(agentDir)
		fixtures.push(fixture)
		const isolatedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "NODE_CHANNEL_FD" && name !== "NODE_UNIQUE_ID"),
		)

		const result = spawnSync(BINARY_PATH, ["mcp", "probe", "--json"], {
			cwd: workDir,
			input: JSON.stringify({ name: "probe-fixture", server: fixture.serverDefinition }),
			encoding: "utf-8",
			env: {
				...isolatedEnv,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_NO_UPDATE_CHECK: "1",
			},
			timeout: 30_000,
		})

		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		const output = JSON.parse(result.stdout) as {
			tools: Array<{ name: string; description?: string }>
			needsAuth: boolean
			error: string | null
		}
		expect(output.needsAuth).toBe(false)
		expect(output.error).toBeNull()
		expect(output.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "echo" }),
				expect.objectContaining({ name: "mixed_content" }),
			]),
		)
		expect(fixture.hasEvent("initialized")).toBe(true)
		expect(fixture.hasEvent("tools_listed")).toBe(true)
		expect(fixture.hasEvent("process_exited", { code: 0 })).toBe(true)
	})
})
