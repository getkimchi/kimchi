import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { requestAdvertisesTool } from "../tui/support/mcp-model-script.js"
import { createPRWatchTargets } from "../tui/support/pr-watch-targets.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

it.each([
	{ name: "neither capability", flags: { backgroundRuns: false } },
	{ name: "background runs only", flags: { backgroundRuns: true } },
	{ name: "PR monitoring declined", flags: { backgroundRuns: true, prMonitoring: false } },
	{ name: "PR monitoring without background runs", flags: { backgroundRuns: false, prMonitoring: true } },
])("keeps PR watching unavailable with $name", async ({ name, flags }) => {
	const fixture = await startAcpFixture({
		artifactName: `pr-watch-capabilities-${name.replaceAll(" ", "-")}`,
		clientMeta: { "kimchi.dev": flags },
		extraArgs: ["--pr-watch"],
		responses: [{ stream: ["Normal conversation works."] }, { stream: ["This stays a regular user prompt."] }],
	})
	try {
		expect(fixture.initializeResponse.agentCapabilities?._meta?.["kimchi.dev"]).toMatchObject({
			prMonitoring: true,
			backgroundRuns: true,
		})
		writeFileSync(join(fixture.homeDir, ".config/kimchi/harness/pr-watch.json"), JSON.stringify({ enabled: true }))
		const sessionId = await newSession(fixture, fixture.workDir)
		await expect
			.poll(() =>
				fixture.client.sessionUpdates.some(({ update }) => update.sessionUpdate === "available_commands_update"),
			)
			.toBe(true)
		expect(
			fixture.client.sessionUpdates.some(
				({ update }) =>
					update.sessionUpdate === "available_commands_update" &&
					update.availableCommands.some(({ name }) => name === "pr-watch"),
			),
		).toBe(false)
		const result = await fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "Reply briefly." }],
		})
		expect(result.stopReason).toBe("end_turn")
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Normal conversation works.")
		expect(chatRequests(fixture)).toHaveLength(1)
		expect(chatRequests(fixture).some((request) => requestAdvertisesTool(request, "pr_watch"))).toBe(false)
		await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch" }] })
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain("This stays a regular user prompt.")
		expect(chatRequests(fixture)).toHaveLength(2)
		expect(
			fixture.client.permissionRequests.filter(({ toolCall }) => toolCall.title === "Enable automatic PR watching?"),
		).toEqual([])
	} finally {
		await fixture.stop()
	}
})

it("replays an opted-in session without restoring its saved watcher for an unsupported client", async () => {
	const root = mkdtempSync(join(tmpdir(), "pr-watch-resume-capability-"))
	const home = join(root, "home")
	const [target] = createPRWatchTargets(root, [7], "github")
	const stateFile = join(root, "state.json")
	writeFileSync(stateFile, JSON.stringify({ targets: [target] }))
	vi.stubEnv("GH_TOKEN", "pr-watch-fixture-token")
	vi.stubEnv("KIMCHI_TEST_PR_WATCH", stateFile)
	const options = {
		homeDirOverride: home,
		workDirOverride: target.cwd,
		pretrustWorkDir: true,
		extensionPath: fileURLToPath(new URL("../fixtures/pr-watch-github-api.js", import.meta.url)),
	}
	let first: Awaited<ReturnType<typeof startAcpFixture>> | undefined
	let second: Awaited<ReturnType<typeof startAcpFixture>> | undefined
	try {
		first = await startAcpFixture({
			...options,
			artifactName: "pr-watch-resume-capability-first",
			clientMeta: { "kimchi.dev": { prMonitoring: true, backgroundRuns: true } },
			extraArgs: ["--plan"],
			responses: [{ stream: ["Existing conversation."] }],
		})
		writeFileSync(join(home, ".config/kimchi/harness/pr-watch.json"), JSON.stringify({ enabled: true }))
		const sessionId = await newSession(first, target.cwd)
		const initial = first
		await expect
			.poll(async () => {
				await initial.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch status" }] })
				return initial.client.agentTextBySession().get(sessionId)
			})
			.toContain("Auto-fix on · CI only")
		await first.conn.prompt({ sessionId, prompt: [{ type: "text", text: "Reply briefly." }] })
		const sessions = join(home, ".config/kimchi/harness/sessions")
		const log = readdirSync(sessions)
			.flatMap((dir) => readdirSync(join(sessions, dir)).map((file) => join(sessions, dir, file)))
			.find((file) => file.endsWith(`_${sessionId}.jsonl`))
		if (!log) throw new Error("Missing saved session")
		const savedWatches = () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.type === "custom" && entry.customType === "pr_watch")
		const before = savedWatches()
		expect(before.at(-1)?.data.targets).toMatchObject([{ enabled: true, autoFix: true }])
		await first.stop()
		first = undefined

		second = await startAcpFixture({
			...options,
			artifactName: "pr-watch-resume-capability-second",
			// An existing background-capable client has not opted into PR monitoring.
			clientMeta: { "kimchi.dev": { backgroundRuns: true } },
			extraArgs: ["--yolo"],
			responses: [{ stream: ["Normal conversation still works."] }],
		})
		await second.conn.loadSession({ sessionId, cwd: target.cwd, mcpServers: [] })
		expect(second.client.agentTextBySession().get(sessionId)).toContain("Existing conversation.")
		expect(
			second.client.sessionUpdates.some(
				({ update }) =>
					update.sessionUpdate === "available_commands_update" &&
					update.availableCommands.some(({ name }) => name === "pr-watch"),
			),
		).toBe(false)
		// Outlast a real monitoring interval; saved user consent must not bypass the client gate.
		await new Promise((resolve) => setTimeout(resolve, 31_000))
		expect(chatRequests(second)).toHaveLength(0)
		expect(savedWatches()).toEqual(before)
		await second.conn.prompt({ sessionId, prompt: [{ type: "text", text: "Continue normally." }] })
		expect(second.client.agentTextBySession().get(sessionId)).toContain("Normal conversation still works.")
		expect(chatRequests(second).some((request) => requestAdvertisesTool(request, "pr_watch"))).toBe(false)
	} finally {
		await second?.stop()
		await first?.stop()
		vi.unstubAllEnvs()
		rmSync(root, { recursive: true, force: true })
	}
}, 60_000)
