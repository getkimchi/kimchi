import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest } from "../review-targets/types.js"
import { createReviewWorktreePool } from "./worktrees.js"

const repository = process.env.REVIEW_CRASH_REPOSITORY
const outputDir = process.env.REVIEW_CRASH_OUTPUT
const rootDir = process.env.REVIEW_CRASH_ROOT
const point = process.env.REVIEW_CRASH_POINT
if (!repository || !outputDir || !rootDir || (point !== "before-add" && point !== "after-add")) {
	throw new Error("crash fixture requires repository, output, root, and a valid crash point")
}

const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
	root: repository,
	contextDir: process.env.REVIEW_CRASH_CONTEXT,
})
const pool = await createReviewWorktreePool({
	target,
	outputDir,
	rootDir,
	worktreeCrashPoint: async (actualPoint, details) => {
		if (actualPoint !== point) return
		process.send?.({ type: actualPoint, path: details.path, runDir: pool.runDir })
		await new Promise<void>(() => {})
	},
})
await pool.getWorktree("crashed")
