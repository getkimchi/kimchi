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

/**
 * One guarded stderr write. A scheduler piping stderr through `head` truncates the
 * pipe mid-write; an unguarded write would then surface as an uncaught EPIPE and
 * exit 1 with a stack trace, breaking both halves of this route's contract (one
 * clean line, exit-code-is-the-report). The 'error' listener must live on the
 * stream itself — Node does not throw synchronously for EPIPE, it emits 'error',
 * and an unhandled 'error' on stderr crashes the process the same way. Install-once
 * rather than once-per-write: concurrent buffered writes race a per-write `once`
 * handler, and this route exits the process at the dispatch site, so nothing
 * long-lived inherits the no-op.
 */
let stderrGuardInstalled = false
export function writeWorkflowStderr(text: string): void {
	if (!stderrGuardInstalled) {
		stderrGuardInstalled = true
		process.stderr.on("error", () => {})
	}
	try {
		process.stderr.write(text)
	} catch {
		// A consumer already gone must never outrank the exit-code contract.
	}
}

export async function runWorkflowBatch(args: string[], deps: WorkflowBatchDeps = {}): Promise<number> {
	let main: WorkflowCliMain
	try {
		main =
			deps.main ??
			// "./cli" ships its own declarations, so the imported main infers directly — no cast.
			(
				await import("@kimchi-dev/kimchi-workflows/cli").catch((error: unknown) => {
					// The stable user line stays free of packaging internals (Node's error
					// text embeds the module subpath and a local absolute path); the raw
					// chain survives on the dev-oriented detail line below.
					throw new Error("workflow host unavailable", { cause: error })
				})
			).main
	} catch (error) {
		reportCrash(error)
		return 4
	}

	try {
		const code = await main(args)
		// The contract is an OS exit code, but a scheduler-facing exit path never
		// trusts an external sub-CLI blindly: anything outside 0..255 would be
		// range-masked by the kernel (300 → 44, -1 → 255), reporting a status the
		// workflow never produced — a broken contract is a crashed run.
		return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 4
	} catch (error) {
		reportCrash(error)
		return 4
	}
}

/** First line: stable, user-facing. Second line: the raw cause chain, for devs. */
function reportCrash(error: unknown): void {
	const detail = describeCauseChain(error)
	// One write: a truncation/interleave must never orphan the detail line from its headline.
	writeWorkflowStderr(`workflow: ${describeFailure(error)}\n` + (detail ? `  detail: ${detail}\n` : ""))
}

function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Message chain of `cause` links, none of which belongs on the user line. */
function describeCauseChain(error: unknown): string | undefined {
	if (!(error instanceof Error) || error.cause === undefined) return undefined
	const parts: string[] = []
	for (let current: unknown = error.cause; current !== undefined; ) {
		const message = current instanceof Error ? current.message : String(current)
		parts.push(message)
		current = current instanceof Error ? current.cause : undefined
	}
	return parts.join(" <- ")
}
