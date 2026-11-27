// ACP integration: the Ferment executing verifier on the ACP surface.
//
// Dual-surface parity for the verifier slice: an explicit completion claim
// spawns the `Verifier` subagent (a separate session whose system prompt
// carries the objective and host-gathered facts), its executed bash check is
// stamped with an evidence ID the verdict cites, and the accepted verdict
// completes the Ferment — observable through the shared notify streams
// the IDE client receives.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, type ScenarioResult, waitFor } from "./support/scenarios.js"

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

it("sends a failing claim back with a finding, re-checks the fix, and completes", async () => {
	const outputFile = "acp-ferment.txt"
	const acceptedFinal = "ACP_FERMENT_VERIFIED_COMPLETE"
	const hasEvidence = (request: FakeLikeRequest) => collectStrings(request.body).some((v) => v.includes("[e1]"))
	const call = (id: string, name: string, args: unknown, index = 0) => ({
		id,
		index,
		function: { name, arguments: JSON.stringify(args) },
	})
	const verifierCheckScript = (id: string) => ({
		match: (request: FakeLikeRequest) => isFermentV2VerifierRequest(request) && !hasEvidence(request),
		stream: ["Running the verification check."],
		toolCalls: [call(id, "bash", { command: `cat ${outputFile}` })],
	})
	const active = await startAcpFixture({
		artifactName: "ferment-v2-verifier-round-trip",
		extraArgs: ["--yolo"],
		clientMeta: { "kimchi.dev": { ferment: true } },
		responses: [
			// Review 1: the check shows the wrong content; the verifier records the
			// finding and continues.
			verifierCheckScript("verifier-check-1"),
			{
				match: (request) => isFermentV2VerifierRequest(request) && hasEvidence(request),
				toolCalls: [
					call("finding-1", "report_finding", {
						clause: "containing exactly done",
						evidence: ["e1"],
						observed: "acp-ferment.txt contains don",
						expected: "acp-ferment.txt contains exactly done",
						why: "the content differs from the objective",
					}),
					call("submit-1", "submit_verdict", { verdict: "continue", summary: "" }, 1),
				],
			},
			// Review 2: the repaired file passes.
			verifierCheckScript("verifier-check-2"),
			{
				match: (request) => isFermentV2VerifierRequest(request) && hasEvidence(request),
				toolCalls: [
					call("resolve-f1", "resolve_finding", {
						id: "F1",
						resolution: "fixed",
						evidence: ["e1"],
						reproduction: `cat ${outputFile}`,
						reason: "the re-check shows the file contains exactly done",
					}),
					call("submit-2", "submit_verdict", { verdict: "met", summary: "The file contains exactly done." }, 1),
				],
			},
			// The implementer: the (buggy) work and a claim.
			{
				stream: ["Writing the file."],
				toolCalls: [
					call("create-ferment-todos", "create_todos", {
						todos: [{ content: `Create and verify ${outputFile}`, status: "in_progress" }],
					}),
					call("write-ferment-file", "write", { path: outputFile, content: "don" }, 1),
				],
			},
			{ toolCalls: [call("finish-ferment-todo", "mark_todo", { id: 1, status: "completed" })] },
			{ toolCalls: [call("claim-1", "update_ferment_v2", { status: "complete", completion_confidence: "tested" })] },
			// After the continue: repair the file and claim again.
			{
				stream: ["Repairing the file."],
				toolCalls: [call("repair-ferment-file", "write", { path: outputFile, content: "done" })],
			},
			{
				toolCalls: [
					call("respond-f1", "respond_to_ferment_v2_finding", {
						id: "F1",
						status: "fixed",
						evidence: `rewrote ${outputFile}; cat prints done`,
					}),
				],
			},
			{ toolCalls: [call("claim-2", "update_ferment_v2", { status: "complete", completion_confidence: "proven" })] },
			{ stream: [acceptedFinal] },
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)

	const names = await waitFor(
		() => commandNames(active, session),
		(found) => found.includes("bug"),
	)
	expect(names.filter((name) => name === "ferment")).toHaveLength(1)
	expect(names).not.toContain("ferment-v2")

	const running: ScenarioResult = await prompt(
		active,
		session,
		`/ferment create ${outputFile} containing exactly done and verify it`,
	)
	expect(running.stopReason).not.toBe("ERROR")

	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment complete.")))

	const verifierRequests = chatRequests(active).filter(isFermentV2VerifierRequest)
	expect(verifierRequests).toHaveLength(4)
	// The second review re-checks the open finding with the implementer's answer.
	const secondReview = collectStrings(verifierRequests[2]?.body).join("\n")
	expect(secondReview).toContain("Open findings from earlier reviews")
	expect(secondReview).toContain(`implementer response: fixed — rewrote ${outputFile}; cat prints done`)
	// The implementer saw the finding as an open finding in its context.
	const implementerRequests = chatRequests(active).filter((request) => !isFermentV2VerifierRequest(request))
	expect(
		implementerRequests.some((request) =>
			collectStrings(request.body).some((value) => value.includes('"observed": "acp-ferment.txt contains don"')),
		),
	).toBe(true)
	expect(readFileSync(join(active.workDir, outputFile), "utf-8")).toBe("done")
})
