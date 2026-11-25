import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const CONTEXT_REDUCTION_TOOL_EXTENSION = fileURLToPath(
	new URL("./support/test-context-reduction-details-tool-extension.js", import.meta.url),
)

const SCRIPT = [
	"// @description: Filter the fixture down to its alpha lines",
	'const source = await tools.read({ path: "fixture.txt" });',
	'return source.split("\\n").filter(line => line.includes("alpha")).join("\\n");',
].join("\n")

type ToolCall = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>
type ToolCallUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>

interface Projection {
	call: ToolCall
	final: ToolCallUpdate
}

/** The tool call matching `isTarget` and its last update, from `startIndex` on. */
function projection(fixture: AcpFixture, isTarget: (call: ToolCall) => boolean, startIndex = 0): Projection {
	const updates = fixture.client.sessionUpdates.slice(startIndex).map(({ update }) => update)
	const call = updates.find((update): update is ToolCall => update.sessionUpdate === "tool_call" && isTarget(update))
	if (!call) throw new Error(`missing tool call: ${JSON.stringify(updates)}`)
	const final = updates
		.filter(
			(update): update is ToolCallUpdate =>
				update.sessionUpdate === "tool_call_update" && update.toolCallId === call.toolCallId && !!update.rawOutput,
		)
		.at(-1)
	if (!final) throw new Error(`missing final update for ${call.toolCallId}: ${JSON.stringify(updates)}`)
	return { call, final }
}

function isCodemodeScript(call: ToolCall): boolean {
	const rawInput = call.rawInput as { code?: unknown } | undefined
	return rawInput?.code === SCRIPT
}

function isUnrelatedTool(call: ToolCall): boolean {
	return JSON.stringify(call).includes("test_context_reduction_details")
}

function details(update: ToolCallUpdate): Record<string, unknown> | undefined {
	return (update.rawOutput as { details?: Record<string, unknown> } | undefined)?.details
}

describe("ACP integration — codemode rawOutput", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "codemode-raw-output",
			extensionPath: CONTEXT_REDUCTION_TOOL_EXTENSION,
			seedHome: (_home, workDir) => {
				writeFileSync(join(workDir, "fixture.txt"), "alpha 1\nbeta 2\nalpha 3\n")
			},
			responses: [
				{ toolCalls: [{ function: { name: "codemode", arguments: JSON.stringify({ code: SCRIPT }) } }] },
				{ stream: ["Codemode done."] },
				{ toolCalls: [{ function: { name: "test_context_reduction_details", arguments: "{}" } }] },
				{ stream: ["Unrelated tool done."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"keeps codemode's wire shape and unrelated tools' details, live and on replay",
		async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Run the codemode script")).stopReason).toBe("end_turn")
			expect((await prompt(fixture, sessionId, "Run the unrelated tool")).stopReason).toBe("end_turn")
			const liveCodemode = projection(fixture, isCodemodeScript)
			const liveUnrelated = projection(fixture, isUnrelatedTool)

			const replayStart = fixture.client.sessionUpdates.length
			await fixture.conn.request("session/load", { sessionId, cwd: fixture.workDir, mcpServers: [] })
			const replayCodemode = projection(fixture, isCodemodeScript, replayStart)
			const replayUnrelated = projection(fixture, isUnrelatedTool, replayStart)

			for (const { call, final } of [liveCodemode, replayCodemode]) {
				// rawInput is the exact submitted script; the title stays the legacy
				// one, because the purpose is TUI-only presentation.
				expect((call.rawInput as { code?: unknown }).code).toBe(SCRIPT)
				expect(call.title).not.toContain("Filter the fixture down to its alpha lines")
				// The TUI-only estimate never reaches the wire; Pi's own details stay.
				expect(details(final)).not.toHaveProperty("contextReduction")
				expect(details(final)?.calls).toEqual([
					expect.objectContaining({ name: "read", args: expect.stringContaining("fixture.txt"), status: "ok" }),
				])
			}
			expect(replayCodemode.call.title).toBe(liveCodemode.call.title)

			const expectedUnrelated = { contextReduction: { custom: "tool-owned value" }, requestId: "abc" }
			expect({ live: details(liveUnrelated.final), replay: details(replayUnrelated.final) }).toEqual({
				live: expectedUnrelated,
				replay: expectedUnrelated,
			})
		},
		PROMPT_TIMEOUT_MS * 3,
	)
})
