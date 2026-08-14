import {
	applyInfrastructureExitPolicy,
	type InfrastructureFailure,
	KIMCHI_INFRA_ERROR_EXIT_CODE,
} from "./infrastructure-error.js"

type ExitProcess = (code?: typeof process.exitCode) => void

/**
 * CLI post-main exit handling for failed runs. Infrastructure failures force an
 * immediate exit because failed provider streams can leave handles alive after
 * pi's main() returns.
 */
export function applyPostMainInfrastructureExitPolicy(
	failure: InfrastructureFailure | undefined,
	exitProcess: ExitProcess = process.exit,
): boolean {
	if (!process.exitCode) return false
	if (!applyInfrastructureExitPolicy(failure)) return false
	exitProcess(process.exitCode ?? KIMCHI_INFRA_ERROR_EXIT_CODE)
	return true
}
