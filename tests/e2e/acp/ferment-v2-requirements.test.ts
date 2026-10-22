// ACP integration: the Ferment V2 requirements lifecycle on the IDE surface.
//
// Dual-surface parity for the pre-implementation requirements slice: the
// source-only drafter records the contract before the first implementation
// request, the seeded verifier acknowledges and verifies that same persisted
// contract, and the accepted verdict completes the Ferment V2.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { VerifierRequirement } from "../../../src/extensions/ferment-v2/requirements.js"
import type { FakeResponseRequest } from "../tui/support/fake-openai-server.js"
import {
	draftPrecedesImplementation,
	draftRequirements,
	isImplementerRequest,
	isRequirementsDraftRequest,
	isVerifierRequest,
	verifierRequirements,
} from "../tui/support/ferment-v2-verifier.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined

afterEach(async () => {
	await fixture?.stop()
})

function chatRequests(active: AcpFixture): FakeResponseRequest[] {
	return active.fake.requests.filter((row) => row.url.startsWith("/openai/v1/chat/completions"))
}

const OBJECTIVE = "Create acp-req.txt containing exactly done and verify it"
const OUTPUT_FILE = "acp-req.txt"
const ACCEPTED_FINAL = "ACP_REQUIREMENTS_VERIFIED"
const DRAFT_ITEMS: VerifierRequirement[] = [
	{
		id: "r1",
		requirement: "Create and verify acp-req.txt containing exactly done",
		source: "Objective: containing exactly done",
		acceptance: "File contains exactly done",
		category: "behavior",
	},
]

it("drafts requirements before implementation and verifies the persisted contract", async () => {
	const metVerdict = JSON.stringify({
		verdict: "met",
		reason: "The file exists with the exact required content.",
		checks: [
			{
				requirementId: "r1",
				kind: "work",
				method: "command",
				requirement: DRAFT_ITEMS[0]?.requirement,
				status: "pass",
				failureMode: "the file could contain different data; the read confirms the exact content",
				evidence: ["e1"],
			},
		],
	})
	const active = await startAcpFixture({
		artifactName: "ferment-v2-requirements",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			// The source-only drafter records the contract before any candidate,
			// then ends its turn (second completion request).
			draftRequirements(DRAFT_ITEMS),
			{
				match: isRequirementsDraftRequest,
				stream: ["The requirements are recorded."],
			},
			// The seeded verifier acknowledges the identical persisted list...
			verifierRequirements(DRAFT_ITEMS),
			// ...executes one bash check stamped [e1]...
			{
				match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
				stream: ["Running the verification check."],
				toolCalls: [
					{
						id: "verifier-bash-check",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${OUTPUT_FILE})" = done` }) },
					},
				],
			},
			// ...then returns its met verdict citing the executed evidence.
			{
				match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
				stream: [metVerdict],
			},
			// The implementer: create the artifact, verify it, claim, deliver.
			{
				stream: ["Creating the requested file."],
				toolCalls: [
					{
						id: "create-req-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({
								todos: [{ content: "Create and verify acp-req.txt", status: "in_progress" }],
							}),
						},
					},
					{
						id: "write-req-file",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: OUTPUT_FILE, content: "done" }) },
					},
				],
			},
			{
				stream: ["The requested file is verified."],
				toolCalls: [
					{
						id: "read-req-file",
						index: 0,
						function: { name: "read", arguments: JSON.stringify({ path: OUTPUT_FILE }) },
					},
					{
						id: "finish-req-todo",
						index: 1,
						function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
					},
				],
			},
			{
				stream: ["Claiming completion."],
				toolCalls: [
					{
						id: "claim-req-complete",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
						},
					},
				],
			},
			{ stream: [ACCEPTED_FINAL] },
		],
	})
	fixture = active
	execFileSync("git", ["init", "-q"], { cwd: active.workDir })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: active.workDir })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: active.workDir })
	writeFileSync(join(active.workDir, "README.md"), "demo\n")
	execFileSync("git", ["add", "."], { cwd: active.workDir })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: active.workDir })
	const session = await newSession(active, active.workDir)

	const running = await prompt(active, session, `/ferment-v2 ${OBJECTIVE}`)
	expect(running.stopReason).not.toBe("ERROR")

	const chat = () => chatRequests(active)
	await waitFor(chat, (requests) => requests.some((row) => isRequirementsDraftRequest(row)))
	await waitFor(
		chat,
		(requests) =>
			requests.some((row) => isVerifierRequest(row)) &&
			readFileSync(join(active.workDir, OUTPUT_FILE), "utf8") === "done",
	)

	// Ordering: the accepted draft preceded the first implementation request.
	expect(draftPrecedesImplementation(chat())).toBe(true)
	const firstImplementer = chat().find(isImplementerRequest)
	const initialContext = JSON.stringify(firstImplementer?.body)
	expect(initialContext).toContain('\\"availability\\": \\"ready\\"')
	expect(initialContext).toContain('\\"contractVersion\\": 1')
	expect(initialContext).toContain(DRAFT_ITEMS[0].acceptance)

	// The verifier verified the persisted contract, not a fresh list.
	const seeded = chat()
		.filter(isVerifierRequest)
		.map((row) => JSON.stringify(row.body))
		.join("\n")
	expect(seeded).toContain("Established requirements (persisted contract v1")
	expect(seeded).toContain("drafted pre implementation")
	expect(readFileSync(join(active.workDir, OUTPUT_FILE), "utf-8")).toBe("done")

	const notifiedMessages = () => active.client.extNotifications.map((n) => JSON.stringify(n.params))
	await waitFor(notifiedMessages, (records) =>
		records.some((record) => record.includes("Ferment V2 verifier accepted the completion")),
	)
	await waitFor(notifiedMessages, (records) => records.some((record) => record.includes("Ferment V2 complete.")))
})

