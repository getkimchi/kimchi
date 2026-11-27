import { splitCompoundCommand } from "../permissions/taxonomy.js"
import { gitBytes, gitText } from "../review-targets/git.js"

export interface ReviewCheckDefinition {
	id: string
	command: string
	/** Repository-relative directory at the pinned revision. */
	cwd: string
	kind: "build" | "test" | "other"
	/** Injected only: a passing test/other run also satisfies build verification. */
	builds: boolean
	toolchain: string
	/** Repository-relative files whose pinned bytes form the dependency profile. */
	dependencies: string[]
}

const DEFAULT_DEPENDENCIES = [
	"package.json",
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"bun.lock",
	"go.mod",
	"go.sum",
	"Cargo.toml",
	"Cargo.lock",
	"requirements.txt",
	"poetry.lock",
	"uv.lock",
	"Gemfile",
	"Gemfile.lock",
	"composer.json",
	"composer.lock",
] as const

async function pinnedFile(repository: string, sha: string, path: string): Promise<Buffer | undefined> {
	const result = await gitBytes(repository, ["show", `${sha}:${path}`], { allowFailure: true })
	if (result.exitCode !== 0) return undefined
	return result.stdout
}

function exactBuildThenTest(script: string, packageManager: string): boolean {
	const segments = splitCompoundCommand(script)
	if (segments?.length !== 2) return false
	const build = segments[0]?.trim().replace(/\s+/g, " ")
	if (build !== `${packageManager} run build`) return false
	const test = segments[1]?.trim() ?? ""
	return test.length > 0 && !/(?:^|\s)(?:[a-z]+\s+)?run\s+build(?:\s|$)/.test(test)
}

/** Discover convenience routines from reviewed package.json content. These are
 * not trusted verification policy. `builds` is inferred only for an exact
 * two-segment `<package manager> run build && <test>` script; lifecycle details
 * such as pretest never claim compilation. */
export async function discoverPackageReviewChecks(
	repository: string,
	headSha: string,
): Promise<ReviewCheckDefinition[]> {
	await gitText(repository, ["rev-parse", "--verify", "--end-of-options", `${headSha}^{commit}`])
	const contents = await pinnedFile(repository, headSha, "package.json")
	if (!contents) return []
	let value: unknown
	try {
		value = JSON.parse(contents.toString("utf8"))
	} catch {
		return []
	}
	const scripts = (value as { scripts?: unknown }).scripts
	if (!scripts || typeof scripts !== "object") return []
	const entries = scripts as Record<string, unknown>
	const packageManager = (await pinnedFile(repository, headSha, "pnpm-lock.yaml")) ? "pnpm" : "npm"
	const checks: ReviewCheckDefinition[] = []
	for (const kind of ["build", "test"] as const) {
		const script = entries[kind]
		if (typeof script !== "string" || !script.trim()) continue
		checks.push({
			id: kind,
			command: `${packageManager} run ${kind}`,
			cwd: ".",
			kind,
			builds: kind === "test" && exactBuildThenTest(script, packageManager),
			toolchain: "inherited",
			dependencies: [...DEFAULT_DEPENDENCIES],
		})
	}
	return checks
}
