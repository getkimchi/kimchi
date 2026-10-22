import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FakeResponseScript } from "./fake-openai-server.js"
import { isVerifierRequest, verifierRequirements } from "./ferment-v2-verifier.js"

export const ORIGINAL_TEST_OBJECTIVE = "Preserve value.cjs returning 1 and verify the original assertion"
export const ORIGINAL_TEST_FINAL = "ORIGINAL_ASSERTION_REPAIRED"
export function seedOriginalTestRepository(workDir: string): string {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, encoding: "utf8" }).trim()
	git("init", "-q")
	git("config", "user.email", "test@example.com")
	git("config", "user.name", "Test")
	writeFileSync(join(workDir, "value.cjs"), "module.exports = 1")
	writeFileSync(join(workDir, "value.test.cjs"), "require('node:assert/strict').equal(require('./value.cjs'), 1)\n")
	git("add", ".")
	git("commit", "-qm", "original assertion")
	return git("rev-parse", "HEAD")
}
const call = (id: string, name: string, args: unknown, index = 0) => ({
	id,
	index,
	function: { name, arguments: JSON.stringify(args) },
})
export function originalTestVerificationResponses(pass: boolean): FakeResponseScript[] {
	return [
		verifierRequirements(ORIGINAL_TEST_OBJECTIVE),
		{
			match: isVerifierRequest,
			toolCalls: [
				call(`original-${pass}`, "run_original_test", {
					flag: "f1",
					runner: process.execPath,
					args: ["{test}"],
					timeout: 5,
				}),
			],
		},
		{
			match: isVerifierRequest,
			stream: [
				JSON.stringify({
					verdict: pass ? "met" : "continue",
					reason: pass ? "Original assertion passes." : "Restore the original value contract.",
					checks: [
						{
							requirementId: "r1",
							requirement: ORIGINAL_TEST_OBJECTIVE,
							status: pass ? "pass" : "fail",
							method: "baseline_test",
							failureMode: "Changed value hidden by weakened tests",
							flags: ["f1"],
							evidence: ["e1"],
						},
					],
					supportingEvidence: ["e1"],
				}),
			],
		},
	]
}
export function originalTestRepairResponses(): FakeResponseScript[] {
	return [
		...originalTestVerificationResponses(false),
		...originalTestVerificationResponses(true),
		{
			toolCalls: [
				call("original-todos", "create_todos", {
					todos: [{ content: ORIGINAL_TEST_OBJECTIVE, status: "completed", note: "Candidate tests pass" }],
				}),
				call("break-value", "write", { path: "value.cjs", content: "module.exports = 2" }, 1),
				call("weaken-test", "write", { path: "value.test.cjs", content: "require('node:assert/strict').ok(true)" }, 2),
			],
		},
		{
			toolCalls: [call("original-claim", "update_ferment_v2", { status: "complete", completion_confidence: "proven" })],
		},
		{
			stream: ["Repairing the value exposed by the original assertion."],
			toolCalls: [call("repair-value", "write", { path: "value.cjs", content: "module.exports = 1" })],
		},
		{
			toolCalls: [
				call("original-reclaim", "update_ferment_v2", { status: "complete", completion_confidence: "proven" }),
			],
		},
		{ stream: [ORIGINAL_TEST_FINAL] },
	]
}
