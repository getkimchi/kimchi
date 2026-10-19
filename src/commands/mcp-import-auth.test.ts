import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runImportAuth } from "./mcp-import-auth.js"

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "import-auth-cmd-"))
	const agentDir = join(root, "agent")
	const cwd = join(root, "work")
	mkdirSync(join(agentDir, "mcp-oauth"), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	writeFileSync(
		join(agentDir, "mcp.json"),
		`${JSON.stringify({ mcpServers: { srv: { url: "https://x.test/mcp" } } }, null, 2)}\n`,
	)
	const account = `sha256-${createHash("sha256").update("srv", "utf8").digest("hex")}`
	mkdirSync(join(agentDir, "mcp-oauth", account), { recursive: true })
	writeFileSync(
		join(agentDir, "mcp-oauth", account, "tokens.json"),
		JSON.stringify({ tokens: { accessToken: "at" }, serverUrl: "https://x.test/mcp" }),
	)
	return { root, agentDir, cwd }
}

describe("runImportAuth", () => {
	it("imports and reports JSON with exit 0", () => {
		const { agentDir, cwd } = fixture()
		const exit = runImportAuth(["--json"], { agentDir, cwd })
		expect(exit).toBe(0)
		const states = JSON.parse(readFileSync(join(agentDir, "mcp-auth.json"), "utf8"))
		expect(states["mcp__srv|https://x.test/mcp"].tokens.access_token).toBe("at")
	})

	it("emits human-readable output by default", () => {
		const { agentDir, cwd } = fixture()
		const stdout = captureStdout(() => {
			expect(runImportAuth([], { agentDir, cwd })).toBe(0)
		})
		expect(stdout).toContain("1 imported")
		expect(stdout).toContain("srv (plaintext)")
	})

	it("rejects unexpected arguments with exit 1", () => {
		const { agentDir, cwd } = fixture()
		const stdout = captureStdout(() => {
			expect(runImportAuth(["--json", "bogus"], { agentDir, cwd })).toBe(1)
		})
		expect(JSON.parse(stdout)).toMatchObject({ ok: false })
	})
})

function captureStdout(fn: () => void): string {
	const chunks: string[] = []
	const original = process.stdout.write
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(typeof chunk === "string" ? chunk : "")
		return true
	}) as typeof process.stdout.write
	try {
		fn()
	} finally {
		process.stdout.write = original
	}
	return chunks.join("")
}
