// ACP integration — native subagent session announcements and child traffic.
// These are intentionally end-to-end assertions against the unstable SDK app's
// recorded wire updates: clients either opt into subagents and can follow the
// complete parent/child workflow, or see the pre-subagent parent-only surface.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientCapabilities, ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import type { FakeResponseRequest } from "../tui/support/fake-openai-server.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const ALPHA_TASK = "Read alpha.txt and report its exact marker after investigating the fixture."
const ALPHA_TITLE = "Investigate alpha fixture"
const ALPHA_FILE_CONTENT = "alpha-file-content-for-subagent-e2e"
const ALPHA_RESULT = "ALPHA-SUBAGENT-RESULT"
const BETA_TASK = "Independently inspect the beta angle and return the beta marker without editing files."
const BETA_TITLE = "Investigate beta fixture"
const BETA_RESULT = "BETA-SUBAGENT-RESULT"
const PARENT_REQUEST = "Delegate both independent investigations to two agents."

const ALPHA_ARGS = {
	prompt: ALPHA_TASK,
	description: ALPHA_TITLE,
	subagent_type: "general-purpose",
}
const BETA_ARGS = {
	prompt: BETA_TASK,
	description: BETA_TITLE,
	subagent_type: "general-purpose",
}

type RecordedSessionUpdate = AcpFixture["client"]["sessionUpdates"][number]
type ToolCallEntry = RecordedSessionUpdate & {
	update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>
}
type ToolCallUpdateEntry = RecordedSessionUpdate & {
	update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>
}

interface ChildRequestObservation {
	announcedSessionIds: Set<string>
	directedRecipientIds: Set<string>
}

function requestBody(request: FakeResponseRequest): string {
	return JSON.stringify(request.body ?? {})
}

function captureChildRequest(
	observations: Map<string, ChildRequestObservation>,
	task: string,
	getFixture: () => AcpFixture | undefined,
) {
	return (request: FakeResponseRequest): boolean => {
		const body = requestBody(request)
		if (!body.includes(task) || body.includes(ALPHA_FILE_CONTENT)) return false
		const fixture = getFixture()
		if (!fixture) return false
		const announcedSessionIds = new Set<string>()
		const directedRecipientIds = new Set<string>()
		for (const { update } of fixture.client.sessionUpdates) {
			if (update.sessionUpdate === "subagent_update") announcedSessionIds.add(update.sessionId)
			if (update.sessionUpdate === "session_message" && update.recipientSessionId) {
				directedRecipientIds.add(update.recipientSessionId)
			}
		}
		observations.set(task, { announcedSessionIds, directedRecipientIds })
		return true
	}
}

function textFromContent(content: ContentBlock[] | null | undefined): string {
	return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
}

function findDirectedTask(
	fixture: AcpFixture,
	parentId: string,
	task: string,
): { entry: RecordedSessionUpdate; childId: string } {
	const records = fixture.client.sessionUpdates
	for (const entry of records) {
		if (entry.update.sessionUpdate !== "session_message") continue
		const messageId = entry.update.messageId
		const chunkText = records.flatMap(({ update }) =>
			update.sessionUpdate === "session_message_chunk" && update.messageId === messageId
				? [textFromContent([update.content])]
				: [],
		)
		const text = textFromContent(entry.update.content) + chunkText.join("")
		if (text !== task) continue
		const childId = entry.update.recipientSessionId
		expect(entry.update.senderSessionId, "initial task sender is the parent session").toBe(parentId)
		expect(childId, "initial task is directed to a child session").toBeTruthy()
		if (!childId) throw new Error(`Directed task has no recipient: ${task}`)
		return { entry, childId }
	}
	throw new Error(`No directed session message carried the full task: ${task}`)
}

function findAgentCall(fixture: AcpFixture, parentId: string, title: string): ToolCallEntry {
	const call = fixture.client.sessionUpdates.find(
		(entry): entry is ToolCallEntry =>
			entry.sessionId === parentId && entry.update.sessionUpdate === "tool_call" && entry.update.title === title,
	)
	if (!call) throw new Error(`No parent Agent tool call titled ${title}`)
	return call
}

