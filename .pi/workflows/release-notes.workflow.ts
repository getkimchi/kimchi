/**
 * Sample workflow: draft release notes for the commits since the last tag.
 *
 * It is deliberately a *little* bigger than `hello.workflow.ts`, because the interesting part of
 * this framework is not a single step — it is how steps hand off. So it exercises the four
 * constructs you reach for first:
 *
 *   .then(createStep)       — plain TypeScript, here shelling out to git
 *   .then(createAgentStep)  — an LLM step whose reply is parsed and validated against a schema
 *   .map()                  — a pure transform that re-shapes one step's output into the next's input
 *   .branch()               — a conditional arm that only runs when the classification found breaks
 *
 * Run it:  /workflow run release-notes
 * Output:  .pi/workflows/out/RELEASE_NOTES.md
 *
 * `typebox` and `@pmateusz/pi-workflows` are injected by the extension's loader, so this repo does
 * not need them installed to run. Install them as devDependencies only if you want your editor and
 * `tsc` to typecheck the file.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { createAgentStep, createStep, createWorkflow } from "@pmateusz/pi-workflows";

const exec = promisify(execFile);

const REPO_ROOT = process.cwd();
const OUTPUT_PATH = join(REPO_ROOT, ".pi/workflows/out/RELEASE_NOTES.md");

/** How far back to look when the repo has no tags yet. */
const FALLBACK_COMMIT_COUNT = 30;

// ---------------------------------------------------------------------------
// 1. Collect commits — a function step. Ordinary TypeScript; no LLM involved.
// ---------------------------------------------------------------------------

const commitSchema = Type.Object({
	sha: Type.String(),
	subject: Type.String(),
});

const collectCommitsSchema = Type.Object({
	/** Human-readable description of what we diffed, e.g. `v1.4.0..HEAD`. */
	range: Type.String(),
	commits: Type.Array(commitSchema),
});

const collectCommits = createStep({
	name: "collect-commits",
	description: "List the commits since the most recent tag (or the last 30 if untagged)",
	output: collectCommitsSchema,
	// git can hang on a wedged index or a credential prompt; don't let that eat the run.
	maxDurationMs: 30_000,
	run: async ({ abortSignal, logger }) => {
		const git = async (args: string[]) => {
			const { stdout } = await exec("git", args, { cwd: REPO_ROOT, signal: abortSignal });
			return stdout.trim();
		};

		// `describe --tags --abbrev=0` exits non-zero on a repo with no tags — that is a
		// legitimate state here, not a failure, so fall back to a fixed window.
		let range: string;
		try {
			const lastTag = await git(["describe", "--tags", "--abbrev=0"]);
			range = `${lastTag}..HEAD`;
		} catch {
			range = `HEAD~${FALLBACK_COMMIT_COUNT}..HEAD`;
			logger.warn("no tags found, falling back to a fixed commit window", { range });
		}

		const log = await git(["log", "--no-merges", "--format=%h%x00%s", range]);
		const commits = log
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [sha, subject] = line.split("\0");
				return { sha, subject };
			});

		logger.info("collected commits", { range, count: commits.length });
		return { range, commits };
	},
});

// ---------------------------------------------------------------------------
// 2. Classify — an agent step. `background: true` runs it as an isolated subagent
//    with its own context window, so a long commit list never pollutes the session
//    you are typing in. The output schema is the contract: the reply is parsed as
//    JSON and validated, and an invalid reply is steered back into shape in-session.
// ---------------------------------------------------------------------------

const classifiedSchema = Type.Object({
	summary: Type.String({ description: "One paragraph a user of this tool would care about" }),
	features: Type.Array(Type.String()),
	fixes: Type.Array(Type.String()),
	maintenance: Type.Array(Type.String()),
	breaking: Type.Array(
		Type.Object({
			change: Type.String(),
			sha: Type.String(),
		}),
	),
});

const classifyCommits = createAgentStep({
	name: "classify-commits",
	description: "Group the commits into release-note sections and flag breaking changes",
	input: collectCommitsSchema,
	output: classifiedSchema,
	background: true,
	maxDurationMs: 5 * 60_000,
	retry: { maxRetry: 1, backoffMs: 2_000 },
	prompt: ({ input }) => {
		const list = input.commits.map((c) => `- ${c.sha} ${c.subject}`).join("\n");
		return [
			`Write release notes for the range \`${input.range}\` of this repository.`,
			"",
			"Commits:",
			list,
			"",
			"Group each commit into exactly one of: features, fixes, maintenance. Rewrite subjects as",
			"user-facing statements — drop conventional-commit prefixes, PR numbers, and internal",
			"shorthand. List a change under `breaking` as well (with its sha) only when a user must",
			"change something on upgrade; an internal refactor is not breaking. If a section has no",
			"entries, return an empty array for it rather than inventing filler.",
		].join("\n");
	},
});

