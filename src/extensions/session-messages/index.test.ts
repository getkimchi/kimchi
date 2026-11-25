import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { listSubagents, messageSubagent } from "../agents/index.js"
import type { AgentRecord } from "../agents/personas/types.js"
import { clearPermissionModeEnv, setPermissionMode } from "../permissions/mode-controller.js"
import { unregisterSessionPermissionFlagController } from "../permissions/mode-controller-registry.js"
import { CROSS_SESSION_MESSAGE_TYPE, createSessionMessagesExtension, DISABLED_NOTICE, ENABLED_NOTICE } from "./index.js"

vi.mock("../agents/index.js", () => ({ listSubagents: vi.fn(), messageSubagent: vi.fn() }))

/** Delivery options: a TUI-only wake, since session_start skips other modes, so no ACP client has to opt in. */
const STEER_AND_WAKE = { deliverAs: "steer", triggerTurn: true }

const dirs: string[] = []
const running: Array<() => Promise<unknown>> = []

beforeEach(() => {
	vi.mocked(listSubagents).mockReturnValue([])
})

afterEach(async () => {
	for (const stop of running.splice(0)) await stop()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksm-"))
	dirs.push(dir)
	return join(dir, "live")
}

/** The saved choice beside the sockets' temp folder. */
const preferenceFile = (dir: string) => join(dirname(dir), "session-messages.json")
const savedPreference = (dir: string) => JSON.parse(readFileSync(preferenceFile(dir), "utf8")).enabled

async function startSession(
	dir: string,
	options: {
		id: string
		name: string
		idle?: boolean
		mode?: "tui" | "rpc"
		/** Folders that do not exist count as their own repository. */
		cwd?: string
		/** "unset" leaves the choice unasked; most cases run with messages allowed. */
		preference?: "on" | "unset"
		/** The user's answer if this session asks. */
		answer?: boolean
	},
) {
	if ((options.preference ?? "on") === "on") {
		mkdirSync(dirname(dir), { recursive: true })
		writeFileSync(preferenceFile(dir), JSON.stringify({ enabled: true }))
	}
	const harness = createExtensionApi()
	harness.api.getSessionName = () => options.name
	createSessionMessagesExtension({ dir, preferenceFile: preferenceFile(dir) })(harness.api)
	const ctx = createContext({
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? `/work/${options.name}`,
		isIdle: vi.fn(() => options.idle ?? true),
		sessionManager: { getSessionId: () => options.id },
		ui: { confirm: vi.fn(async () => options.answer ?? false) },
	})
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
	const stop = () => harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
	running.push(stop)
	const run = async (tool: string, params: Record<string, string>) => {
		const result = await harness
			.getRegisteredTool(tool)
			.execute(
				"call",
				params as never,
				undefined,
				undefined,
				createToolContext({ cwd: ctx.cwd, sessionManager: { getSessionId: () => options.id } }),
			)
		return (result.content[0] as { text: string }).text
	}
	return { harness, ctx, run, stop }
}

describe("session-messages", () => {
	it("lists live peers and steers a message into the target, which can reply", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000aaaaaa1", name: "alpha" })
		const beta = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "beta", idle: false })

		expect((statSync(dir).mode & 0o777).toString(8)).toBe("700")
		const listing = await alpha.run("list_agents", {})
		expect(listing).toContain("This session is alpha [aaaaa1]")
		expect(listing).toContain("beta [bbbbb2]  ·  busy  ·  /work/beta")
		expect(listing).not.toContain("alpha [aaaaa1]  ·")

		expect(await alpha.run("send_message", { to: "beta", message: "Run the tests, please." })).toContain(
			"Delivered to beta [bbbbb2]: it is busy and reads it when its current step ends",
		)
		expect(beta.harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: CROSS_SESSION_MESSAGE_TYPE,
				content: '<cross-session-message from="alpha [aaaaa1]">\nRun the tests, please.\n</cross-session-message>',
				display: true,
				details: { from: "alpha [aaaaa1]" },
			},
			STEER_AND_WAKE,
		)

		expect(await beta.run("send_message", { to: "alpha [aaaaa1]", message: "Tests pass." })).toContain(
			"Delivered to alpha [aaaaa1]: it was idle, so it starts a turn now",
		)
		expect(alpha.harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('from="beta [bbbbb2]">\nTests pass.') }),
			STEER_AND_WAKE,
		)
	})

	it("lists this session's subagents first and sends to one by its ID", async () => {
		const dir = tempDir()
		const alphaId = "0190aaaa-0000-7000-8000-00000aaaaaa1"
		const explorer = {
			id: "agent-7",
			type: "Explore",
			status: "running",
			description: "map the repo",
			startedAt: Date.now(),
		} as AgentRecord
		vi.mocked(listSubagents).mockImplementation((sessionId) => (sessionId === alphaId ? [explorer] : []))
		vi.mocked(messageSubagent).mockResolvedValue("Steering message sent to agent agent-7.")
		const alpha = await startSession(dir, { id: alphaId, name: "alpha" })
		await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "agent-7" })

		const listing = await alpha.run("list_agents", {})
		expect(listing).toContain("Subagents (1):\n  agent-7  ·  Explore  ·  running  ·  map the repo  ·  started just now")
		expect(listing.indexOf("Subagents (1)")).toBeLessThan(listing.indexOf("Peer sessions (1)"))
		// A session with the same name loses to the subagent, as in the listing order.
		expect(await alpha.run("send_message", { to: "agent-7", message: "Also list the tests." })).toBe(
			"Steering message sent to agent agent-7.",
		)
		expect(messageSubagent).toHaveBeenCalledWith("agent-7", "Also list the tests.")
	})

	it("asks for the full name when two sessions share one", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000aaaaaa1", name: "alpha" })
		await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "beta" })
		const twin = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000cccccc3", name: "beta" })

		const ambiguous = await alpha.run("send_message", { to: "beta", message: "hi" })
		expect(ambiguous).toContain('"beta" names 2 sessions')
		expect(ambiguous).toContain("beta [bbbbb2]")
		expect(ambiguous).toContain("beta [ccccc3]")
		expect(await alpha.run("send_message", { to: "beta [ccccc3]", message: "hi" })).toContain(
			"Delivered to beta [ccccc3]",
		)
		expect(twin.harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(await alpha.run("send_message", { to: "gamma", message: "hi" })).toContain(
			'No subagent or live session is called "gamma"',
		)
	})

	it("holds a message from another permission mode for the receiver's approval", async () => {
		const dir = tempDir()
		const strictId = "0190aaaa-0000-7000-8000-00000aaaaaa1"
		const looseId = "0190aaaa-0000-7000-8000-00000bbbbbb2"
		const strict = await startSession(dir, { id: strictId, name: "strict" })
		const loose = await startSession(dir, { id: looseId, name: "loose" })
		setPermissionMode(looseId, { mode: "yolo", initiatedBy: "user", source: "runtime" })
		try {
			vi.mocked(loose.ctx.ui.confirm).mockResolvedValue(true)
			expect(await strict.run("send_message", { to: "loose", message: "Delete the cache." })).toContain(
				"loose [bbbbb2] runs in another permission mode, so the message waits for its user's approval",
			)
			expect(loose.ctx.ui.confirm).toHaveBeenCalledWith(
				"Message from strict [aaaaa1]",
				expect.stringContaining("runs in default mode and this one in yolo"),
			)
			await vi.waitFor(() => expect(loose.harness.sendMessage).toHaveBeenCalledTimes(1))
		} finally {
			unregisterSessionPermissionFlagController(looseId)
			clearPermissionModeEnv(looseId)
		}
	})

	it("leaves sessions driven by a program out (ACP reports mode rpc)", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000aaaaaa1", name: "alpha" })
		const driven = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "driven", mode: "rpc" })

		expect(driven.harness.registerTool).not.toHaveBeenCalled()
		expect(existsSync(join(dir, "bbbbb2.sock"))).toBe(false)
		expect(await alpha.run("list_agents", {})).toContain("No other Kimchi session is running on this machine.")
	})

	it("asks once when another session works in the same repository, and yes lets them message each other", async () => {
		const dir = tempDir()
		const other = await startSession(dir, {
			id: "0190aaaa-0000-7000-8000-00000cccccc3",
			name: "other",
			cwd: "/work/elsewhere",
			preference: "unset",
		})
		const beta = await startSession(dir, {
			id: "0190aaaa-0000-7000-8000-00000bbbbbb2",
			name: "beta",
			cwd: "/work/shop",
			preference: "unset",
		})
		const alpha = await startSession(dir, {
			id: "0190aaaa-0000-7000-8000-00000aaaaaa1",
			name: "alpha",
			cwd: "/work/shop",
			preference: "unset",
			answer: true,
		})

		await vi.waitFor(() => expect(alpha.ctx.ui.notify).toHaveBeenCalledWith(ENABLED_NOTICE, "info"))
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledWith(
			"Let Kimchi sessions message each other?",
			expect.stringContaining("beta [bbbbb2] is working in this repository too (/work/shop)"),
		)
		// Neither earlier session had a session in its repository to ask about.
		expect(other.ctx.ui.confirm).not.toHaveBeenCalled()
		expect(beta.ctx.ui.confirm).not.toHaveBeenCalled()
		expect(savedPreference(dir)).toBe(true)
		expect(await alpha.run("list_agents", {})).toContain("beta [bbbbb2]  ·  idle  ·  /work/shop  ·  same repository")
		expect(await alpha.run("send_message", { to: "beta", message: "Take the checkout bug." })).toContain(
			"Delivered to beta [bbbbb2]",
		)
		// The running session gets the tools once its turn settles.
		expect(beta.harness.registerTool).not.toHaveBeenCalled()
		await beta.harness.emit("agent_settled", {}, beta.ctx)
		expect(await beta.run("send_message", { to: "alpha", message: "On it." })).toContain("Delivered to alpha")
	})

	it("saves a no without asking again, and /session-messages enable turns messages on later", async () => {
		const dir = tempDir()
		await startSession(dir, {
			id: "0190aaaa-0000-7000-8000-00000bbbbbb2",
			name: "beta",
			cwd: "/work/shop",
			preference: "unset",
		})
		const alpha = await startSession(dir, {
			id: "0190aaaa-0000-7000-8000-00000aaaaaa1",
			name: "alpha",
			cwd: "/work/shop",
			preference: "unset",
			answer: false,
		})

		await vi.waitFor(() => expect(alpha.ctx.ui.notify).toHaveBeenCalledWith(DISABLED_NOTICE, "info"))
		expect(savedPreference(dir)).toBe(false)
		expect(alpha.harness.registerTool).not.toHaveBeenCalled()
		await alpha.harness.emit("agent_settled", {}, alpha.ctx)
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledTimes(1)

		await alpha.harness.getRegisteredCommand("session-messages").handler("enable", alpha.ctx as never)
		expect(savedPreference(dir)).toBe(true)
		expect(alpha.ctx.ui.notify).toHaveBeenLastCalledWith(ENABLED_NOTICE, "info")
		expect(await alpha.run("send_message", { to: "beta", message: "hi" })).toContain("Delivered to beta [bbbbb2]")

		await alpha.harness.getRegisteredCommand("session-messages").handler("disable", alpha.ctx as never)
		expect(await alpha.run("send_message", { to: "beta", message: "hi" })).toBe(DISABLED_NOTICE)
	})

	it("drops closed sessions and removes sockets left by crashed ones", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000aaaaaa1", name: "alpha" })
		const beta = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "beta" })
		await beta.stop()
		const crashed = join(dir, "dead00.sock")
		spawnSync(process.execPath, [
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(crashed)}, () => process.kill(process.pid, "SIGKILL"))`,
		])
		expect(existsSync(crashed)).toBe(true)

		expect(await alpha.run("list_agents", {})).toContain("No other Kimchi session is running on this machine.")
		expect(existsSync(crashed)).toBe(false)
		expect(existsSync(join(dir, "aaaaa1.sock"))).toBe(true)
	})
})