function findTerminalAgentUpdate(fixture: AcpFixture, parentId: string, toolCallId: string): ToolCallUpdateEntry {
	const update = fixture.client.sessionUpdates.find(
		(entry): entry is ToolCallUpdateEntry =>
			entry.sessionId === parentId &&
			entry.update.sessionUpdate === "tool_call_update" &&
			entry.update.toolCallId === toolCallId &&
			entry.update.status === "completed",
	)
	if (!update) throw new Error(`No completed update for parent Agent call ${toolCallId}`)
	return update
}

function hasSessionLink(entry: ToolCallEntry | ToolCallUpdateEntry, childId: string): boolean {
	return (entry.update.content ?? []).some((item) => item.type === "session" && item.sessionId === childId)
}

function hasResultText(entry: ToolCallEntry | ToolCallUpdateEntry, marker: string): boolean {
	return (entry.update.content ?? []).some(
		(item) => item.type === "content" && item.content.type === "text" && item.content.text.includes(marker),
	)
}

function expectChildLifecycle(fixture: AcpFixture, parentId: string, childId: string): RecordedSessionUpdate {
	const records = fixture.client.sessionUpdates
	const announcement = records.find(
		(entry) =>
			entry.sessionId === parentId &&
			entry.update.sessionUpdate === "subagent_update" &&
			entry.update.sessionId === childId,
	)
	if (announcement?.update.sessionUpdate !== "subagent_update") {
		throw new Error(`No parent announcement for child ${childId}`)
	}
	expect(announcement.update).toMatchObject({
		sessionUpdate: "subagent_update",
		sessionId: childId,
		cwd: fixture.workDir,
		additionalDirectories: [],
	})

	const announcementIndex = records.indexOf(announcement)
	const directedTaskIndex = records.findIndex(
		(entry) => entry.update.sessionUpdate === "session_message" && entry.update.recipientSessionId === childId,
	)
	const childTrafficIndex = records.findIndex((entry) => entry.sessionId === childId)
	expect(directedTaskIndex, "announcement precedes the directed task").toBeGreaterThan(announcementIndex)
	expect(childTrafficIndex, "announcement precedes live child traffic").toBeGreaterThan(announcementIndex)

	const states = records.flatMap(({ sessionId, update }) =>
		sessionId === parentId && update.sessionUpdate === "subagent_update" && update.sessionId === childId && update.state
			? [update.state]
			: [],
	)
	expect(
		states.map((state) => state.state),
		"child reports running and idle on the same session ID",
	).toEqual(expect.arrayContaining(["running", "idle"]))
	expect(states.at(-1), "child finishes idle rather than disappearing").toMatchObject({
		state: "idle",
		stopReason: "end_turn",
	})
	return announcement
}

function expectNoSubagentSurface(fixture: AcpFixture, parentId: string): void {
	for (const { sessionId, update } of fixture.client.sessionUpdates) {
		expect(sessionId, "unsupported clients receive only parent-session traffic").toBe(parentId)
		expect(
			["subagent_update", "session_message", "session_message_chunk"],
			`legacy update ${update.sessionUpdate}`,
		).not.toContain(update.sessionUpdate)
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			expect(update.content?.some((item) => item.type === "session") ?? false, "no child session links").toBe(false)
		}
	}
}

