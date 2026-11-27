import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const TSX_CLI = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url))
const FIXTURE = fileURLToPath(
	new URL("../../../tests/fixtures/review-command/print-stream-process.ts", import.meta.url),
)

interface ChildResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
}

async function runChild(mode: "ordered" | "watchdog"): Promise<ChildResult> {
	const child = spawn(process.execPath, [TSX_CLI, FIXTURE, mode], {
		stdio: ["ignore", "pipe", "pipe"],
	})
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`Timed out waiting for ${mode} child; stderr=${stderr}`))
		}, 20_000)
		child.once("error", reject)
		child.once("close", (code, signal) => {
			clearTimeout(timeout)
			resolve({ code, signal, stdout, stderr })
		})
	})
}

function eventTypes(result: ChildResult): string[] {
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { type: string }).type)
}

describe("review print host queue integration", () => {
	it("keeps a large queued host record ordered and valid before review events", { timeout: 60_000 }, async () => {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const result = await runChild("ordered")
			const diagnostic = `attempt=${attempt + 1}; code=${result.code}; stderr=${result.stderr}; bytes=${result.stdout.length}`
			expect(result.code, diagnostic).toBe(0)
			expect(eventTypes(result), diagnostic).toEqual(["session", "child_usage", "agent_settled"])
		}
	})

	it("drains the host queue and emits one settlement before watchdog exit", { timeout: 30_000 }, async () => {
		const result = await runChild("watchdog")
		const diagnostic = `code=${result.code}; signal=${result.signal}; stderr=${result.stderr}; bytes=${result.stdout.length}`
		expect(result.code, diagnostic).toBe(143)
		expect(eventTypes(result), diagnostic).toEqual(["session", "child_usage", "agent_settled"])
	})
})
