import { lstat } from "node:fs/promises"
import { join } from "node:path"
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

async function configuredFilterDrivers(root: string, signal?: AbortSignal): Promise<Set<string>> {
	const output = await gitText(root, ["config", "--name-only", "--null", "--get-regexp", "^filter\\."], {
		signal,
		allowFailure: true,
	})
	const drivers = new Set<string>()
	for (const key of output.split("\0")) {
		if (!key.startsWith("filter.")) continue
		const suffix = key.lastIndexOf(".")
		const capability = key.slice(suffix + 1)
		if (capability === "clean" || capability === "smudge" || capability === "process") {
			drivers.add(key.slice("filter.".length, suffix))
		}
	}
	return drivers
}

/** Changed/staged/untracked paths discovered without content conversion. */
export async function workingTreeCandidatePaths(root: string, signal?: AbortSignal): Promise<string[]> {
	const paths = new Set<string>()
	const headArgs = ["rev-parse", "--verify", "--end-of-options", "HEAD"] as const
	const head = await gitBytes(root, headArgs, { signal, allowFailure: true })
	if (head.exitCode !== 0 && head.failure && typeof head.failure.code !== "number") {
		throw gitResultError(headArgs, head)
	}
	if (head.exitCode === 0) {
		const staged = await gitBytes(
			root,
			["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
			{ signal },
		)
		for (const path of staged.stdout.toString("utf8").split("\0")) if (path) paths.add(path)
	} else {
		const cached = await gitBytes(root, ["ls-files", "-z", "--cached"], { signal })
		for (const path of cached.stdout.toString("utf8").split("\0")) if (path) paths.add(path)
	}
	// ls-files --modified compares cached stat data, including racily-clean stat
	// data, rather than running clean filters over contents. The central empty
	// filter overrides still make any unexpected conversion fail closed.
	const selected = await gitBytes(
		root,
		["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"],
		{
			signal,
		},
	)
	for (const path of selected.stdout.toString("utf8").split("\0")) if (path) paths.add(path)
	return [...paths].sort()
}

/** Deleted paths need no attribute checks because conversion cannot read their contents. */
async function existingPaths(root: string, paths: string[]): Promise<string[]> {
	const existing: string[] = []
	for (const path of paths) {
		try {
			await lstat(join(root, path))
			existing.push(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	return existing
}

function assignedConversions(attributes: Buffer, drivers: Set<string>): string[] {
	const fields = attributes.toString("utf8").split("\0")
	const assigned = new Set<string>()
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const path = fields[index]
		const attribute = fields[index + 1]
		const value = fields[index + 2]
		if (value === "unspecified" || value === "unset") continue
		if (attribute === "working-tree-encoding") {
			assigned.add(`${path} (working-tree-encoding=${value})`)
		} else if (attribute === "filter" && drivers.has(value)) {
			assigned.add(`${path} (filter=${value})`)
		}
	}
	return [...assigned].sort()
}

/** Use only non-converting discovery before status, content diffs, or add can execute conversion drivers. */
export async function assertNoConversionDrivers(root: string, signal?: AbortSignal): Promise<string[]> {
	const [paths, drivers] = await Promise.all([
		workingTreeCandidatePaths(root, signal),
		configuredFilterDrivers(root, signal),
	])
	if (!paths.length) return paths
	const existing = await existingPaths(root, paths)
	if (!existing.length) return paths
	const attributes = await gitBytes(root, ["check-attr", "--stdin", "-z", "filter", "working-tree-encoding"], {
		input: Buffer.from(existing.map((path) => `${path}\0`).join("")),
		signal,
	})
	const assigned = assignedConversions(attributes.stdout, drivers)
	if (assigned.length) unsupported(`attributes on ${pathList(assigned)}`)
	return paths
}
