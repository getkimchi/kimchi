// better-sqlite3 compatibility shim over Bun's built-in bun:sqlite.
//
// Why this exists: mem0ai requires better-sqlite3 for its SQLite vector
// store (hybrid BM25 + entity + semantic retrieval) and its history
// manager, but the native addon does not load under the Bun runtime
// (oven-sh/bun#4290). The kimchi binary is Bun-compiled and `bun run` is
// the dev runtime, so bun:sqlite is always present where this shim
// actually executes.
//
// Upstream tracking: oven-sh/bun#36712 ships a built-in equivalent of
// this shim. Removal criteria: when the minimum Bun version in
// package.json engines includes #36712, delete this package and the
// pnpm.overrides entry in the root package.json.
//
// The module itself must stay requireable under Node (vitest loads source
// that transitively imports mem0ai), so the driver is resolved lazily on
// first Database construction, not at module load.
//
// API surface implemented: constructor, exec, prepare -> {run, get, all},
// transaction, close. This is exactly what mem0ai 3.1.8 calls — verified
// by grepping its bundle: no .pragma(), no .immediate()/.deferred()/
// .exclusive() transaction variants, no named parameters, no .iterate().

/** @type {any} */
let BunDatabase = null

function driver() {
	if (BunDatabase) return BunDatabase
	try {
		BunDatabase = require("bun:sqlite").Database
	} catch (err) {
		throw new Error(
			"better-sqlite3 shim requires the Bun runtime (bun:sqlite). " +
				"The compiled kimchi binary and `bun run` both provide it; vitest on Node cannot construct databases.",
			{ cause: err },
		)
	}
	return BunDatabase
}

class Statement {
	constructor(stmt) {
		this.stmt = stmt
	}
	run(...params) {
		return this.stmt.run(...params)
	}
	// better-sqlite3 returns undefined for "no row"; bun:sqlite returns null.
	get(...params) {
		return this.stmt.get(...params) ?? undefined
	}
	all(...params) {
		return this.stmt.all(...params)
	}
}

class Database {
	constructor(path, options) {
		this.db = new (driver())(path, options)
		// Concurrency: concurrent kimchi sessions share this store. WAL lets
		// readers proceed during writes; busy_timeout makes writers wait
		// (5000ms, the repo's cursor.ts precedent) instead of failing fast
		// with SQLITE_BUSY. WAL is a no-op for :memory: databases; readonly
		// connections cannot change the journal mode, so skip it for them.
		if (!options?.readonly) {
			this.db.exec("PRAGMA journal_mode=WAL")
		}
		this.db.exec("PRAGMA busy_timeout=5000")
	}
	prepare(sql) {
		return new Statement(this.db.prepare(sql))
	}
	exec(sql) {
		this.db.exec(sql)
	}
	transaction(fn) {
		return this.db.transaction(fn)
	}
	close() {
		this.db.close()
	}
}

module.exports = Database
module.exports.Database = Database
