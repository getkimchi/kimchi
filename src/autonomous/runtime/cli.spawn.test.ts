import { describe, expect, it } from "vitest"
import { defaultSpawn } from "./cli.js"

describe("defaultSpawn", () => {
	it.skipIf(process.platform === "win32")("runs /bin/echo and captures stdout", async () => {
		let stdout = ""
		const spawnFn = defaultSpawn()
		const result = await spawnFn("/bin/echo", ["hello"], {
			onStdout: (c) => {
				stdout += c
			},
		})
		expect(result.exitCode).toBe(0)
		expect(stdout).toContain("hello")
	})
})
