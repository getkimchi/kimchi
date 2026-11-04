// ACP integration — the `/btw` side chat (contract: docs/acp-side-chat.md).
//
// Drives the whole client flow over the wire with fake-model responses:
// open (snapshot + `opened` update) → prompt (user_message / assistant
// deltas + final) → wrap (draft) → send_to_main (closed, outcome "sent") →
// history. A second suite covers the resource gate: with
// `extensions.side-chat` off, every method fails with -32600 naming the
// resource.

import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitFor } from "./support/scenarios.js"

const SIDE_CHAT_UPDATE = "_kimchi.dev/side_chat_update"
const METHODS = {
	open: "_kimchi.dev/side_chat_open",
	prompt: "_kimchi.dev/side_chat_prompt",
	wrap: "_kimchi.dev/side_chat_wrap",
	sendToMain: "_kimchi.dev/side_chat_send_to_main",
	close: "_kimchi.dev/side_chat_close",
	history: "_kimchi.dev/side_chat_history",
	resume: "_kimchi.dev/side_chat_resume",
} as const

interface SideChatUpdateNotification {
	sessionId: string
	sideChatId: string
	update: { type: string; text?: string; snapshot?: { thread?: unknown[] }; [key: string]: unknown }
}

function sideChatUpdates(fixture: AcpFixture, sessionId: string): SideChatUpdateNotification[] {
	return fixture.client.extNotifications
		.filter((n) => n.method === SIDE_CHAT_UPDATE)
		.map((n) => n.params as SideChatUpdateNotification)
		.filter((p) => p.sessionId === sessionId)
}

async function waitForUpdate(
	fixture: AcpFixture,
	sessionId: string,
	type: string,
): Promise<SideChatUpdateNotification> {
	const found = await waitFor(
		(): SideChatUpdateNotification | undefined =>
			sideChatUpdates(fixture, sessionId).find((n) => n.update.type === type),
		(update) => update !== undefined,
	)
	if (!found) throw new Error(`unreachable: waitFor returned undefined for ${type}`)
	return found
}

