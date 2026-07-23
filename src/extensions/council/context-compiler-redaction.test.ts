import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ChangeTransaction } from "../../agent-patch/index.js"
import { compileCouncilContext } from "./context-compiler.js"
import type { CandidatePatchArtifact } from "./schemas.js"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kimchi-council-redaction-"))
	temporaryRoots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Council candidate redaction", () => {
	it("keeps generated update hashes and patch evidence exact", async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, "service.mjs"), "export const value = 1\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("service.mjs", "export const value = 2\n")
		const candidate = transaction.changeSet()

		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Update the value", timestamp: 1 }] },
			runId: "redaction_update",
			candidate,
		})
		const artifact = compiled.artifacts.find((item): item is CandidatePatchArtifact => item.kind === "candidate_patch")
		const update = candidate.operations.find((operation) => operation.kind === "update")

		expect(artifact?.candidate_patch).toMatchObject({
			transaction_id: candidate.transactionId,
			patch_sha256: candidate.patchSha256,
			patch: candidate.patch,
		})
		expect(artifact?.candidate_patch.operations[0]?.base_sha256).toBe(update?.baseSha256)
	})

	it("keeps create, delete, and rename candidate evidence exact", async () => {
		const root = await temporaryRoot()
		await Promise.all([
			writeFile(join(root, "delete.mjs"), "export const removed = true\n"),
			writeFile(join(root, "rename.mjs"), "export const renamed = true\n"),
		])
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("created.mjs", "export const created = true\n")
		await transaction.stageDelete("delete.mjs")
		await transaction.stageRename("rename.mjs", "renamed.mjs")
		const candidate = transaction.changeSet()

		const compiled = await compileCouncilContext({
			context: { messages: [{ role: "user", content: "Apply the file changes", timestamp: 1 }] },
			runId: "redaction_operations",
			candidate,
		})
		const artifact = compiled.artifacts.find((item): item is CandidatePatchArtifact => item.kind === "candidate_patch")

		expect(artifact?.candidate_patch.patch).toBe(candidate.patch)
		expect(artifact?.candidate_patch.operations).toEqual(
			candidate.operations.map((operation) => ({
				kind: operation.kind,
				path: operation.path,
				...(operation.kind === "rename" ? { from_path: operation.fromPath } : {}),
				...(operation.kind === "create" ? {} : { base_sha256: operation.baseSha256 }),
			})),
		)
	})

	it("fails closed when a code hunk contains a secret", async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, "service.mjs"), "export const value = 1\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(
			"service.mjs",
			'export const value = 2\nexport const leaked = "castai_v1_abcdefgh123456"\n',
		)

		await expect(
			compileCouncilContext({
				context: { messages: [{ role: "user", content: "Update the value", timestamp: 1 }] },
				runId: "redaction_secret",
				candidate: transaction.changeSet(),
			}),
		).rejects.toMatchObject({ code: "redaction_failed" })
	})
})
