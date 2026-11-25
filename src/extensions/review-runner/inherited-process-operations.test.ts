import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { reviewInheritedProcessOperations } from "./inherited-process-operations.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("headless inherited process operations", () => {
	it("keeps ordinary local command paths detached and creates the adapter only for headless reviews", () => {
		expect(reviewInheritedProcessOperations("local")).toBeUndefined()
		expect(reviewInheritedProcessOperations("headless")).toBeDefined()
	})

	it.skipIf(process.platform === "win32")("runs a command in Kimchi's process group", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-pgid-"))
		temporaryDirectories.push(root)
		const script = join(root, "pgid.mjs")
		writeFileSync(
			script,
			`import { execFileSync } from "node:child_process"
const pgid = (pid) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim())
console.log(JSON.stringify({ child: pgid(process.pid), parent: pgid(process.ppid) }))
`,
		)
		let output = ""
		const operations = reviewInheritedProcessOperations("headless")
		if (!operations) throw new Error("Missing headless process adapter")
		const result = await operations.exec(`${process.execPath} ${script}`, root, {
			onData: (data) => {
				output += data.toString("utf8")
			},
		})
		expect(result.exitCode).toBe(0)
		const { child, parent } = JSON.parse(output)
		expect(child).toBe(parent)
	})
})
