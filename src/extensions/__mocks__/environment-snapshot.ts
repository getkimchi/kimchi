/**
 * Shared mock module shape for
 * `vi.mock(".../prompt-construction/environment-snapshot.js")` factories.
 *
 * Tests declare their control fns via `vi.hoisted` and build the module mock
 * inside the factory, e.g.:
 *
 * ```ts
 * const snapshotMocks = vi.hoisted(() => ({
 * 	get: vi.fn(),
 * 	prime: vi.fn(),
 * 	restore: vi.fn(),
 * 	clearContext: vi.fn(),
 * }))
 * vi.mock("../prompt-construction/environment-snapshot.js", async (importOriginal) => {
 * 	const actual = await importOriginal<typeof import("../prompt-construction/environment-snapshot.js")>()
 * 	const { environmentSnapshotModuleMock } = await import("../__mocks__/environment-snapshot.js")
 * 	return environmentSnapshotModuleMock(snapshotMocks, actual)
 * })
 * ```
 *
 * The prepare/resolve wrappers mirror production's best-effort restore,
 * prime, and persistence semantics so every prompt path exercises the same
 * contract. Real formatting helpers from `actual` are kept so prompt
 * assertions run against production snapshot assembly.
 */
import type { Mock } from "vitest"
import type {
	EnvironmentSnapshotRequest,
	findPersistedEnvironmentSnapshot as findPersistedReal,
	withEnvironmentSnapshot as withSnapshotReal,
} from "../prompt-construction/environment-snapshot.js"

export interface EnvironmentSnapshotMockControls {
	get: Mock
	prime: Mock
	restore: Mock
	clearContext: Mock
	/**
	 * When provided, replaces the real persisted-entry lookup (for tests that
	 * script arbitrary resume state). Defaults to the real implementation.
	 */
	findPersistedEnvironmentSnapshot?: Mock
}

interface EnvironmentSnapshotActual {
	ENVIRONMENT_SNAPSHOT_SESSION_ENTRY: string
	findPersistedEnvironmentSnapshot: typeof findPersistedReal
	withEnvironmentSnapshot: typeof withSnapshotReal
	findEnvironmentSnapshotInPrompt: (prompt: string) => string | undefined
}

export function environmentSnapshotModuleMock(
	controls: EnvironmentSnapshotMockControls,
	actual: EnvironmentSnapshotActual,
): Record<string, unknown> {
	const findPersisted = controls.findPersistedEnvironmentSnapshot ?? actual.findPersistedEnvironmentSnapshot
	return {
		...actual,
		findPersistedEnvironmentSnapshot: findPersisted,
		environmentSnapshotService: {
			get: controls.get,
			prime: controls.prime,
			restore: controls.restore,
			clearContext: controls.clearContext,
		},
		prepareEnvironmentSnapshot: (request: EnvironmentSnapshotRequest, readEntries: () => readonly unknown[]) => {
			const persisted = findPersisted(readEntries(), request.cwd)
			if (persisted) controls.restore(request, persisted)
			else controls.prime(request)
			return persisted
		},
		resolveEnvironmentSnapshot: async (
			request: EnvironmentSnapshotRequest,
			persisted: string | undefined,
			persist?: (snapshot: string) => void,
		) => {
			let snapshot: string | undefined
			try {
				snapshot = await controls.get(request)
			} catch {
				return undefined
			}
			if (snapshot && !persisted) {
				try {
					persist?.(snapshot)
				} catch {
					// Mirrors best-effort production persistence.
				}
			}
			return snapshot
		},
	}
}
