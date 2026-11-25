import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import type { AutocompleteSuggestions } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { testTheme } from "../__mocks__/theme.js"
import { listSubagents, messageSubagent } from "../agents/index.js"
import type { AgentRecord } from "../agents/personas/types.js"
import { clearPermissionModeEnv, setPermissionMode } from "../permissions/mode-controller.js"
import { unregisterSessionPermissionFlagController } from "../permissions/mode-controller-registry.js"
import {
	CROSS_SESSION_MESSAGE_TYPE,
	CROSS_SESSION_NOTICE_TYPE,
	CROSS_SESSION_SENT_TYPE,
	createSessionMessagesExtension,
	DISABLED_NOTICE,
	ENABLED_NOTICE,
	liveSessions,
	OFFER_TITLE,
	replyHint,
	TAG_TITLE,
	userHint,
} from "./index.js"
import { setSessionMessagesPermitted } from "./session-policy.js"

vi.mock("../agents/index.js", () => ({ listSubagents: vi.fn(), messageSubagent: vi.fn() }))
/** Whether this process runs as Kimchi's ACP server; most cases run in the TUI. */
const acp = vi.hoisted(() => ({ server: false }))
vi.mock("../../modes/acp/state.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get IS_ACP_MODE() {
		return acp.server
	},
}))

/** Delivery options: a wake only TUI sessions and ACP clients with the session-messages opt-in get; nothing else opens an inbox. */
const STEER_AND_WAKE = { deliverAs: "steer", triggerTurn: true }
const ALPHA = "0190aaaa-0000-7000-8000-00000aaaaaa1"
const BETA = "0190aaaa-0000-7000-8000-00000bbbbbb2"
const GAMMA = "0190aaaa-0000-7000-8000-00000cccccc3"

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
	/** The user presses Enter on this prompt: the input handlers' results. */
	const type = (text: string) => harness.emit("input", { type: "input", text, source: "interactive" }, ctx)
	return { harness, ctx, run, stop, type }
}

/** A folder Git reports on that branch, without running Git. */
function repository(dir: string, branch: string): string {
	const folder = join(dirname(dir), branch.replaceAll("/", "-"))
	mkdirSync(join(folder, ".git"), { recursive: true })
	writeFileSync(join(folder, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
	return folder
}

/** This session's @ list over a file list that offers `files`. */
function atList(session: Awaited<ReturnType<typeof startSession>>, files: AutocompleteSuggestions | null = null) {
	const wrap = vi.mocked(session.ctx.ui.addAutocompleteProvider).mock.calls[0][0]
	const provider = wrap({ getSuggestions: async () => files, applyCompletion: vi.fn() })
	return (line: string) => provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal })
}