describe("ACP integration — native subagent sessions", () => {
	const temporaryDirectories: string[] = []

	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})

	it(
		"announces two interleaved children before their requests and preserves each Agent card through completion",
		async () => {
			let fixture: AcpFixture | undefined
			const requestObservations = new Map<string, ChildRequestObservation>()
			const processCwd = mkdtempSync(join(tmpdir(), "kimchi-acp-subagent-process-"))
			const sessionWorkDir = mkdtempSync(join(tmpdir(), "kimchi-acp-subagent-work-"))
			temporaryDirectories.push(processCwd, sessionWorkDir)
			const alphaPath = join(sessionWorkDir, "alpha.txt")
			try {
				fixture = await startAcpFixture({
					artifactName: "subagent-protocol-supported",
					clientCapabilities: { subagents: {} },
					// A child inherits the ACP session root, not the long-lived process cwd.
					processCwd,
					workDirOverride: sessionWorkDir,
					seedHome: () => {
						writeFileSync(alphaPath, ALPHA_FILE_CONTENT, "utf-8")
					},
					responses: [
						{
							match: (request) => requestBody(request).includes(PARENT_REQUEST),
							toolCalls: [
								{
									id: "call_parent_alpha",
									function: { name: "Agent", arguments: JSON.stringify(ALPHA_ARGS) },
								},
								{
									id: "call_parent_beta",
									index: 1,
									function: { name: "Agent", arguments: JSON.stringify(BETA_ARGS) },
								},
							],
						},
						{
							match: (request) => {
								const body = requestBody(request)
								return body.includes(ALPHA_RESULT) && body.includes(BETA_RESULT)
							},
							stream: ["Both child investigations are complete."],
						},
						{
							forSubagent: true,
							match: (request) => requestBody(request).includes(ALPHA_FILE_CONTENT),
							stream: [ALPHA_RESULT],
						},
						{
							forSubagent: true,
							match: captureChildRequest(requestObservations, ALPHA_TASK, () => fixture),
							stream: ["Reading the alpha fixture."],
							textDelayMs: 40,
							toolCalls: [
								{
									id: "call_child_read_alpha",
									function: {
										name: "read",
										arguments: JSON.stringify({ path: alphaPath }),
									},
								},
							],
						},
						{
							forSubagent: true,
							match: captureChildRequest(requestObservations, BETA_TASK, () => fixture),
							stream: ["BETA-", "SUBAGENT-RESULT"],
							textDelayMs: 80,
						},
					],
				})
				const activeFixture = fixture
				const sessionId = await newSession(activeFixture, activeFixture.workDir)
				// Initializing another root must not replace the first root's
				// parent-scoped child session resolution.
				const secondSessionId = await newSession(activeFixture, activeFixture.workDir)
				expect(secondSessionId).not.toBe(sessionId)
				const result = await prompt(activeFixture, sessionId, PARENT_REQUEST)
				expect(result.stopReason).toBe("end_turn")

				const alphaTask = findDirectedTask(activeFixture, sessionId, ALPHA_TASK)
				const betaTask = findDirectedTask(activeFixture, sessionId, BETA_TASK)
				const alphaId = alphaTask.childId
				const betaId = betaTask.childId
				expect(new Set([sessionId, alphaId, betaId]).size, "stable, distinct parent and child IDs").toBe(3)
				for (const task of [ALPHA_TASK, BETA_TASK]) {
					const childId = task === ALPHA_TASK ? alphaId : betaId
					const observation = requestObservations.get(task)
					expect(observation?.announcedSessionIds.has(childId), `${task}: announced before its LLM request`).toBe(true)
					expect(observation?.directedRecipientIds.has(childId), `${task}: full task sent before its LLM request`).toBe(
						true,
					)
				}
				expectChildLifecycle(activeFixture, sessionId, alphaId)
				expectChildLifecycle(activeFixture, sessionId, betaId)

				const alphaCall = findAgentCall(activeFixture, sessionId, ALPHA_TITLE)
				const betaCall = findAgentCall(activeFixture, sessionId, BETA_TITLE)
				expect(alphaCall.update).toMatchObject({
					name: "subagent",
					kind: "other",
					title: ALPHA_TITLE,
					rawInput: ALPHA_ARGS,
				})
				expect(betaCall.update).toMatchObject({
					name: "subagent",
					kind: "other",
					title: BETA_TITLE,
					rawInput: BETA_ARGS,
				})
				expect(alphaCall.update.toolCallId).not.toBe(betaCall.update.toolCallId)
				const alphaTerminal = findTerminalAgentUpdate(activeFixture, sessionId, alphaCall.update.toolCallId)
				const betaTerminal = findTerminalAgentUpdate(activeFixture, sessionId, betaCall.update.toolCallId)
				expect(hasResultText(alphaTerminal, ALPHA_RESULT), "alpha terminal content contains its result").toBe(true)
				expect(hasSessionLink(alphaTerminal, alphaId), "alpha result replacement retains its session link").toBe(true)
				expect(hasResultText(betaTerminal, BETA_RESULT), "beta terminal content contains its result").toBe(true)
				expect(hasSessionLink(betaTerminal, betaId), "beta result replacement retains its session link").toBe(true)

				const childText = activeFixture.client.agentTextBySession()
				expect(childText.get(alphaId)).toContain("Reading the alpha fixture.")
				expect(childText.get(alphaId)).toContain(ALPHA_RESULT)
				expect(childText.get(betaId)).toContain(BETA_RESULT)
				expect(result.chunks).toContain("Both child investigations are complete.")
				expect(result.chunks).not.toContain(ALPHA_RESULT)

				const alphaRead = activeFixture.client.sessionUpdates.find(
					(entry): entry is ToolCallEntry =>
						entry.sessionId === alphaId && entry.update.sessionUpdate === "tool_call" && entry.update.kind === "read",
				)
				expect(alphaRead?.update.rawInput, "alpha's own read tool is visible on its child session").toEqual({
					path: alphaPath,
				})
				if (alphaRead) {
					const readCompleted = activeFixture.client.sessionUpdates.some(
						(entry) =>
							entry.sessionId === alphaId &&
							entry.update.sessionUpdate === "tool_call_update" &&
							entry.update.toolCallId === alphaRead.update.toolCallId &&
							entry.update.status === "completed",
					)
					expect(readCompleted, "child tool ID remains stable through completion").toBe(true)
				}
			} finally {
				await fixture?.stop()
			}
		},
		STARTUP_TIMEOUT_MS,
	)

	it.each([
		{ label: "omitted", clientCapabilities: undefined },
		{ label: "null", clientCapabilities: { subagents: null } },
	] satisfies Array<{ label: string; clientCapabilities: ClientCapabilities | undefined }>)(
		"keeps the parent-only wire contract when subagent capability is $label",
		async ({ label, clientCapabilities }) => {
			const task = "Investigate without exposing subagent protocol to this legacy client."
			const title = "Legacy delegated investigation"
			const marker = `LEGACY-${label.toUpperCase()}-RESULT`
			const args = { prompt: task, description: title, subagent_type: "general-purpose" }
			let fixture: AcpFixture | undefined
			try {
				fixture = await startAcpFixture({
					artifactName: `subagent-protocol-${label}`,
					clientCapabilities,
					responses: [
						{
							match: (request) => requestBody(request).includes(PARENT_REQUEST),
							toolCalls: [{ function: { name: "Agent", arguments: JSON.stringify(args) } }],
						},
						{
							match: (request) => requestBody(request).includes(marker),
							stream: ["Legacy parent received the result."],
						},
						{
							forSubagent: true,
							match: (request) => requestBody(request).includes(task),
							stream: [marker],
						},
					],
				})
				const activeFixture = fixture
				const sessionId = await newSession(activeFixture, activeFixture.workDir)
				const result = await prompt(activeFixture, sessionId, PARENT_REQUEST)
				expect(result.stopReason).toBe("end_turn")
				expect(result.chunks).toContain("Legacy parent received the result.")
				expect(result.chunks).not.toContain(marker)
				expect(
					activeFixture.fake.requests.some((request) => requestBody(request).includes(task)),
					"the real foreground Agent still ran",
				).toBe(true)
				expectNoSubagentSurface(activeFixture, sessionId)
			} finally {
				await fixture?.stop()
			}
		},
		STARTUP_TIMEOUT_MS,
	)
})
