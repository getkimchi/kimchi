import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { flushRawStdout, writeRawStdout } from "./print-output.js"

interface HostOutputGuard {
	writeRawStdout(text: string): void
	flushRawStdout(): Promise<void>
}

describe("review print output guard", () => {
	it("uses the host's actual raw stdout functions", async () => {
		const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
		const guardPath = pathToFileURL(join(dirname(packageEntry), "core", "output-guard.js")).href
		const guard = (await import(guardPath)) as HostOutputGuard
		expect(writeRawStdout).toBe(guard.writeRawStdout)
		expect(flushRawStdout).toBe(guard.flushRawStdout)
	})
})