/** The agent is about to start a subagent: the tool_call results, one per handler. */
const startSubagent = (session: Awaited<ReturnType<typeof startSession>>, description = "Count the TODOs") =>
	session.harness.emit(
		"tool_call",
		{
			type: "tool_call",
			toolName: "Agent",
			toolCallId: "call",
			input: { description, prompt: description, subagent_type: "general-purpose" },
		},
		session.ctx,
	)

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
				content: `<cross-session-message from="alpha [aaaaa1]">\nRun the tests, please.\n</cross-session-message>\n${replyHint("alpha [aaaaa1]")}`,
				display: true,
				details: { from: "alpha [aaaaa1]", text: "Run the tests, please." },
			},
			STEER_AND_WAKE,
		)
		// Its user sees who wrote and what, not the wrapper and reply line meant for the model.
		const render = beta.harness.registerMessageRenderer.mock.calls[0][1]
		const screen = stripVTControlCharacters(
			render(
				{ details: { from: "alpha [aaaaa1]", text: "Run the tests, please." } } as never,
				{ expanded: false, outputPad: 1 },
				testTheme,
			)
				?.render(80)
				.join("\n") ?? "",
		)
		expect(screen).toContain("Message from alpha [aaaaa1]")
		expect(screen).toContain("Run the tests, please.")
		expect(screen).not.toContain("cross-session-message")
		// Answers only when asked: two agents thanking each other would wake each other forever.
		expect(replyHint("alpha [aaaaa1]")).toBe(
			'That session does not see your replies here. If it asks you something, answer with send_message to "alpha [aaaaa1]"; send no thanks or acknowledgements, since every message wakes it.',
		)
		// A longer message shows its first line until ctrl+o expands it.
		const longer = (expanded: boolean) =>
			stripVTControlCharacters(
				render(
					{ details: { from: "alpha [aaaaa1]", text: "Run the tests, please.\nThen send me the failures." } } as never,
					{ expanded, outputPad: 1 },
					testTheme,
				)
					?.render(80)
					.join("\n") ?? "",
			)
		expect(longer(false)).toContain("Run the tests, please. (ctrl+o to expand)")
		expect(longer(false)).not.toContain("Then send me the failures.")
		expect(longer(true)).toContain("Then send me the failures.")

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
				"loose [bbbbb2] runs in another permission mode, so the message waits up to 5 minutes for its user's approval.",
			)
			expect(loose.ctx.ui.confirm).toHaveBeenCalledWith(
				"Message from strict [aaaaa1]",
				expect.stringContaining("runs in default mode and this one in yolo"),
				{ timeout: 5 * 60_000 },
			)
			await vi.waitFor(() => expect(loose.harness.sendMessage).toHaveBeenCalledTimes(1))
		} finally {
			unregisterSessionPermissionFlagController(looseId)
			clearPermissionModeEnv(looseId)
		}
	})

	it("tells the sender when its held message is declined or expires", async () => {
		const dir = tempDir()
		const strictId = "0190aaaa-0000-7000-8000-00000aaaaaa1"
		const looseId = "0190aaaa-0000-7000-8000-00000bbbbbb2"
		const strict = await startSession(dir, { id: strictId, name: "strict" })
		const loose = await startSession(dir, { id: looseId, name: "loose" })
		setPermissionMode(looseId, { mode: "yolo", initiatedBy: "user", source: "runtime" })
		try {
			await strict.run("send_message", { to: "loose", message: "Delete the cache." })
			await vi.waitFor(() =>
				expect(strict.harness.sendMessage).toHaveBeenCalledWith(
					{
						customType: CROSS_SESSION_NOTICE_TYPE,
						content: "Your message to loose [bbbbb2] was not delivered: its user declined it.",
						display: true,
						details: { title: "Not delivered to loose [bbbbb2]", text: "Its user declined it." },
					},
					STEER_AND_WAKE,
				),
			)
			expect(loose.harness.sendMessage).not.toHaveBeenCalled()

			// The dialog's own timeout answers no as well: five minutes later the notice says it expired.
			vi.mocked(loose.ctx.ui.confirm).mockImplementationOnce(async () => {
				const shown = Date.now()
				vi.spyOn(Date, "now").mockReturnValue(shown + 5 * 60_000)
				return false
			})
			await strict.run("send_message", { to: "loose", message: "Delete the cache, please." })
			await vi.waitFor(() =>
				expect(strict.harness.sendMessage).toHaveBeenLastCalledWith(
					expect.objectContaining({
						content: "Your message to loose [bbbbb2] was not delivered: its user did not answer within 5 minutes.",
					}),
					STEER_AND_WAKE,
				),
			)
		} finally {
			vi.restoreAllMocks()
			unregisterSessionPermissionFlagController(looseId)
			clearPermissionModeEnv(looseId)
		}
	})

	it("stops a chain after 8 messages without a user; the user's own words start it again", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha" })
		const beta = await startSession(dir, { id: BETA, name: "beta" })
		for (let hop = 1; hop <= 8; hop++) {
			const [from, to] = hop % 2 === 1 ? [beta, "alpha"] : [alpha, "beta"]
			expect(await from.run("send_message", { to, message: `Hop ${hop}.` })).toContain("Delivered to")
		}
		const refused =
			"Not sent: 8 messages have passed between sessions since a user last wrote. Ask your user before sending more."
		expect(await beta.run("send_message", { to: "alpha", message: "Thanks!" })).toBe(refused)
		// Input another extension injects is not a user.
		await beta.harness.emit("input", { type: "input", text: "nudge", source: "extension" }, beta.ctx)
		expect(await beta.run("send_message", { to: "alpha", message: "Thanks!" })).toBe(refused)
		// Words the user writes to beta from another session count like typing in beta, so a team keeps working.
		expect(await alpha.type("@beta keep going")).toEqual([{ action: "handled" }])
		expect(await beta.run("send_message", { to: "alpha", message: "Done." })).toContain("Delivered to alpha")
	})

	it("puts live sessions at the top of the @ list with their branch, state and folder", async () => {
		const dir = tempDir()
		const shop = repository(dir, "fix/rounding")
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha" })
		await startSession(dir, { id: BETA, name: "beta", cwd: shop, idle: false })
		await startSession(dir, { id: GAMMA, name: "Checkout rounding" })
		// The folder is the tag when no other session answers to it; the name the session picked shows beside it.
		const beta = { value: "@fix-rounding", label: "@fix-rounding", description: "fix/rounding · busy · beta" }
		const checkout = {
			value: '@"Checkout rounding"',
			label: '@"Checkout rounding"',
			description: "idle · /work/Checkout rounding",
		}
		const file = { value: "@src/", label: "src/" }

		const all = await atList(alpha, { prefix: "@", items: [file] })("@")
		expect(all?.prefix).toBe("@")
		expect(all?.items).toHaveLength(3)
		expect(all?.items).toEqual(expect.arrayContaining([beta, checkout]))
		expect(all?.items.at(-1)).toEqual(file)
		// Typing narrows by folder, branch or name, with or without matching files.
		expect(await atList(alpha)("@fix/r")).toEqual({ prefix: "@fix/r", items: [beta] })
		// A session already tagged is not offered again.
		expect(await atList(alpha)("@beta and @")).toEqual({ prefix: "@", items: [checkout] })
		// The session itself is never listed.
		expect((await atList(alpha)("@alpha"))?.items ?? []).toEqual([])
	})

	it("writes leading tags straight to those sessions as the user's words; other tags go to the agent", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha" })
		const beta = await startSession(dir, { id: BETA, name: "beta", idle: false })
		const checkout = await startSession(dir, { id: GAMMA, name: "Checkout rounding" })
		// The user's own words need no approval in another permission mode: they could type them there.
		setPermissionMode(BETA, { mode: "yolo", initiatedBy: "user", source: "runtime" })
		try {
			expect(await alpha.type('@beta @"Checkout rounding": use v2 instead')).toEqual([{ action: "handled" }])
			expect(beta.ctx.ui.confirm).not.toHaveBeenCalled()
			expect(beta.harness.sendMessage).toHaveBeenCalledWith(
				{
					customType: CROSS_SESSION_MESSAGE_TYPE,
					content: `<cross-session-message from="alpha [aaaaa1]" by="user">\nuse v2 instead\n</cross-session-message>\n${userHint("alpha [aaaaa1]")}`,
					display: true,
					details: { from: "alpha [aaaaa1]", text: "use v2 instead", title: "From you in alpha [aaaaa1]" },
				},
				STEER_AND_WAKE,
			)
			expect(checkout.harness.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ details: expect.objectContaining({ text: "use v2 instead" }) }),
				STEER_AND_WAKE,
			)
			// This session starts no turn; it keeps a record its agent reads when answers come back.
			expect(alpha.harness.sendMessage).toHaveBeenCalledWith(
				{
					customType: CROSS_SESSION_SENT_TYPE,
					content: "Your user wrote this straight to beta [bbbbb2], Checkout rounding [ccccc3]:\nuse v2 instead",
					display: true,
					details: { title: "To beta [bbbbb2], Checkout rounding [ccccc3]", text: "use v2 instead" },
				},
				{ triggerTurn: false },
			)

			// Tags inside the sentence leave it to the agent, which has the tools by now.
			expect(await alpha.type('ask @beta and @"Checkout rounding" to agree on the endpoint')).toEqual([undefined])
			expect(alpha.harness.registerTool).toHaveBeenCalled()
			expect(beta.harness.sendMessage).toHaveBeenCalledTimes(1)
			// A word that tags no live session is plain text.
			expect(await alpha.type("@gamma use v2")).toEqual([undefined])
			expect(await alpha.run("send_message", { to: '@"Checkout rounding"', message: "Agree with beta." })).toContain(
				"Delivered to Checkout rounding [ccccc3]",
			)
		} finally {
			unregisterSessionPermissionFlagController(BETA)
			clearPermissionModeEnv(BETA)
		}
	})

	it("still finds a tagged session by its folder after the session renames itself", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha" })
		// Sessions pick a name after their first turn; a tag picked before that names the folder.
		const shipping = await startSession(dir, { id: BETA, name: "Add express shipping", cwd: "/work/shop-shipping" })
		expect((await atList(alpha)("@ship"))?.items).toEqual([
			{ value: "@shop-shipping", label: "@shop-shipping", description: "idle · Add express shipping" },
		])
		expect(await alpha.type("@shop-shipping make it 9.90")).toEqual([{ action: "handled" }])
		expect(shipping.harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: expect.objectContaining({ text: "make it 9.90" }) }),
			STEER_AND_WAKE,
		)
		expect(await alpha.run("send_message", { to: "@shop-shipping", message: "And a test." })).toContain(
			"Delivered to Add express shipping [bbbbb2]",
		)
	})

	it("gives the prompt back when no tagged session takes it", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha" })
		// A session that answers who it is, then turns the message away.
		const refusing = net.createServer((socket) =>
			socket.once("data", (data) => {
				const request = JSON.parse(String(data))
				const info = {
					name: "web",
					ref: "fffff1",
					cwd: "/work/web",
					repository: "/work/web",
					state: "idle",
					startedAt: 1,
				}
				socket.end(
					`${JSON.stringify(request.type === "info" ? { ok: true, info } : { ok: false, error: "it is shutting down" })}\n`,
				)
			}),
		)
		await new Promise<void>((resolve) => refusing.listen(join(dir, "fffff1.sock"), resolve))
		running.push(() => new Promise((resolve) => refusing.close(resolve)))

		expect(await alpha.type("@web use v2 instead")).toEqual([{ action: "handled" }])
		expect(alpha.ctx.ui.notify).toHaveBeenCalledWith("Not delivered to web [fffff1]: it is shutting down.", "warning")
		expect(alpha.ctx.ui.setEditorText).toHaveBeenCalledWith("@web use v2 instead")
		expect(alpha.harness.sendMessage).not.toHaveBeenCalled()
	})

	it("asks once when a prompt tags a session before messages were allowed", async () => {
		const dir = tempDir()
		const beta = await startSession(dir, { id: BETA, name: "beta", preference: "unset" })
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha", preference: "unset", answer: true })

		// The @ list shows sessions before the choice, so the user can find them.
		expect((await atList(alpha)("@"))?.items.map(({ value }) => value)).toEqual(["@beta"])
		expect(await alpha.type("@beta use v2 instead")).toEqual([{ action: "handled" }])
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledWith(
			TAG_TITLE,
			"You tagged “beta”, another session on this machine. Turn on session messages so I can reach it? Your choice is saved for future sessions; /session-messages changes it.",
		)
		expect(savedPreference(dir)).toBe(true)
		expect(beta.harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("after a no, tags stay plain text and the @ list shows only files", async () => {
		const dir = tempDir()
		const beta = await startSession(dir, { id: BETA, name: "beta", preference: "unset" })
		const alpha = await startSession(dir, { id: ALPHA, name: "alpha", preference: "unset", answer: false })

		expect(await alpha.type("@beta use v2 instead")).toEqual([undefined])
		expect(savedPreference(dir)).toBe(false)
		expect(beta.harness.sendMessage).not.toHaveBeenCalled()
		expect(alpha.harness.registerTool).not.toHaveBeenCalled()
		const files = { prefix: "@", items: [{ value: "@src/", label: "src/" }] }
		expect(await atList(alpha, files)("@")).toBe(files)
		expect(await alpha.type("@beta again")).toEqual([undefined])
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledTimes(1)
	})

	it("over ACP, takes part only when the client opted in, and refuses what it would have to ask about", async () => {
		const dir = tempDir()
		const tui = await startSession(dir, { id: ALPHA, name: "tui" })
		acp.server = true
		try {
			setSessionMessagesPermitted(false)
			const plain = await startSession(dir, { id: BETA, name: "plain", mode: "rpc" })
			expect(plain.harness.registerTool).not.toHaveBeenCalled()
			expect(plain.harness.registerCommand).not.toHaveBeenCalled()
			expect(existsSync(join(dir, "bbbbb2.sock"))).toBe(false)
			expect(await plain.type("@tui use v2")).toEqual([])

			setSessionMessagesPermitted(true)
			const studio = await startSession(dir, { id: GAMMA, name: "studio", mode: "rpc" })
			expect(studio.harness.registerTool).toHaveBeenCalled()
			// The client draws its own @ list, from _kimchi.dev/live_sessions.
			expect(studio.ctx.ui.addAutocompleteProvider).not.toHaveBeenCalled()
			expect(await tui.run("send_message", { to: "studio", message: "Run the tests." })).toContain(
				"Delivered to studio [ccccc3]",
			)
			// A leading tag goes through the agent, whose reply the client shows; a prompt handled here would end blank.
			expect(await studio.type("@tui use v2")).toEqual([undefined])
			expect(tui.harness.sendMessage).toHaveBeenCalledTimes(0)

			// Kimchi may not ask an ACP client's user between turns, so another mode's message is refused at once.
			setPermissionMode(GAMMA, { mode: "yolo", initiatedBy: "user", source: "runtime" })
			expect(await tui.run("send_message", { to: "studio", message: "Delete the cache." })).toBe(
				"Not delivered to studio [ccccc3]: it runs in yolo mode in an app where Kimchi cannot ask its user, and your session runs in default mode.",
			)
			expect(studio.ctx.ui.confirm).not.toHaveBeenCalled()
		} finally {
			acp.server = false
			setSessionMessagesPermitted(false)
			unregisterSessionPermissionFlagController(GAMMA)
			clearPermissionModeEnv(GAMMA)
		}
	})

	it("gives an ACP client the list its @ list needs", async () => {
		const dir = tempDir()
		const shop = repository(dir, "fix/rounding")
		await startSession(dir, { id: BETA, name: "beta", cwd: shop })
		await startSession(dir, { id: GAMMA, name: "beta" })
		const sessions = await liveSessions(ALPHA, shop, { dir, preferenceFile: preferenceFile(dir) })
		expect(sessions).toHaveLength(2)
		expect(sessions).toEqual(
			expect.arrayContaining([
				{
					tag: "@fix-rounding",
					name: "beta",
					ref: "bbbbb2",
					branch: "fix/rounding",
					state: "idle",
					cwd: shop,
					sameRepository: true,
				},
				{
					tag: '@"beta [ccccc3]"',
					name: "beta",
					ref: "ccccc3",
					branch: null,
					state: "idle",
					cwd: "/work/beta",
					sameRepository: false,
				},
			]),
		)
		writeFileSync(preferenceFile(dir), JSON.stringify({ enabled: false }))
		expect(await liveSessions(ALPHA, shop, { dir, preferenceFile: preferenceFile(dir) })).toEqual([])
	})

	it("leaves sessions driven by a program out (Pi's own RPC mode)", async () => {
		const dir = tempDir()
		const alpha = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000aaaaaa1", name: "alpha" })
		const driven = await startSession(dir, { id: "0190aaaa-0000-7000-8000-00000bbbbbb2", name: "driven", mode: "rpc" })

		expect(driven.harness.registerTool).not.toHaveBeenCalled()
		expect(existsSync(join(dir, "bbbbb2.sock"))).toBe(false)
		expect(await alpha.run("list_agents", {})).toContain("No other Kimchi session is running on this machine.")
	})

	it("asks once, when the agent is about to start a subagent while another session works in the same repository", async () => {
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

		// Nothing is asked at startup, nor for a subagent with no other session in its repository.
		expect(await startSubagent(other)).toEqual([undefined])
		expect(other.ctx.ui.confirm).not.toHaveBeenCalled()
		expect(alpha.ctx.ui.confirm).not.toHaveBeenCalled()

		// Yes stops that subagent and tells the agent where the work can go instead.
		expect(await startSubagent(alpha, "Fix checkout rounding")).toEqual([
			{
				block: true,
				reason: expect.stringContaining(
					'If “Fix checkout rounding” is related to that session\'s work, send it with send_message to "beta [bbbbb2]"; if it is unrelated, start this subagent again.',
				),
			},
		])
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledWith(
			OFFER_TITLE,
			expect.stringContaining(
				"I see you have a session open in this repository, “beta”, that may already know this work. I can ask it instead of starting a subagent.",
			),
		)
		expect(alpha.ctx.ui.notify).toHaveBeenCalledWith(ENABLED_NOTICE, "info")
		expect(savedPreference(dir)).toBe(true)
		// The rest of that turn's subagents wait too, so the agent picks where each one goes.
		expect(await startSubagent(alpha)).toEqual([
			{ block: true, reason: expect.stringContaining("If “Count the TODOs” is related to that session's work") },
		])
		await alpha.harness.emit("turn_end", { type: "turn_end" }, alpha.ctx)
		expect(await startSubagent(alpha)).toEqual([undefined])
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledTimes(1)
		expect(beta.ctx.ui.confirm).not.toHaveBeenCalled()

		expect(await alpha.run("list_agents", {})).toContain("beta [bbbbb2]  ·  idle  ·  /work/shop  ·  same repository")
		expect(await alpha.run("send_message", { to: "beta", message: "Take the checkout bug." })).toContain(
			"Delivered to beta [bbbbb2]",
		)
		// The message itself gives the session that started before the answer its tools, so it can reply
		// in the turn the message starts.
		expect(beta.harness.registerTool).toHaveBeenCalled()
		expect(await beta.run("send_message", { to: "alpha", message: "On it." })).toContain("Delivered to alpha")
	})

	it("saves a no and lets the subagent start; /session-messages enable turns messages on later", async () => {
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

		// Two subagents started together share one question.
		expect(await Promise.all([startSubagent(alpha), startSubagent(alpha)])).toEqual([[undefined], [undefined]])
		expect(alpha.ctx.ui.confirm).toHaveBeenCalledTimes(1)
		expect(alpha.ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(alpha.ctx.ui.notify).toHaveBeenCalledWith(DISABLED_NOTICE, "info")
		expect(savedPreference(dir)).toBe(false)
		expect(alpha.harness.registerTool).not.toHaveBeenCalled()
		await startSubagent(alpha)
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
