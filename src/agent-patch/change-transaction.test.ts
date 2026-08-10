import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ChangeTransaction } from "./change-transaction.js"

class AfterVerifyTransaction extends ChangeTransaction {
	constructor(
		root: string,
		private afterVerify?: () => void | Promise<void>,
	) {
		super(root)
	}

	override async verifyBase() {
		const verification = await super.verifyBase()
		const afterVerify = this.afterVerify
		if (verification.ok && afterVerify) {
			this.afterVerify = undefined
			await afterVerify()
		}
		return verification
	}
}

describe("ChangeTransaction", () => {
	let root: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi-change-transaction-"))
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	it("stages an update without changing the authoritative file", async () => {
		const path = join(root, "answer.txt")
		writeFileSync(path, "wrong\n")
		const transaction = new ChangeTransaction(root)

		await transaction.stageWrite(path, "right\n")

		expect(readFileSync(path, "utf8")).toBe("wrong\n")
		expect((await transaction.readBuffer(path)).toString("utf8")).toBe("right\n")
		expect(transaction.changeSet().operations).toMatchObject([
			{ kind: "update", path: "answer.txt", content: "right\n" },
		])
	})

	it("stages create, delete, and rename as one stable cumulative patch", async () => {
		writeFileSync(join(root, "delete.txt"), "delete me\n")
		writeFileSync(join(root, "rename.txt"), "move me\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("new.txt", "new\n")
		await transaction.stageDelete("delete.txt")
		await transaction.stageRename("rename.txt", "moved.txt")

		const first = transaction.changeSet()
		const second = transaction.changeSet()

		expect(second).toEqual(first)
		expect(first.operations.map((operation) => operation.kind)).toEqual(["delete", "create", "rename"])
		expect(first.stats.files).toBe(4)
		expect(first.patch).toContain("# rename rename.txt -> moved.txt")
	})

	it("keeps the patch hash stable across equivalent staging order", async () => {
		writeFileSync(join(root, "a.txt"), "a\n")
		writeFileSync(join(root, "b.txt"), "b\n")
		const left = new ChangeTransaction(root)
		const right = new ChangeTransaction(root)
		await left.stageWrite("b.txt", "B\n")
		await left.stageWrite("a.txt", "A\n")
		await right.stageWrite("a.txt", "A\n")
		await right.stageWrite("b.txt", "B\n")

		expect(left.changeSet().patch).toBe(right.changeSet().patch)
		expect(left.changeSet().patchSha256).toBe(right.changeSet().patchSha256)
	})

	it("collapses a write reverted to its base into no change", async () => {
		writeFileSync(join(root, "same.txt"), "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("same.txt", "changed\n")
		await transaction.stageWrite("same.txt", "base\n")

		expect(transaction.changeSet().operations).toEqual([])
	})

	it("rejects traversal, absolute escape, and symlink paths", async () => {
		const outside = mkdtempSync(join(tmpdir(), "kimchi-change-outside-"))
		writeFileSync(join(outside, "secret.txt"), "secret\n")
		symlinkSync(outside, join(root, "escape"))
		const transaction = new ChangeTransaction(root)

		await expect(transaction.stageWrite("../outside.txt", "no")).rejects.toThrow(/escapes transaction root/)
		await expect(transaction.stageWrite(join(outside, "absolute.txt"), "no")).rejects.toThrow(
			/escapes transaction root/,
		)
		await expect(transaction.stageWrite("escape/secret.txt", "no")).rejects.toThrow(/Symbolic links/)
		rmSync(outside, { recursive: true, force: true })
	})

	it("rejects nonexistent destination aliases on case-insensitive filesystems", async () => {
		const probe = join(root, "case-probe")
		writeFileSync(probe, "")
		try {
			if (statSync(probe).ino !== statSync(join(root, "CASE-PROBE")).ino) return
		} catch {
			return
		}
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("new-file.txt", "first\n")
		await transaction.stageWrite("NEW-FILE.txt", "second\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/aliases/)

		expect(() => readFileSync(join(root, "new-file.txt"), "utf8")).toThrow()
	})

	it("rejects non-UTF-8 and directory mutation", async () => {
		writeFileSync(join(root, "binary.bin"), Buffer.from([0xff, 0xfe]))
		mkdirSync(join(root, "folder"))
		const transaction = new ChangeTransaction(root)

		await expect(transaction.readBuffer("binary.bin")).rejects.toThrow(/UTF-8/)
		await expect(transaction.stageWrite("folder", "no")).rejects.toThrow(/directory/)
	})

	it("blocks staging after proposal and allows one explicit revision reopen", async () => {
		writeFileSync(join(root, "a.txt"), "a\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("a.txt", "b\n")
		const proposed = transaction.propose()

		await expect(transaction.stageWrite("a.txt", "c\n")).rejects.toThrow(/sealed/)
		transaction.reopenForRevision(proposed.patchSha256)
		await transaction.stageWrite("a.txt", "c\n")
		expect(transaction.state).toBe("revision")
	})

	it("detects content, mode, appearance, and deletion drift", async () => {
		writeFileSync(join(root, "content.txt"), "base\n")
		writeFileSync(join(root, "mode.txt"), "base\n", { mode: 0o644 })
		writeFileSync(join(root, "gone.txt"), "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("content.txt", "next\n")
		await transaction.stageWrite("mode.txt", "next\n")
		await transaction.stageWrite("gone.txt", "next\n")
		await transaction.stageWrite("appeared.txt", "next\n")
		writeFileSync(join(root, "content.txt"), "drift\n")
		chmodSync(join(root, "mode.txt"), 0o600)
		rmSync(join(root, "gone.txt"))
		writeFileSync(join(root, "appeared.txt"), "surprise\n")

		const verification = await transaction.verifyBase()
		expect(verification.ok).toBe(false)
		expect(verification.conflicts).toEqual(
			expect.arrayContaining([
				{ path: "appeared.txt", reason: "appeared" },
				{ path: "content.txt", reason: "content_changed" },
				{ path: "gone.txt", reason: "missing" },
				{ path: "mode.txt", reason: "mode_changed" },
			]),
		)
	})

	it("applies the exact accepted patch and retains rollback until finalization", async () => {
		writeFileSync(join(root, "edit.txt"), "base\n", { mode: 0o640 })
		writeFileSync(join(root, "delete.txt"), "remove\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("edit.txt", "next\n")
		await transaction.stageWrite("create/nested.txt", "new\n")
		await transaction.stageDelete("delete.txt")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)

		const receipt = await transaction.applyExact(proposed.patchSha256)

		expect(receipt.patchSha256).toBe(proposed.patchSha256)
		expect(readFileSync(join(root, "edit.txt"), "utf8")).toBe("next\n")
		expect(statSync(join(root, "edit.txt")).mode & 0o777).toBe(0o640)
		expect(readFileSync(join(root, "create/nested.txt"), "utf8")).toBe("new\n")
		expect(() => readFileSync(join(root, "delete.txt"))).toThrow()
		expect(transaction.state).toBe("post_apply_checks")

		await transaction.finalizeApplied()
		expect(transaction.state).toBe("applied")
	})

	it("rejects an unaccepted or mismatched patch", async () => {
		writeFileSync(join(root, "a.txt"), "a\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("a.txt", "b\n")
		const proposed = transaction.propose()

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/while proposed/)
		expect(() => transaction.accept("wrong")).toThrow(/does not match/)
	})

	it("blocks apply when the reviewed base becomes stale", async () => {
		const path = join(root, "a.txt")
		writeFileSync(path, "a\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(path, "b\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)
		writeFileSync(path, "someone else\n")

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/Workspace changed after review/)
		expect(readFileSync(path, "utf8")).toBe("someone else\n")
	})

	it("rejects physical path aliases introduced after proposal", async () => {
		const first = join(root, "a.txt")
		const second = join(root, "b.txt")
		writeFileSync(first, "base\n")
		writeFileSync(second, "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(first, "first candidate\n")
		await transaction.stageWrite(second, "second candidate\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)
		rmSync(second)
		linkSync(first, second)

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/aliases/)

		expect(readFileSync(first, "utf8")).toBe("base\n")
		expect(readFileSync(second, "utf8")).toBe("base\n")
	})

	it("preserves a concurrent edit made after base verification and rolls back earlier entries", async () => {
		writeFileSync(join(root, "a.txt"), "a base\n")
		writeFileSync(join(root, "z.txt"), "z base\n")
		const transaction = new AfterVerifyTransaction(root, () => {
			writeFileSync(join(root, "z.txt"), "concurrent\n")
		})
		await transaction.stageWrite("a.txt", "a candidate\n")
		await transaction.stageWrite("z.txt", "z candidate\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/rolled back/)

		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a base\n")
		expect(readFileSync(join(root, "z.txt"), "utf8")).toBe("concurrent\n")
		expect(transaction.state).toBe("rolled_back")
	})

	it("does not replace a concurrent create and rolls back earlier entries", async () => {
		writeFileSync(join(root, "a.txt"), "a base\n")
		const transaction = new AfterVerifyTransaction(root, () => {
			writeFileSync(join(root, "z-new.txt"), "concurrent\n")
		})
		await transaction.stageWrite("a.txt", "a candidate\n")
		await transaction.stageWrite("z-new.txt", "candidate\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)

		await expect(transaction.applyExact(proposed.patchSha256)).rejects.toThrow(/rolled back/)

		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a base\n")
		expect(readFileSync(join(root, "z-new.txt"), "utf8")).toBe("concurrent\n")
		expect(transaction.state).toBe("rolled_back")
	})

	it("rolls an applied patch back to exact base bytes and modes", async () => {
		writeFileSync(join(root, "edit.txt"), "base\n", { mode: 0o600 })
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite("edit.txt", "next\n")
		await transaction.stageWrite("new/created.txt", "created\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)
		await transaction.applyExact(proposed.patchSha256)

		await transaction.rollbackApplied()

		expect(readFileSync(join(root, "edit.txt"), "utf8")).toBe("base\n")
		expect(statSync(join(root, "edit.txt")).mode & 0o777).toBe(0o600)
		expect(() => readFileSync(join(root, "new/created.txt"))).toThrow()
		expect(transaction.state).toBe("rolled_back")
	})

	it("refuses destructive rollback after concurrent post-apply changes", async () => {
		const path = join(root, "a.txt")
		writeFileSync(path, "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(path, "accepted\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)
		await transaction.applyExact(proposed.patchSha256)
		writeFileSync(path, "concurrent\n")

		await expect(transaction.rollbackApplied()).rejects.toThrow(/could not safely restore/)
		expect(readFileSync(path, "utf8")).toBe("concurrent\n")
		expect(transaction.state).toBe("hard_recovery")
	})

	it("discards a staged candidate without touching files", async () => {
		const path = join(root, "a.txt")
		writeFileSync(path, "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(path, "candidate\n")

		await transaction.discard()

		expect(readFileSync(path, "utf8")).toBe("base\n")
		expect(transaction.changeSet().operations).toEqual([])
		expect(transaction.state).toBe("discarded")
	})

	it("cannot discard an applied patch or destroy its rollback data", async () => {
		const path = join(root, "a.txt")
		writeFileSync(path, "base\n")
		const transaction = new ChangeTransaction(root)
		await transaction.stageWrite(path, "accepted\n")
		const proposed = transaction.propose()
		transaction.accept(proposed.patchSha256)
		await transaction.applyExact(proposed.patchSha256)

		await expect(transaction.discard()).rejects.toThrow(/Cannot discard transaction while post_apply_checks/)
		expect(readFileSync(path, "utf8")).toBe("accepted\n")

		await transaction.rollbackApplied()
		expect(readFileSync(path, "utf8")).toBe("base\n")
		expect(transaction.state).toBe("rolled_back")
	})

	it("keeps concurrent transaction overlays isolated", async () => {
		const path = join(root, "a.txt")
		writeFileSync(path, "base\n")
		const left = new ChangeTransaction(root)
		const right = new ChangeTransaction(root)
		await left.stageWrite(path, "left\n")
		await right.stageWrite(path, "right\n")

		expect((await left.readBuffer(path)).toString("utf8")).toBe("left\n")
		expect((await right.readBuffer(path)).toString("utf8")).toBe("right\n")
		expect(readFileSync(path, "utf8")).toBe("base\n")
	})
})
