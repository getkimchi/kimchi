/**
 * Minimal type declarations for the bun:sqlite-backed better-sqlite3 shim.
 * Only the surface mem0ai (and our own code) actually calls is declared —
 * see index.js for the rationale and removal criteria.
 */

export interface RunResult {
	changes: number
	lastInsertRowid: number | bigint
}

export interface Statement {
	run(...params: unknown[]): RunResult
	/** Returns undefined when no row matches (better-sqlite3 semantics). */
	get(...params: unknown[]): unknown
	all(...params: unknown[]): unknown[]
}

export declare class Database {
	constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean })
	prepare(sql: string): Statement
	exec(sql: string): void
	transaction<F extends (...args: never[]) => unknown>(fn: F): F
	close(): void
}

export default Database
