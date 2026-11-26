import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { requestAdvertisesTool } from "../tui/support/mcp-model-script.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

const liveDir = (homeDir: string) => join(homeDir, ".config", "kimchi", "live-sessions")

/** macOS caps a socket path at 104 bytes, which its default temp folder nearly fills; real homes are short. */
const shortHome = () => mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "kacp-"))

function sockets(homeDir: string): string[] {
	try {
		return readdirSync(liveDir(homeDir)).filter((file) => file.endsWith(".sock"))
	} catch {
		return []
	}
}

/** The profile's yes, so only the client's flags decide. */
function allowMessages(homeDir: string): void {
	const harness = join(homeDir, ".config", "kimchi", "harness")
	mkdirSync(harness, { recursive: true })
	writeFileSync(join(harness, "session-messages.json"), JSON.stringify({ enabled: true }))
}

/** Every slash command the agent advertised to the client so far. */
function advertisedCommands(fixture: AcpFixture): string[] {
	return fixture.client.sessionUpdates.flatMap(({ update }) =>
		update.sessionUpdate === "available_commands_update" ? update.availableCommands.map(({ name }) => name) : [],
	)
}

/** One request to a session's socket, one reply, as the sessions themselves talk. */
function ask(path: string, request: object): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path)
		let buffer = ""
		socket.setEncoding("utf8")
		socket.on("data", (chunk: string) => {
			buffer += chunk
			if (buffer.includes("\n")) {
				resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))))
				socket.destroy()
			}
		})
		socket.on("error", reject)
		socket.write(`${JSON.stringify(request)}\n`)
	})
}

it.each([
	{ name: "no flags", flags: { backgroundRuns: false } },
	{ name: "background runs only", flags: { backgroundRuns: true } },
	{ name: "session messages without background runs", flags: { backgroundRuns: false, sessionMessages: true } },
])("keeps session messages out with $name", async ({ name, flags }) => {
	const homeDir = shortHome()
	const fixture = await startAcpFixture({
		artifactName: `session-messages-${name.replaceAll(" ", "-")}`,
		clientMeta: { "kimchi.dev": flags },
		homeDirOverride: homeDir,
		responses: [{ stream: ["Normal conversation works."] }],
	})
	try {
		expect(fixture.initializeResponse.agentCapabilities?._meta?.["kimchi.dev"]).toMatchObject({
			sessionMessages: true,
			live_sessions: true,
		})
		allowMessages(fixture.homeDir)
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Reply briefly.")).stopReason).toBe("end_turn")
		expect(sockets(fixture.homeDir)).toEqual([])
		expect(chatRequests(fixture).some((request) => requestAdvertisesTool(request, "message_agent"))).toBe(false)
		expect(advertisedCommands(fixture)).not.toContain("session-messages")
		await expect(fixture.conn.request("_kimchi.dev/live_sessions", { sessionId })).rejects.toThrow()
	} finally {
		await fixture.stop()
		rmSync(homeDir, { recursive: true, force: true })
	}
})

it("an opted-in client lists sessions for its @ list and shows a received message as a background run", async () => {
	const homeDir = shortHome()
	const fixture = await startAcpFixture({
		artifactName: "session-messages-opted-in",
		clientMeta: { "kimchi.dev": { backgroundRuns: true, sessionMessages: true } },
		homeDirOverride: homeDir,
		responses: [{ stream: ["Ready."] }, { stream: ["On it: running the tests."] }],
	})
	// Another session on the machine, as far as the socket folder can tell.
	const web = net.createServer((socket) => {
		socket.once("data", () => {
			const info = {
				name: "web",
				ref: "fffff1",
				cwd: "/work/web",
				repository: "/work/web",
				branch: "feat/v2-endpoint",
				state: "idle",
				startedAt: Date.now(),
			}
			socket.end(`${JSON.stringify({ ok: true, info })}\n`)
		})
	})
	try {
		allowMessages(fixture.homeDir)
		mkdirSync(liveDir(fixture.homeDir), { recursive: true, mode: 0o700 })
		await new Promise<void>((resolve) => web.listen(join(liveDir(fixture.homeDir), "fffff1.sock"), resolve))
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Reply briefly.")).stopReason).toBe("end_turn")
		expect(chatRequests(fixture).some((request) => requestAdvertisesTool(request, "message_agent"))).toBe(true)
		expect(advertisedCommands(fixture)).toContain("session-messages")

		expect(await fixture.conn.request("_kimchi.dev/live_sessions", { sessionId })).toEqual({
			sessions: [
				{
					tag: "@web",
					name: "web",
					ref: "fffff1",
					branch: "feat/v2-endpoint",
					state: "idle",
					cwd: "/work/web",
					sameRepository: false,
				},
			],
		})

		const own = sockets(fixture.homeDir).filter((file) => file !== "fffff1.sock")
		expect(own).toHaveLength(1)
		const message = { type: "message", from: "web [fffff1]", ref: "fffff1", mode: "default", hops: 1 }
		expect(await ask(join(liveDir(fixture.homeDir), own[0]), { ...message, text: "Please run the tests." })).toEqual({
			ok: true,
		})
		await waitForSessionUpdate(
			fixture,
			sessionId,
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text" &&
				update.content.text.includes("On it: running the tests."),
			45_000,
		)
		expect(fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start")).toEqual([
			{ method: "_kimchi.dev/background_run_start", params: expect.objectContaining({ sessionId }) },
		])
	} finally {
		web.close()
		await fixture.stop()
		rmSync(homeDir, { recursive: true, force: true })
	}
})