it("keeps degraded work running but refuses a first-pass met when both requirements drafts failed", async () => {
	const active = await startAcpFixture({
		artifactName: "ferment-v2-requirements-unavailable",
		extraArgs: ["--yolo"],
		settings: { resources: { "extensions.ferment-v2": true } },
		responses: [
			{ match: isRequirementsDraftRequest, stream: ["The draft is unavailable."] },
			{ match: isRequirementsDraftRequest, streamError: "draft provider down" },
			verifierRequirements(DRAFT_ITEMS),
			{
				match: (request) => isVerifierRequest(request) && !JSON.stringify(request.body).includes("[e1]"),
				toolCalls: [
					{
						id: "check-degraded-file",
						function: { name: "bash", arguments: JSON.stringify({ command: `test "$(cat ${OUTPUT_FILE})" = done` }) },
					},
				],
			},
			{
				match: (request) => isVerifierRequest(request) && JSON.stringify(request.body).includes("[e1]"),
				stream: [
					JSON.stringify({
						verdict: "met",
						reason: "File verified",
						checks: [
							{
								requirementId: "r1",
								kind: "work",
								requirement: DRAFT_ITEMS[0].requirement,
								method: "command",
								status: "pass",
								failureMode: "wrong file content",
								evidence: ["e1"],
							},
						],
					}),
				],
			},
			{
				toolCalls: [
					{
						id: "degraded-todos",
						index: 0,
						function: {
							name: "create_todos",
							arguments: JSON.stringify({ todos: [{ content: DRAFT_ITEMS[0].requirement, status: "completed" }] }),
						},
					},
					{
						id: "degraded-write",
						index: 1,
						function: { name: "write", arguments: JSON.stringify({ path: OUTPUT_FILE, content: "done" }) },
					},
				],
			},
			{
				toolCalls: [
					{
						id: "degraded-claim",
						function: {
							name: "update_ferment_v2",
							arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
						},
					},
				],
			},
		],
	})
	fixture = active
	const session = await newSession(active, active.workDir)
	await prompt(active, session, `/ferment-v2 ${OBJECTIVE}`)
	const notifications = () => active.client.extNotifications.map((entry) => JSON.stringify(entry.params))
	await waitFor(notifications, (records) => records.some((record) => record.includes("Ferment V2 paused")))
	expect(readFileSync(join(active.workDir, OUTPUT_FILE), "utf8")).toBe("done")
	expect(chatRequests(active).filter(isRequirementsDraftRequest)).toHaveLength(2)
	// Three requests: record working criteria, execute check, return met. No correction was needed.
	expect(chatRequests(active).filter(isVerifierRequest)).toHaveLength(3)
	expect(notifications().some((record) => record.includes("ready requirements contract"))).toBe(true)
	expect(notifications().some((record) => record.includes("Ferment V2 complete."))).toBe(false)
})
