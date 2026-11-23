import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const binary = resolve(
	process.env.KIMCHI_REPO_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url)),
	"dist/bin/kimchi",
)

describe("ACP integration — memory capture worker", () => {
	let home: string | undefined

	afterEach(() => {
		if (home) rmSync(home, { recursive: true, force: true })
		home = undefined
	})

	it("resolves the SQLite queue in the packaged executable", () => {
		home = mkdtempSync(join(tmpdir(), "kimchi-capture-worker-"))
		const memoryRoot = join(home, ".config", "kimchi", "memory")
		const job = join(memoryRoot, "pending", "empty.json")
		const db = join(memoryRoot, "personal", "memory.db")
		mkdirSync(join(memoryRoot, "pending"), { recursive: true })
		writeFileSync(job, JSON.stringify({ version: 2, messages: [], dedupeSession: "compiled-worker-check" }))

		const result = spawnSync(binary, ["memory-capture", "--job", job, "--db", db], {
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				XDG_DATA_HOME: join(home, ".local", "share"),
				KIMCHI_ENABLE_RESOURCES: "extensions.memory",
			},
		})

		expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toMatchObject({
			status: 0,
			output: expect.stringContaining("[memory-capture] captured 0 facts"),
		})
		expect(result.error).toBeUndefined()
		expect(existsSync(join(memoryRoot, "capture-jobs.db"))).toBe(true)
	})
})
