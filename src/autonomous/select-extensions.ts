import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent"

export type { ExtensionFactory }

export interface AutonomousExtensions {
	resultWriter: (pi: ExtensionAPI) => void
	timeoutGuard?: (pi: ExtensionAPI) => void
	maxIterations?: (pi: ExtensionAPI) => void
}

export function selectExtensionFactories(
	base: ExtensionFactory[],
	options: { autonomous: false } | { autonomous: true; autonomousExtensions: AutonomousExtensions },
): ExtensionFactory[] {
	if (!options.autonomous) {
		return [...base]
	}
	const { resultWriter, timeoutGuard, maxIterations } = options.autonomousExtensions
	const extras: ExtensionFactory[] = [resultWriter]
	if (timeoutGuard) extras.push(timeoutGuard)
	if (maxIterations) extras.push(maxIterations)
	return [...base, ...extras]
}
