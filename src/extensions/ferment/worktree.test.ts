import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { checkWorktree } from "./worktree.js"

function fermentAt(worktreePath: string): Ferment {
	return {
		worktree: { path: worktreePath, branch: undefined },
	} as Ferment
}

describe("checkWorktree cwd parameter", () => {
	it("passes when the supplied cwd is the ferment worktree", () => {
		expect(checkWorktree(fermentAt("/tmp/proj"), "/tmp/proj").severity).toBe("ok")
	})

	it("passes when the supplied cwd is inside the ferment worktree", () => {
		expect(checkWorktree(fermentAt("/tmp/proj"), "/tmp/proj/src/pkg").severity).toBe("ok")
	})

	it("blocks when the supplied cwd is outside the ferment worktree", () => {
		const check = checkWorktree(fermentAt("/tmp/proj"), "/elsewhere")
		expect(check.severity).toBe("block")
		expect(check.message).toContain("/elsewhere")
	})

	it("never consults process.cwd() — only the explicit cwd", () => {
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/fake/harness-cwd")
		try {
			// Even though process.cwd() would match the ferment, an explicit
			// cwd elsewhere must still block.
			expect(checkWorktree(fermentAt("/fake/harness-cwd"), "/elsewhere").severity).toBe("block")
			expect(checkWorktree(fermentAt("/session/dir"), "/session/dir").severity).toBe("ok")
		} finally {
			spy.mockRestore()
		}
	})
})
