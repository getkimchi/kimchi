/**
 * SQLite DDL and store constants for the PR-cost ledger. Pure data — importable from
 * any runtime (Node/vitest included); nothing here opens a database.
 *
 * The ledger is the authority for captured work records, the derived summary
 * projection and the durable delta outbox. Schema changes are additive and advance
 * SCHEMA_VERSION; a foreign user_version refuses to open (store.ts) so a newer
 * build never silently writes a schema an older build cannot read, and vice versa.
 *
 * Provenance/ownership conventions:
 * - `work_records` rows are immutable facts. Import anomalies (journal replaced,
 *   shrunk, removed) never delete them; a new import generation adds the new view
 *   alongside. Dedup is by `record_hash` of the exact journal line, so a re-import
 *   after a file mutation is idempotent and byte-identical lines are not duplicated.
 * - `pending_translation` is the transactional intent linking an authority record
 *   to its delta event(s): the capture/import commit inserts the marker and the
 *   delta-generation commit deletes it when the event lands in `outbox_events`,
 *   so a crash between the two never loses the intent.
 */
export const SCHEMA_VERSION = 1

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_cursor (
	path TEXT PRIMARY KEY,
	dev INTEGER NOT NULL,
	ino INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	offset INTEGER NOT NULL,
	boundary_hash TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_records (
	record_hash TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	work_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	body TEXT NOT NULL,
	source_path TEXT NOT NULL,
	source_generation INTEGER NOT NULL,
	-- Nullable: native captures have no journal offset; imported rows always carry one.
	source_offset INTEGER,
	imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_records_work ON work_records(work_id);
CREATE INDEX IF NOT EXISTS work_records_session ON work_records(session_id);
CREATE INDEX IF NOT EXISTS work_records_type ON work_records(type);
CREATE TABLE IF NOT EXISTS pending_translation (
	record_hash TEXT PRIMARY KEY,
	work_id TEXT NOT NULL,
	type TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_projection_head (
	work_id TEXT PRIMARY KEY,
	body TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_projection_rows (
	work_id TEXT NOT NULL,
	log TEXT NOT NULL,
	key TEXT NOT NULL,
	pos INTEGER NOT NULL,
	body TEXT NOT NULL,
	PRIMARY KEY (work_id, log, key)
);
CREATE TABLE IF NOT EXISTS outbox_events (
	id TEXT PRIMARY KEY,
	account_key TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	body BLOB NOT NULL,
	hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	acked_at INTEGER,
	blocked TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox_events(account_key, acked_at, created_at);
CREATE INDEX IF NOT EXISTS outbox_entity ON outbox_events(entity_id);
CREATE TABLE IF NOT EXISTS outbox_batches (
	id TEXT PRIMARY KEY,
	account_key TEXT NOT NULL,
	body BLOB NOT NULL,
	event_ids BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	order_key TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS delivery_state (
	account_key TEXT PRIMARY KEY,
	retry_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL,
	last_error TEXT,
	batch_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
	code TEXT PRIMARY KEY,
	count INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookkeeping (
	work_id TEXT NOT NULL,
	name TEXT NOT NULL,
	body TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (work_id, name)
);
CREATE TABLE IF NOT EXISTS work_dirty (
	work_id TEXT PRIMARY KEY
);
`

/** Meta key. */
export const META_PROJECTION_VERSION = "projectionVersion"
/** Current derived-projection format; bump when the projection layout changes (forces rebuild). */
export const PROJECTION_VERSION = 1
