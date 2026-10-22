// ACP integration: the Ferment V2 executing verifier on the ACP surface.
//
// Dual-surface parity for the verifier slice: an explicit completion claim
// spawns the `Verifier` subagent (a separate session whose system prompt
// carries the objective and host-gathered facts), its executed bash check is
// stamped with an evidence ID the verdict cites, and the accepted verdict
// completes the Ferment V2 — observable through the shared notify streams
// the IDE client receives.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
	ORIGINAL_TEST_OBJECTIVE,
	originalTestRepairResponses,
	seedOriginalTestRepository,
} from "../tui/support/ferment-v2-original-test.js"
import { verifierRequirements } from "../tui/support/ferment-v2-verifier.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, type ScenarioResult, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined

afterEach(async () => {
	await fixture?.stop()
})

interface FakeLikeRequest {
	url: string
	body: unknown
}

function chatRequests(fixture: AcpFixture): FakeLikeRequest[] {
	return fixture.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
}

function isFermentV2VerifierRequest(request: FakeLikeRequest): boolean {
	return collectStrings(request.body).some((value) => value.includes("<ferment_v2_verifier>"))
}

it.each([
	false,
	true,
])("verifies every recorded requirement before completing (initial omission: %s)", async (omitRequirement) => {
	const outputFile = "acp-ferment.txt"
	const acceptedFinal = "ACP_FERMENT_VERIFIED_COMPLETE"
	const metVerdict = JSON.stringify({
		verdict: "met",
		reason: "The file exists with the exact required content.",
		checks: [
			{
				requirementId: "r1",
				kind: "work",
				method: "command",
				requirement: "Create and verify acp-ferment.txt containing exactly done",
				status: "pass",
				failureMode: "the file could contain different data; the read confirms the exact content",
				evidence: ["e1"],
			},
			...(omitRequirement
				? [
						{
							requirementId: "r2",
							kind: "work",
							category: "constraint",
							method: "inspection",
							requirement: "Use the requested output path",
							status: "pass",
							failureMode: "The content might be written to a different path",
							evidence: ["e1"],
						},
					]
				: []),
		],
	})
	const active = await startAcpFixture({
		artifactName: `ferment-v2-verifier-${omitRequirement ? "omission" : "pass"}`,
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			...(omitRequirement
				? [
						{
							match: isFermentV2VerifierRequest,
							toolCalls: [
								{
									id: "record-acp-requirements",
									function: {
										name: "record_requirements",
										arguments: JSON.stringify({
											requirements: [
												{
													id: "r1",
													requirement: "Create and verify acp-ferment.txt containing exactly done",
													source: "Objective: containing exactly done",
													acceptance: "File contains exactly done",
													category: "behavior",
												},
												{
													id: "r2",
													requirement: "Use the requested output path",
													source: "Objective: create acp-ferment.txt",
													acceptance: "File exists at acp-ferment.txt",
													category: "constraint",
												},
											],
										}),
									},
								},
							],
						},
					]
				: [verifierRequirements("Create and verify acp-ferment.txt containing exactly done")]),
			// The verifier session: one executing bash check (stamped [e1]), then a met verdict citing it.
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && !collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: ["Running the verification check."],
				toolCalls: [
					{
						id: "verifier-bash-check",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${outputFile})" = done` }) },
					},
				],
			},
			...(omitRequirement
				? [
						{
							match: isFermentV2VerifierRequest,
							stream: [
								JSON.stringify({ ...JSON.parse(metVerdict), checks: JSON.parse(metVerdict).checks.slice(0, 1) }),
							],
						},
					]
				: []),
			{
				match: (request) =>
					isFermentV2VerifierRequest(request) && collectStrings(request.body).some((v) => v.includes("[e1]")),
				stream: [metVerdict],
			},
			// The implementer: write the file, verify it, claim completion, deliver the final answer.
			{
				stream: ["Creating the requested file."],
				toolCalls: [
					{
						id: "create-ferment-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({
								todos: [{ content: "Create and verify acp-ferment.txt", status: "in_progress" }],
							}),
						},
					},
					{
						id: "write-ferment-file",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: outputFile, content: "done" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified."],
				toolCalls: [
					{
						id: "read-ferment-file",
						index: 0,
						function: { name: "read", arguments: JSON.stringify({ path: outputFile }) },
					},
					{
						id: "finish-ferment-todo",
						index: 1,
						function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified. Claiming completion."],
				toolCalls: [
					{
						id: "claim-ferment-complete",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},
			{ stream: [acceptedFinal] },
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)

	const running: ScenarioResult = await prompt(
		active,
		session,
		`/ferment-v2 create ${outputFile} containing exactly done and verify it`,
	)
	expect(running.stopReason).not.toBe("ERROR")

	// The completion claim spawned the verifier, which executed one bash check…
	const verifierRequests = await waitFor(
		() => chatRequests(active).filter(isFermentV2VerifierRequest),
		(requests) => requests.length >= 3,
	)
	// …and its tool result came back stamped with the evidence ID the verdict cites,
	// with the implementer's write intact.
	expect(collectStrings(verifierRequests[2]?.body).some((value) => value.includes("[e1]"))).toBe(true)
	expect(collectStrings(verifierRequests[0]?.body).join("\n")).not.toContain("Implementer's current Todos")
	expect(collectStrings(verifierRequests[1]?.body).join("\n")).toContain("Requirements recorded (revision 1)")
	expect(collectStrings(verifierRequests[1]?.body).join("\n")).toContain("Implementer's current Todos")
	if (omitRequirement) {
		const corrected = await waitFor(
			() => chatRequests(active).filter(isFermentV2VerifierRequest),
			(requests) => requests.length >= 4,
		)
		expect(collectStrings(corrected[3]?.body).join("\n")).toContain("Recorded requirement r2")
	}
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
	// The accepted verdict delivered the final answer and completed the Ferment V2.
	// (Ferment-driven turns are queued by the extension, not an ACP `session/prompt`,
	// so their text is not re-emitted as agent_message_chunk — the verdict and
	// completion are the user-visible ACP surface here.)
	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) =>
		records.some((record) => record.includes("Ferment V2 verifier accepted the completion")),
	)
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
	await waitFor(
		() => active.client.extNotifications,
		(notifications) => notifications.some((n) => JSON.stringify(n.params).includes("◈ Ferment V2: complete ·")),
	)
	// The verifier's read-only bash check left the workspace otherwise untouched
	// after the accepted final-answer turn completed the Ferment V2.
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
})

it("repairs a failure exposed by original assertions despite weakened candidate tests", async () => {
	const active = await startAcpFixture({
		artifactName: "ferment-v2-original-test",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: originalTestRepairResponses(),
	})
	fixture = active
	seedOriginalTestRepository(active.workDir)
	const session = await newSession(active, active.workDir)
	await prompt(active, session, `/ferment-v2 ${ORIGINAL_TEST_OBJECTIVE}`)
	await waitFor(
		() => active.client.extNotifications,
		(rows) => rows.some((row) => JSON.stringify(row.params).includes("Ferment V2 complete.")),
	)
	expect(readFileSync(join(active.workDir, "value.cjs"), "utf8")).toBe("module.exports = 1")
	expect(readFileSync(join(active.workDir, "value.test.cjs"), "utf8")).toContain("ok(true)")
	const requests = chatRequests(active).filter(isFermentV2VerifierRequest)
	const trace = requests.flatMap((row) => collectStrings(row.body)).join("\n")
	expect(trace).toContain("AssertionError")
	expect(trace).toContain("Original-test receipt")
	expect(trace).toContain('"exitCode":1')
	expect(trace).toContain('"exitCode":0')
})
