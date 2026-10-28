/**
 * Minimal ambient typings for `bun:sqlite`, used at runtime in the
 * Bun-compiled binary (cursor.ts, the PR-cost ledger). Pulling all of
 * `@types/bun` would shadow Node types in this mostly-Node codebase,
 * so we declare just the surface we touch. Runtime loading is lazy —
 * Node/vitest can import modules that reference these types.
 */
declare module "bun:sqlite" {
	export class Statement<R = unknown, P extends unknown[] = unknown[]> {
		get(...params: P): R | null
		all(...params: P): R[]
		iterate(...params: P): IterableIterator<R>
		run(...params: P): { changes: number; lastInsertRowid: number | bigint }
	}

	export class Database {
		constructor(filename: string, options?: { readonly?: boolean; create?: boolean; strict?: boolean })
		exec(sql: string): void
		run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint }
		query<R = unknown, P extends unknown[] = unknown[]>(sql: string): Statement<R, P>
		transaction<F extends (...args: unknown[]) => unknown>(
			fn: F,
		): F & {
			deferred: F
			immediate: F
			exclusive: F
		}
		close(): void
	}
}
