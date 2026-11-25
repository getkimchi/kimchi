import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { reviewInheritedProcessOperations } from "./inherited-process-operations.js"

const temporaryDirectories: string[] = []

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function terminateIfAlive(pid: number): void {
	if (alive(pid)) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// Expected if the process already exited.
		}
	}
}

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

	it.skipIf(process.platform === "win32")("reaps descendants and the command parent on cancellation", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-cancel-tree-"))
		temporaryDirectories.push(root)
		const script = join(root, "tree.mjs")
		const pidFile = join(root, "pids.json")
		writeFileSync(
			script,
			`import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }))
setInterval(() => {}, 1000)
`,
		)
		const operations = reviewInheritedProcessOperations("headless")
		if (!operations) throw new Error("Missing headless process adapter")
		const controller = new AbortController()
		const execution = operations.exec(`${process.execPath} ${script} ${pidFile}`, root, {
			onData: () => {},
			signal: controller.signal,
		})
		while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20))
		const { parent, grandchild } = JSON.parse(readFileSync(pidFile, "utf8")) as {
			parent: number
			grandchild: number
		}
		try {
			controller.abort()
			await expect(execution).rejects.toThrow("aborted")
			expect(alive(parent)).toBe(false)
			expect(alive(grandchild)).toBe(false)
		} finally {
			terminateIfAlive(parent)
			terminateIfAlive(grandchild)
		}
	})

	it.skipIf(process.platform === "win32")("reaps a lingering descendant after normal command completion", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-normal-tree-"))
		temporaryDirectories.push(root)
		const script = join(root, "tree.mjs")
		const pidFile = join(root, "pids.json")
		writeFileSync(
			script,
			`import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
grandchild.unref()
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }))
await new Promise((resolve) => setTimeout(resolve, 75))
`,
		)
		const operations = reviewInheritedProcessOperations("headless")
		if (!operations) throw new Error("Missing headless process adapter")
		try {
			const result = await operations.exec(`${process.execPath} ${script} ${pidFile}`, root, {
				onData: () => {},
			})
			expect(result.exitCode).toBe(0)
			const { parent, grandchild } = JSON.parse(readFileSync(pidFile, "utf8")) as {
				parent: number
				grandchild: number
			}
			expect(alive(parent)).toBe(false)
			expect(alive(grandchild)).toBe(false)
		} finally {
			const value = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; grandchild: number }
			terminateIfAlive(value.parent)
			terminateIfAlive(value.grandchild)
		}
	})
})