// ---------------------------------------------------------------------------
// 3. Branch — one arm, guarded by a pure predicate over the run context. It runs
//    only when step 2 actually found breaking changes, so the migration agent is
//    never paid for on a routine patch release.
// ---------------------------------------------------------------------------

const migrationSchema = Type.Object({
	notes: Type.String({ description: "Markdown body: what breaks and the concrete upgrade action" }),
});

const draftMigration = createAgentStep({
	name: "draft-migration",
	description: "Write the upgrade instructions for the flagged breaking changes",
	output: migrationSchema,
	background: true,
	maxDurationMs: 5 * 60_000,
	prompt: ({ ctx }) => {
		// Bare names resolve lexically outward from this step's scope, so a step inside a branch
		// arm can still read an output produced before the branch.
		const classified = ctx.getStepResult<Static<typeof classifiedSchema>>("classify-commits");
		const breaking = classified?.breaking ?? [];
		return [
			"The following changes in this repository were flagged as breaking:",
			"",
			...breaking.map((b) => `- ${b.sha}: ${b.change}`),
			"",
			"Read the relevant commits with `git show <sha>` and write a short markdown migration",
			"section. For each break, state what stops working and the exact change a user makes to",
			"fix it. No preamble, no headline — the section heading is added by the caller.",
		].join("\n");
	},
});

const migrationArm = createWorkflow({
	name: "migration",
	description: "Only runs when breaking changes were found",
})
	.then(draftMigration)
	.commit();

// ---------------------------------------------------------------------------
// 4. Render and write — a `.map()` gathers the pieces out of the run context, and
//    a function step turns them into a file. The map exists because the node just
//    before this one is the branch, whose output is keyed by the arms that ran;
//    reading what we want from `ctx` is clearer than destructuring that.
// ---------------------------------------------------------------------------

const renderInputSchema = Type.Object({
	range: Type.String(),
	commitCount: Type.Integer(),
	classified: classifiedSchema,
	migration: Type.Optional(Type.String()),
});

const writeNotes = createStep({
	name: "write-notes",
	description: "Render the sections to markdown and write the file",
	input: renderInputSchema,
	output: Type.Object({ path: Type.String(), bytes: Type.Integer() }),
	run: async ({ input, logger }) => {
		const section = (title: string, items: readonly string[]) =>
			items.length > 0 ? [`## ${title}`, "", ...items.map((i) => `- ${i}`), ""] : [];

		const lines = [
			`# Release notes (${input.range})`,
			"",
			input.classified.summary,
			"",
			...section("Features", input.classified.features),
			...section("Fixes", input.classified.fixes),
			...section("Maintenance", input.classified.maintenance),
			...(input.migration ? ["## Breaking changes", "", input.migration, ""] : []),
			`_Generated from ${input.commitCount} commits._`,
			"",
		];

		const body = lines.join("\n");
		await mkdir(dirname(OUTPUT_PATH), { recursive: true });
		await writeFile(OUTPUT_PATH, body, "utf8");
		logger.info("wrote release notes", { path: OUTPUT_PATH });
		return { path: OUTPUT_PATH, bytes: Buffer.byteLength(body) };
	},
});

// ---------------------------------------------------------------------------
// The workflow itself: nodes run top to bottom, each one's output feeding the next.
// ---------------------------------------------------------------------------

const releaseNotesWorkflow = createWorkflow({
	name: "release-notes",
	description: "Draft release notes for the commits since the last tag",
})
	.then(collectCommits)
	.then(classifyCommits)
	.branch([[(ctx) => (ctx.getStepResult<Static<typeof classifiedSchema>>("classify-commits")?.breaking.length ?? 0) > 0, migrationArm]])
	.map((ctx) => {
		const collected = ctx.getStepResult<Static<typeof collectCommitsSchema>>("collect-commits");
		const classified = ctx.getStepResult<Static<typeof classifiedSchema>>("classify-commits");
		// Explicit node path, not a bare name: `draft-migration` lives inside the branch arm's own
		// scope, and a bare name only resolves OUTWARD from the caller's scope toward the root — so
		// from here, at the root, the bare name would silently read `undefined`.
		const migration = ctx.getStepResult<Static<typeof migrationSchema>>("migration/draft-migration");
		return {
			range: collected?.range ?? "unknown",
			commitCount: collected?.commits.length ?? 0,
			classified,
			// Undefined when the branch arm did not run — a structural fact, and the reason
			// `migration` is optional in the schema above.
			migration: migration?.notes,
		};
	})
	.then(writeNotes)
	.commit();

export default releaseNotesWorkflow;
