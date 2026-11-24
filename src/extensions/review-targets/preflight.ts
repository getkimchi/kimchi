import { gitBytes, gitResultError, gitText } from "./git.js"
import { ReviewTargetError } from "./types.js"

const DISPLAY_PATH_LIMIT = 20

function pathList(paths: string[]): string {
	const visible = paths.slice(0, DISPLAY_PATH_LIMIT).join(", ")
	return paths.length > DISPLAY_PATH_LIMIT ? `${visible}, and ${paths.length - DISPLAY_PATH_LIMIT} more` : visible
}

function unsupported(detail: string): never {
	throw new ReviewTargetError(
		"unsupported_content_filter",
		`Local review targets cannot safely inspect configured content filters or working-tree encodings: ${detail}.`,
	)
}

async function configuredFilters(root: string, signal?: AbortSignal): Promise<string[]> {
	const output = await gitText(root, ["config", "--name-only", "--null", "--get-regexp", "^filter\\."], {
		signal,
		allowFailure: true,
	})
	return output
		.split("\0")
		.filter((key) => /\.(?:clean|smudge|process)$/.test(key))
		.sort()
}

async function repositoryPaths(root: string, signal?: AbortSignal): Promise<Set<string>> {
	const paths = new Set<string>()
	const head = await gitBytes(root, ["rev-parse", "--verify", "--end-of-options", "HEAD"], {
		signal,
		allowFailure: true,
	})
	if (head.exitCode !== 0 && head.failure && typeof head.failure.code !== "number") {
		throw gitResultError(["rev-parse", "HEAD"], head)
	}
	if (head.exitCode === 0) {
		const committed = await gitBytes(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], { signal })
		for (const path of committed.stdout.toString("utf8").split("\0")) if (path) paths.add(path)
	}
	const selected = await gitBytes(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { signal })
	for (const path of selected.stdout.toString("utf8").split("\0")) if (path) paths.add(path)
	return paths
}

async function assignedConversions(root: string, paths: Set<string>, signal?: AbortSignal): Promise<string[]> {
	if (!paths.size) return []
	const output = await gitText(root, ["check-attr", "--stdin", "-z", "filter", "working-tree-encoding"], {
		input: Buffer.from([...paths].map((path) => `${path}\0`).join("")),
		signal,
	})
	const fields = output.split("\0")
	const assigned = new Set<string>()
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const value = fields[index + 2]
		if (value !== "unspecified" && value !== "unset") assigned.add(fields[index])
	}
	return [...assigned].sort()
}

/** Use only non-converting discovery before status, content diffs, or add can execute conversion drivers. */
export async function assertNoConversionDrivers(root: string, signal?: AbortSignal): Promise<void> {
	const filters = await configuredFilters(root, signal)
	if (filters.length) unsupported(`configured commands ${filters.join(", ")}`)
	const paths = await assignedConversions(root, await repositoryPaths(root, signal), signal)
	if (paths.length) unsupported(`attributes on ${pathList(paths)}`)
}
