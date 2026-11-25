import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import type { resolveReviewDirectories } from "../review-submit/paths.js"

export async function createLocalReviewRunDirectory(outputRoot: string): Promise<string> {
	const checked = async (path: string) => {
		const result = await checkReviewDirectory(path, { isDefault: false, create: true })
		if (result.kind !== "ready") {
			throw new Error(
				`Review output directory ${path} is ${result.kind}${result.kind === "unsafe" ? `: ${result.reason}` : ""}`,
			)
		}
		return result.path
	}
	const ownedRoot = await checked(outputRoot)
	const runsRoot = await checked(join(ownedRoot, "runs"))
	const generatedId = `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}`
	const runDir = join(runsRoot, generatedId)
	await mkdir(runDir)
	return runDir
}

function canonicalPath(path: string): string {
	let ancestor = resolve(path)
	while (true) {
		try {
			return resolve(realpathSync(ancestor), relative(ancestor, path))
		} catch {
			const parent = dirname(ancestor)
			if (parent === ancestor) return path
			ancestor = parent
		}
	}
}

/** Canonicalize the effective owned paths, including before a new output root
 * exists. Outside-checkout paths are harmless to filtering and returned as-is. */
export function reviewOwnedDirectories(directories: ReturnType<typeof resolveReviewDirectories>): string[] {
	return [canonicalPath(directories.contextDir), canonicalPath(directories.outputDir)]
}
