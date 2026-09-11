import type { SessionFermentV2 } from "../ferment-v2/types.js"

export type TelemetryFermentV2Context = Pick<SessionFermentV2, "id" | "revision" | "status">

let activeFermentV2: TelemetryFermentV2Context | undefined

export function setTelemetryFermentV2Context(next: TelemetryFermentV2Context | undefined): void {
	activeFermentV2 = next
}

export function getTelemetryFermentV2Context(): TelemetryFermentV2Context | undefined {
	return activeFermentV2
}

export function resetTelemetryFermentV2Context(): void {
	activeFermentV2 = undefined
}