describe("ACP integration — side chat over the wire", () => {
	let fixture: AcpFixture
	const realEnableEnv = process.env.KIMCHI_ENABLE_RESOURCES

	afterEach(async () => {
		if (realEnableEnv === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
		else process.env.KIMCHI_ENABLE_RESOURCES = realEnableEnv
		await fixture?.stop()
	})

	it(
		"advertises the side_chat capabilities in the initialize _meta",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.side-chat"
			fixture = await startAcpFixture({
				artifactName: "side-chat-capabilities",
				responses: [{ stream: ["unused"] }],
			})
			const meta = fixture.initializeResponse.agentCapabilities?._meta as Record<string, unknown> | undefined
			const vendor = meta?.["kimchi.dev"] as Record<string, boolean> | undefined
			for (const name of [
				"side_chat_open",
				"side_chat_prompt",
				"side_chat_wrap",
				"side_chat_send_to_main",
				"side_chat_close",
				"side_chat_history",
				"side_chat_resume",
			]) {
				expect(vendor?.[name]).toBe(true)
			}
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"open → prompt streams the side-thread updates; wrap → send_to_main closes with outcome sent",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.side-chat"
			// Scripted responses, in order: (1) the side chat's answer,
			// (2) the /wrap draft, (3) the main session's turn that
			// send_to_main steers, (4) slack for auxiliary calls (title/session
			// naming) that may consume scripted responses.
			fixture = await startAcpFixture({
				artifactName: "side-chat-wire-flow",
				responses: [
					{ stream: ["side answer"] },
					{ stream: ["do the thing"] },
					{ stream: ["main answer"] },
					{ stream: ["spare"] },
					{ stream: ["spare"] },
					{ stream: ["spare"] },
				],
			})
			const sessionId = await newSession(fixture, fixture.workDir)

			const snapshot = (await fixture.conn.extMethod(METHODS.open, { sessionId })) as Record<string, unknown>
			expect(snapshot).toMatchObject({ fresh: false, contextLength: 0, closed: false })
			const sideChatId = snapshot.id as string

			const openNotification = await waitForUpdate(fixture, sessionId, "opened")
			expect(openNotification.sideChatId).toBe(sideChatId)

			const promptResult = (await fixture.conn.extMethod(METHODS.prompt, {
				sessionId,
				text: "what is X?",
			})) as Record<string, unknown>
			expect(promptResult).toEqual({ status: "started" })

			const settled = await waitForUpdate(fixture, sessionId, "assistant_message")
			expect(settled.update.text).toBe("side answer")
			expect(sideChatUpdates(fixture, sessionId).some((n) => n.update.type === "user_message")).toBe(true)
			expect(sideChatUpdates(fixture, sessionId).some((n) => n.update.type === "assistant_delta")).toBe(true)

			const { draft } = (await fixture.conn.extMethod(METHODS.wrap, { sessionId })) as { draft: string }
			expect(draft).toBe("do the thing")
			const finalDraft = await waitForUpdate(fixture, sessionId, "wrap_draft")
			expect(finalDraft.update.text).toBeDefined()

			await fixture.conn.extMethod(METHODS.sendToMain, { sessionId, text: draft })
			const closed = await waitForUpdate(fixture, sessionId, "closed")
			expect(closed.update).toMatchObject({ outcome: "sent" })

			// The record is persisted before the chat closes, so history is
			// deterministic once the closed notification has been observed.
			const history = (await fixture.conn.extMethod(METHODS.history, { sessionId })) as {
				chats: Array<Record<string, unknown>>
			}
			expect(history.chats[0]).toMatchObject({ id: sideChatId, title: "what is X?", questions: 1, outcome: "sent" })
		},
		STARTUP_TIMEOUT_MS + PROMPT_TIMEOUT_MS,
	)

	it(
		"resume replays the stored thread through a snapshot",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.side-chat"
			fixture = await startAcpFixture({
				artifactName: "side-chat-resume",
				responses: [{ stream: ["remembered answer"] }, { stream: ["spare"] }, { stream: ["spare"] }],
			})
			const sessionId = await newSession(fixture, fixture.workDir)

			const opened = (await fixture.conn.extMethod(METHODS.open, { sessionId })) as Record<string, unknown>
			await fixture.conn.extMethod(METHODS.prompt, { sessionId, text: "remember this" })
			await waitForUpdate(fixture, sessionId, "assistant_message")
			await fixture.conn.extMethod(METHODS.close, { sessionId })
			await waitForUpdate(fixture, sessionId, "closed")

			const resumed = (await fixture.conn.extMethod(METHODS.resume, {
				sessionId,
				sideChatId: opened.id as string,
			})) as { thread: Array<{ role: string; text: string }> }
			expect(resumed.thread).toEqual([
				{ role: "user", text: "remember this" },
				{ role: "assistant", text: "remembered answer" },
			])
		},
		STARTUP_TIMEOUT_MS + PROMPT_TIMEOUT_MS,
	)

	it(
		"fails with -32600 naming the resource when the side chat is disabled",
		async () => {
			delete process.env.KIMCHI_ENABLE_RESOURCES
			fixture = await startAcpFixture({
				artifactName: "side-chat-disabled",
				responses: [{ stream: ["unused"] }],
			})
			const sessionId = await newSession(fixture, fixture.workDir)

			await expect(fixture.conn.extMethod(METHODS.open, { sessionId })).rejects.toMatchObject({
				code: -32600,
				message: expect.stringContaining("extensions.side-chat"),
			})
			await expect(fixture.conn.extMethod(METHODS.history, { sessionId })).rejects.toMatchObject({ code: -32600 })
		},
		STARTUP_TIMEOUT_MS,
	)
})
