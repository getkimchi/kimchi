import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readMemoryFact, seedMemoryHome } from "../tui/support/memory-e2e.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const MEMORY_GET = "_kimchi.dev/memory_get"
const MEMORY_UPDATE = "_kimchi.dev/memory_update"
const MEMORY_LIST = "_kimchi.dev/memory_list"

describe("ACP integration — precise memory inspection and editing", () => {
	let fixture: AcpFixture
	const realEnableEnv = process.env.KIMCHI_ENABLE_RESOURCES
	const realCaptureEnv = process.env.KIMCHI_MEMORY_CAPTURE

	beforeEach(() => {
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
		"memory_get and memory_update inspect and edit one exact fact",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "memory-control-edit",
				responses: [],
				enableMemoryEmbeddings: true,
			})
			await newSession(fixture, fixture.workDir)
			seedMemoryHome(fixture.homeDir, [{ id: "e2e-fred", text: "the user's dog is named Fred" }])

			const listed = (await fixture.conn.request(MEMORY_LIST, { scope: "personal" })) as {
				total: number
				facts: Array<{ id: string }>
			}
			expect(listed.total).toBe(1)
			expect(listed.facts[0]?.id).toBe("e2e-fred")

			const inspected = (await fixture.conn.request(MEMORY_GET, { id: "e2e-fred", scope: "personal" })) as {
				fact: { memory: string; scope: string; supportCount: number }
			}
			expect(inspected).toMatchObject({
				id: "e2e-fred",
				fact: { memory: "the user's dog is named Fred", scope: "personal", supportCount: 0 },
			})

			const updated = (await fixture.conn.request(MEMORY_UPDATE, {
				id: "e2e-fred",
				scope: "personal",
				kind: "procedural",
				confidence: 0,
				note: "reviewed",
				canonical: false,
				confirm: true,
			})) as { corrected: { memory: string; scope: string; metadata: Record<string, unknown> }; deleted: unknown[] }
			expect(updated.corrected).toMatchObject({
				memory: "the user's dog is named Fred",
				scope: "personal",
				metadata: {
					kind: "procedural",
					source: "authored",
					canonical: false,
					confidence: 0,
					attributes: { note: "reviewed" },
				},
			})
			expect(updated.deleted).toEqual([])

			expect(readMemoryFact(fixture.homeDir, "e2e-fred").payload).toMatchObject({
				source: "authored",
				canonical: false,
				confidence: 0,
				attributes: { note: "reviewed" },
			})
			expect(await fixture.conn.request(MEMORY_GET, { id: "e2e-fred", scope: "personal" })).toMatchObject({
				id: "e2e-fred",
				fact: { memory: "the user's dog is named Fred", scope: "personal" },
			})
			expect(
				fixture.fake.requests.some((request) => request.method === "POST" && request.url.endsWith("/embeddings")),
			).toBe(true)

			expect(await fixture.conn.request(MEMORY_GET, { id: "missing", scope: "personal" })).toEqual({
				id: "missing",
				fact: null,
			})
			await expect(
				fixture.conn.request(MEMORY_UPDATE, { id: "e2e-fred", scope: "personal", text: "Use pnpm" }),
			).rejects.toMatchObject({
				code: -32602,
			})
		},
		STARTUP_TIMEOUT_MS + 10_000,
	)
})
