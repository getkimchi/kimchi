/** Local fake-provider lab; uses the same isolated home as the TUI specs. */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { createKimchiFixture } from "../tests/e2e/tui/support/kimchi-fixture.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
const controller = join(root, "resources/skills/kimchi-tmux/scripts/harness-live.mjs")
const binary = join(root, "dist/bin/kimchi")
if (!existsSync(binary)) throw new Error("Run pnpm run build:binary first.")
const responses = process.argv[2]
	? JSON.parse(readFileSync(resolve(process.argv[2]), "utf8"))
	: [{ stream: ["Local attribution lab is ready."] }]
if (!Array.isArray(responses)) throw new Error("The response file must contain a JSON array.")
const fixture = await createKimchiFixture({
	responses,
	gitInit: true,
	models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
	seedHome(home) {
		const path = join(home, ".config/kimchi/config.json")
		const config = JSON.parse(readFileSync(path, "utf8"))
		writeFileSync(path, JSON.stringify({ ...config, telemetry: { enabled: false } }))
	},
})
const socketDir = join(fixture.homeDir, "tmux")
mkdirSync(socketDir, { mode: 0o700 })
const env = {
	...process.env,
	...fixture.seedEnv,
	HOME: fixture.homeDir,
	TMUX: "",
	TMUX_TMPDIR: socketDir,
	KIMCHI_BINARY: binary,
	KIMCHI_NO_UPDATE_CHECK: "1",
	KIMCHI_REMOTE_RUN: "0",
}
const control = (...args) => execFileSync(process.execPath, [controller, ...args], { env, encoding: "utf8" })
let runDir
let stopping = false
let input
async function stop() {
	if (stopping) return
	stopping = true
	input?.close()
	try {
		if (runDir) {
			try {
				control("stop", runDir)
			} catch (error) {
				console.warn(`Could not stop TMUX (it may already have exited): ${error.message}`)
			}
			const ledger = join(fixture.agentDir, "work-attribution")
			if (existsSync(ledger)) cpSync(ledger, join(runDir, "work-attribution"), { recursive: true })
			writeFileSync(join(runDir, "fake-requests.json"), JSON.stringify(fixture.fake.requests, null, 2))
			console.log(`Saved local artifacts: ${runDir}`)
		}
	} finally {
		await fixture.stop()
	}
}
try {
	const started = control("start", "basic", "fake")
	runDir = /^Run: (.+)$/m.exec(started)?.[1]
	if (!runDir) throw new Error(`Controller did not return a run directory: ${started}`)
	execFileSync("git", ["config", "user.name", "Attribution Lab"], { cwd: runDir })
	execFileSync("git", ["config", "user.email", "attribution@example.invalid"], { cwd: runDir })
	writeFileSync(
		join(runDir, "lab.json"),
		JSON.stringify(
			{ homeDir: fixture.homeDir, socketDir, controller, ledgerDir: join(fixture.agentDir, "work-attribution") },
			null,
			2,
		),
	)
	console.log(started)
	console.log(
		`HOME=${fixture.homeDir}\nTMUX_TMPDIR=${socketDir}\nLedger: ${join(fixture.agentDir, "work-attribution")}`,
	)
	console.log("Keep this process running. Press Enter here to stop the lab and save its artifacts.")
	input = createInterface({ input: process.stdin })
	input.once("line", () => {
		void stop()
	})
	process.once("SIGINT", () => {
		void stop()
	})
	process.once("SIGTERM", () => {
		void stop()
	})
} catch (error) {
	await stop()
	throw error
}
