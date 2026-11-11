/**
 * Batch workflow host: `kimchi workflow run <name> […]` runs one workflow to its
 * terminal state without a chat session; the run's status is the process exit code
 * (0 completed, 2 blocked, 3 cancelled, 4 crashed/never-started). Routed by cli.ts
 * before telemetry/session setup and exiting at the dispatch site, exactly like the
 * in-process workers beside it — a CI invocation must stay invisible to app_started
 * instrumentation. The command belongs to the same bundled package that already ships
 * the in-session /workflow extension, so dispatching on the bundled copy needs no
 * install surface beyond the pinned dependency.
 */

type WorkflowCliMain = (args: string[]) => Promise<number>

interface WorkflowBatchDeps {
	/** Test seam: replace the package import with a fake main. */
	main?: WorkflowCliMain
}

export async function runWorkflowBatch(args: string[], deps: WorkflowBatchDeps = {}): Promise<number> {
	let main: WorkflowCliMain
	try {
		main =
			deps.main ??
			(
				(await import("@kimchi-dev/kimchi-workflows/cli").catch((error: unknown) => {
					// Import failure gets the version hint: it means the pinned dependency predates
					// the "./cli" headless host — actionable for whoever forgot the bump.
					throw new Error(
						`kimchi workflow needs @kimchi-dev/kimchi-workflows with the "./cli" headless host (ships in 0.0.11 — bump the pinned dependency): ${describeFailure(error)}`,
						{ cause: error },
					)
				})) as { main: WorkflowCliMain }
			).main
	} catch (error) {
		process.stderr.write(`workflow: ${describeFailure(error)}\n`)
		return 4
	}

	try {
		const code = await main(args)
		// The contract is an integer exit code, but a scheduler-facing exit path never
		// trusts an external sub-CLI blindly: a non-integer resolution is a crashed run.
		return typeof code === "number" && Number.isInteger(code) ? code : 4
	} catch (error) {
		// Batch contract: an unexpected host failure is a crashed run (4), reported as
		// one clean stderr line — scheduler logs must not carry a raw node stack trace.
		process.stderr.write(`workflow: ${describeFailure(error)}\n`)
		return 4
	}
}

function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
