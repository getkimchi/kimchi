// ACP integration: memory + resource control ext-methods.
//
// `_kimchi.dev/set_memory_enabled` flips the session-scoped memory runtime
// toggle — observable on the wire as the presence/absence of the memory
// enabled-notice in the model-facing system prompt of the chat requests the
// built binary sends. The store/resource methods (list, status,
// set_resource_enabled round-trip, the reset confirm gate) run against the
// fixture's isolated home.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const LIST_RESOURCES = "_kimchi.dev/list_resources"
const SET_RESOURCE_ENABLED = "_kimchi.dev/set_resource_enabled"
const MEMORY_STATUS = "_kimchi.dev/memory_status"
const SET_MEMORY_ENABLED = "_kimchi.dev/set_memory_enabled"
const MEMORY_LIST = "_kimchi.dev/memory_list"
const MEMORY_RESET = "_kimchi.dev/memory_reset"

/** The stable marker from the memory enabled-notice (inject.ts). */
const NOTICE_MARKER = "Persistent memory is enabled"

describe("ACP integration — memory control ext-methods", () => {
	let fixture: AcpFixture
	const realEnableEnv = process.env.KIMCHI_ENABLE_RESOURCES
	const realCaptureEnv = process.env.KIMCHI_MEMORY_CAPTURE

	beforeEach(() => {
		// Transient resource enablement (the documented KIMCHI_ENABLE_RESOURCES
		// layer) so the memory extension loads in the spawned binary; capture
		// stays off so no detached workers are spawned at session shutdown.
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.memory"
		process.env.KIMCHI_MEMORY_CAPTURE = "off"
	})

	afterEach(async () => {
		if (realEnableEnv === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
		else process.env.KIMCHI_ENABLE_RESOURCES = realEnableEnv
		if (realCaptureEnv === undefined) delete process.env.KIMCHI_MEMORY_CAPTURE
		else process.env.KIMCHI_MEMORY_CAPTURE = realCaptureEnv
		await fixture.stop()
	})

	it(
		"set_memory_enabled flips the session's memory on and off from the next turn",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "memory-control-toggle",
				responses: Array.from({ length: 5 }, () => ({ stream: ["ok"] })),
			})
			const sessionId = await newSession(fixture, fixture.workDir)

			/** System prompt of one recorded chat request. */
			const systemPromptOf = (body: unknown): string => {
				const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
				return messages
					.filter((m) => m.role === "system")
					.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
					.join("\n")
			}

			/**
			 * System prompt of the most recent MAIN chat request. The session-name
			 * extension fires its own title-generation chat call after each turn —
			 * excluded by its distinctive system prompt.
			 */
			const lastSystemPrompt = (): string => {
				const chats = fixture.fake.requests
					.filter((r) => r.url.includes("chat/completions"))
					.filter((r) => !systemPromptOf(r.body).includes("Name the user's actual task"))
				expect(chats.length, "expected at least one recorded main chat request").toBeGreaterThan(0)
				return systemPromptOf(chats[chats.length - 1]?.body)
			}

			// Memory on (feature enabled, no session override): the constant
			// enabled-notice rides along on every start.
			expect(await prompt(fixture, sessionId, "first hello")).toMatchObject({ stopReason: "end_turn" })
			expect(lastSystemPrompt()).toContain(NOTICE_MARKER)

			// Off for this session only — takes effect from the next agent start.
			const off = await fixture.conn.extMethod(SET_MEMORY_ENABLED, { sessionId, enabled: false })
			expect(off).toEqual({ sessionId, enabled: false })
			expect(await prompt(fixture, sessionId, "second hello")).toMatchObject({ stopReason: "end_turn" })
			expect(lastSystemPrompt()).not.toContain(NOTICE_MARKER)

			// Back on: the flip reset the digest state, the notice returns.
			const on = await fixture.conn.extMethod(SET_MEMORY_ENABLED, { sessionId, enabled: true })
			expect(on).toEqual({ sessionId, enabled: true })
			expect(await prompt(fixture, sessionId, "third hello")).toMatchObject({ stopReason: "end_turn" })
			expect(lastSystemPrompt()).toContain(NOTICE_MARKER)
		},
		PROMPT_TIMEOUT_MS * 3,
	)

	it(
		"resource overrides round-trip and the memory store methods behave",
		async () => {
			fixture = await startAcpFixture({ artifactName: "memory-control-methods", responses: [] })
			const sessionId = await newSession(fixture, fixture.workDir)

			// list_resources: the env-enabled memory resource shows enabled.
			const listed = (await fixture.conn.extMethod(LIST_RESOURCES, {})) as {
				resources: Array<{ id: string; enabled: boolean; overridden: boolean; restartRequired: boolean }>
			}
			const memory = listed.resources.find((r) => r.id === "extensions.memory")
			expect(memory).toMatchObject({ enabled: true, overridden: false, restartRequired: true })

			// set_resource_enabled: persistent override reflected by list.
			const off = await fixture.conn.extMethod(SET_RESOURCE_ENABLED, {
				resourceId: "extensions.memory",
				enabled: false,
			})
			expect(off).toEqual({ id: "extensions.memory", enabled: false, restartRequired: true })
			const afterOff = (await fixture.conn.extMethod(LIST_RESOURCES, {})) as {
				resources: Array<{ id: string; enabled: boolean; overridden: boolean }>
			}
			expect(afterOff.resources.find((r) => r.id === "extensions.memory")).toMatchObject({
				enabled: false,
				overridden: true,
			})
			await fixture.conn.extMethod(SET_RESOURCE_ENABLED, { resourceId: "extensions.memory", enabled: true })

			// memory_status: both control layers, empty stores under the
			// isolated home.
			const status = (await fixture.conn.extMethod(MEMORY_STATUS, { sessionId })) as {
				featureEnabled: boolean
				sessionOverride: boolean | null
				sessionActive: boolean
				stores: unknown[]
			}
			expect(status).toMatchObject({ featureEnabled: true, sessionOverride: null, sessionActive: true })
			expect(status.stores).toEqual([])

			// memory_list over the empty stores.
			const list = (await fixture.conn.extMethod(MEMORY_LIST, {})) as {
				total: number
				facts: unknown[]
			}
			expect(list).toMatchObject({ total: 0, facts: [] })

			// memory_reset without the explicit confirm is rejected.
			await expect(fixture.conn.extMethod(MEMORY_RESET, { scope: "personal" })).rejects.toMatchObject({
				code: -32602,
			})

			// Session-scoped ops reject an unknown session.
			await expect(
				fixture.conn.extMethod(SET_MEMORY_ENABLED, { sessionId: "no-such-session", enabled: true }),
			).rejects.toMatchObject({ code: -32602 })
		},
		STARTUP_TIMEOUT_MS + 20_000,
	)
})
