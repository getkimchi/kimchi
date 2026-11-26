// ACP integration — child interaction routing and cancellation. Announced
// routing is enabled by the server's child registration integration; the
// legacy-client case exercises the production root fallback without that
// integration and guards real parent cancellation and command suppression.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitFor } from "./support/scenarios.js"

const TASK = "Run the guarded child command and report."
const PARENT_REQUEST = "Delegate the guarded command to a child."

function scripts(command: string) {
	return [
		{
			match: (request: { body?: unknown }) => JSON.stringify(request.body ?? {}).includes(PARENT_REQUEST),
			toolCalls: [
				{
					id: "parent-spawn",
					function: {
						name: "Agent",
						arguments: JSON.stringify({ prompt: TASK, description: "Guarded child", subagent_type: "general-purpose" }),
					},
				},
			],
		},
		{
			forSubagent: true,
			match: (request: { body?: unknown }) => JSON.stringify(request.body ?? {}).includes(TASK),
			toolCalls: [{ id: "child-bash", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
		},
	]
}

describe("ACP integration — subagent interaction requests", () => {
	let fixture: AcpFixture | undefined
	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it(
		"keeps an unexposed child's permission on its parent, answers cancellation once, and never executes",
		async () => {
			const marker = join((await import("node:os")).tmpdir(), `kimchi-child-cancel-${Date.now()}`)
			fixture = await startAcpFixture({
				artifactName: "subagent-request-parent-cancel",
				responses: scripts(`echo guarded && touch ${marker}`),
			})
			const active = fixture
			const sessionId = await newSession(active, active.workDir)
			let respondCancelled!: () => void
			const cancelledResponse = new Promise<void>((resolve) => (respondCancelled = resolve))
			active.client.requestPermission = async (request) => {
				active.client.permissionRequests.push(request)
				await cancelledResponse
				return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResponse
			}
			const prompt = active.conn.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: PARENT_REQUEST }],
			})
			await waitFor(
				() => active.client.permissionRequests,
				(requests) => requests.length === 1,
				45_000,
			)
			const request = active.client.permissionRequests[0]
			expect(request.sessionId).toBe(sessionId)
			expect(request.toolCall.toolCallId).toMatch(/^kt\.bash\.\d+$/)
			expect(request.toolCall._meta).toMatchObject({ piToolCallId: "child-bash" })

			await active.conn.notify("session/cancel", { sessionId })
			respondCancelled()
			expect((await prompt).stopReason).toBe("cancelled")
			expect(active.client.permissionRequests).toHaveLength(1)
			expect(existsSync(marker)).toBe(false)
			await delay(200)
			expect(active.client.permissionRequests).toHaveLength(1)
			expect(existsSync(marker)).toBe(false)
			const permissionStatus = active.client.extNotifications.filter(
				(notification) =>
					notification.method === "_kimchi.dev/pi_notify" &&
					JSON.stringify(notification.params).includes("permissions-mode"),
			)
			expect(permissionStatus, "only the root emits status; an unexposed worker stays headless").toHaveLength(1)
		},
		STARTUP_TIMEOUT_MS * 2,
	)

	it(
		"routes an announced child's permission and requires_action state through its own ACP session",
		async () => {
			const marker = join((await import("node:os")).tmpdir(), `kimchi-child-route-${Date.now()}`)
			fixture = await startAcpFixture({
				artifactName: "subagent-request-announced",
				clientCapabilities: { subagents: {} },
				responses: scripts(`echo guarded && touch ${marker}`),
			})
			const active = fixture
			const sessionId = await newSession(active, active.workDir)
			const prompt = active.conn.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: PARENT_REQUEST }],
			})
			await waitFor(
				() => active.client.permissionRequests,
				(requests) => requests.length === 1,
				45_000,
			)
			const request = active.client.permissionRequests[0]
			expect(request.sessionId).not.toBe(sessionId)
			expect(request.toolCall.toolCallId).toMatch(/^kt\.bash\.\d+$/)
			const waiting = active.client.sessionUpdates.find(
				({ sessionId: parent, update }) =>
					parent === sessionId &&
					update.sessionUpdate === "subagent_update" &&
					update.sessionId === request.sessionId &&
					update.state?.state === "requires_action",
			)
			expect(waiting).toBeDefined()
			expect((await prompt).stopReason).toBe("end_turn")
			expect(existsSync(marker), "execution, not approval alone, produces the command result").toBe(true)
		},
		STARTUP_TIMEOUT_MS * 2,
	)

	it(
		"cancels an announced child to actual idle/cancelled after the native work stops",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-child-cancel",
				clientCapabilities: { subagents: {} },
				responses: [
					{
						match: (request) => JSON.stringify(request.body ?? {}).includes(PARENT_REQUEST),
						toolCalls: [
							{
								id: "parent-spawn-cancel",
								function: {
									name: "Agent",
									arguments: JSON.stringify({
										prompt: TASK,
										description: "Long child",
										subagent_type: "general-purpose",
									}),
								},
							},
						],
					},
					{
						forSubagent: true,
						thinking: ["The child is still working."],
						stream: ["The child must not finish normally."],
						stallAfterThinking: true,
					},
					{ stream: ["Parent observed the stopped child."] },
				],
			})
			const active = fixture
			const parentId = await newSession(active, active.workDir)
			const prompting = active.conn.request("session/prompt", {
				sessionId: parentId,
				prompt: [{ type: "text", text: PARENT_REQUEST }],
			})
			const announcement = await waitFor(
				() => active.client.sessionUpdates,
				(updates) =>
					updates.some(
						({ update }) => update.sessionUpdate === "subagent_update" && update.capabilities?.cancel != null,
					),
				45_000,
			)
			const child = announcement.find(
				({ update }) => update.sessionUpdate === "subagent_update" && update.capabilities?.cancel != null,
			)?.update
			if (child?.sessionUpdate !== "subagent_update") throw new Error("Missing abortable child announcement")
			await active.conn.notify("session/cancel", { sessionId: child.sessionId })
			await waitFor(
				() => active.client.sessionUpdates,
				(updates) =>
					updates.some(
						({ update }) =>
							update.sessionUpdate === "subagent_update" &&
							update.sessionId === child.sessionId &&
							update.state?.state === "idle" &&
							update.state.stopReason === "cancelled",
					),
				45_000,
			)
			expect((await prompting).stopReason).toBe("end_turn")
			expect(JSON.stringify(active.client.sessionUpdates)).not.toContain('"status":"cancelled"')
		},
		STARTUP_TIMEOUT_MS * 2,
	)
})
