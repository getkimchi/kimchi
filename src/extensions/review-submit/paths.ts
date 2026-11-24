import { resolve } from "node:path"

export interface ReviewPathOverrides {
	contextDir?: string
	outputDir?: string
}

export interface ReviewDirectories {
	contextDir: string
	outputDir: string
	/** Project root used only when a directory comes from the default, not a flag. */
	projectDir?: string
	contextDirIsDefault?: boolean
	outputDirIsDefault?: boolean
}

/** Resolve flag paths against the current session project. An absent flag uses
 * the project-local runtime directory; no home-directory fallback is allowed. */
export function resolveReviewDirectories(cwd: string, overrides: ReviewPathOverrides = {}): ReviewDirectories {
	return {
		projectDir: cwd,
		contextDir: resolve(cwd, overrides.contextDir || ".kimchi/review-context"),
		outputDir: resolve(cwd, overrides.outputDir || ".kimchi/review-output"),
		contextDirIsDefault: overrides.contextDir === undefined,
		outputDirIsDefault: overrides.outputDir === undefined,
	}
}
