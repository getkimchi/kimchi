import { isResourceEnabled } from "../../resources/store.js"

/** The /resources id for legacy Ferment (V1). Opt-in; the primary Ferment id belongs to V2. */
export const FERMENT_LEGACY_RESOURCE_ID = "extensions.ferment-legacy"

/** Legacy entry points call this so V1 stays inert unless the user opted in. */
export function isFermentLegacyEnabled(): boolean {
	return isResourceEnabled(FERMENT_LEGACY_RESOURCE_ID)
}
