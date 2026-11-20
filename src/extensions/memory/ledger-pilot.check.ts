import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createSqliteCaptureJobStore } from "./capture-jobs-sqlite.js"
import { runBatchedSupersede } from "./capture-worker.js"
import { type CaptureBackend, CapturedHashLedger, loadCapturedHashes } from "./commit.js"
import {
	completeDeferredSupersedePrefix,
	deferSupersede,
	readDeferredSupersede,
	readDeferredSupersedeBatch,
} from "./decision-outage.js"

const resultsRoot = resolve(process.cwd(), ".kimchi/docs/memory-review")
const source = join(resultsRoot, "pilot-captured-hashes.json")
const rawHashes: unknown = JSON.parse(readFileSync(source, "utf-8"))
if (!Array.isArray(rawHashes) || rawHashes.length === 0 || !rawHashes.every((value) => typeof value === "string")) {
	throw new Error("pilot ledger must be a non-empty array of hash strings")
}
const sourceBytes = statSync(source).size
const sourceHashCount = new Set(rawHashes).size

function prepare(mode: "legacy" | "incremental") {
	process.env.HOME = resultsRoot
	process.env.XDG_CONFIG_HOME = join(resultsRoot, ".config")
	process.env.KIMCHI_CODING_AGENT_DIR = join(resultsRoot, "agent-config")
	const root = join(resultsRoot, `pilot-${mode}-${Date.now()}`.toString())
	mkdirSync(root, { recursive: true })
	copyFileSync(source, join(root, "captured-hashes.json"))
	if (mode === "incremental") process.env.KIMCHI_MEMORY_SQLITE_LEDGER = "1"
	else delete process.env.KIMCHI_MEMORY_SQLITE_LEDGER
	process.env.KIMCHI_API_KEY = "local-fixture"
	const store = createSqliteCaptureJobStore(root).store
	const ledger = new CapturedHashLedger(
		loadCapturedHashes(root),
		undefined,
		mode === "incremental" ? store : undefined,
		root,
	)
	return { root, store, ledger }
}

function runLedger(mode: "legacy" | "incremental") {
	const { root, store, ledger } = prepare(mode)
	const initialHashes = loadCapturedHashes(root)
	if (initialHashes.size !== sourceHashCount) {
		throw new Error(`${mode}: invalid initial hash count: ${initialHashes.size}/${sourceHashCount}`)
	}
	const startedAt = performance.now()
	for (let index = 0; index < 24; index++) {
		ledger.mark([createHash("sha1").update(`pilot-observation-${index}`).digest("hex")])
		ledger.save()
		if (index === 0 && loadCapturedHashes(root).size !== sourceHashCount + 1) {
			throw new Error(`${mode}: invalid first checkpoint count`)
		}
	}
	ledger.exportSnapshot()
	const elapsedMs = Math.round(performance.now() - startedAt)
	const snapshotFile = join(root, "captured-hashes.json")
	if (!existsSync(snapshotFile)) throw new Error(`${mode}: no compatibility snapshot`)
	const snapshot: unknown = JSON.parse(readFileSync(snapshotFile, "utf-8"))
	if (!Array.isArray(snapshot) || !snapshot.every((value) => typeof value === "string")) {
		throw new Error(`${mode}: invalid compatibility JSON`)
	}
	const unique = new Set(snapshot)
	if (snapshot.length !== unique.size) throw new Error(`${mode}: duplicate compatibility rows`)
	const canonicalSha256 = createHash("sha256")
		.update(JSON.stringify([...unique].sort()))
		.digest("hex")
	store.close()
	return { root, elapsedMs, count: snapshot.length, bytes: statSync(snapshotFile).size, canonicalSha256 }
}

async function runPrefix(size: number) {
	const root = join(resultsRoot, `pilot-prefix-${size}-${Date.now()}`)
	process.env.KIMCHI_MEMORY_DEFERRED_BATCH_SIZE = String(size)
	deferSupersede(
		"personal",
		Array.from({ length: 64 }, (_, index) => `deferral-${index}`),
		root,
	)
	const batch = readDeferredSupersedeBatch("personal", root)
	let searchQueue = Promise.resolve()
	const backend: CaptureBackend = {
		add: async () => undefined,
		delete: async () => undefined,
		getAll: async () => ({ results: [] }),
		search: async () => {
			searchQueue = searchQueue.then(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
			await searchQueue
			return { results: [] }
		},
	}
	const startedAt = performance.now()
	const completed = await runBatchedSupersede(backend, batch.facts, async () => [], {
		trace: null,
		store: "personal",
		root,
		timeoutMs: 60,
	})
	const beforeCommit = readDeferredSupersede("personal", root)
	if (completed) completeDeferredSupersedePrefix("personal", batch.facts.length, root)
	const record = readDeferredSupersede("personal", root)
	return {
		requestedChunk: size,
		attempted: batch.facts.length,
		preCommitPrefix: beforeCommit.completedPrefix,
		preCommitRemaining: beforeCommit.newFacts.length - beforeCommit.completedPrefix,
		completed,
		completedPrefix: record.completedPrefix,
		retained: record.newFacts.length,
		remaining: record.newFacts.length - record.completedPrefix,
		durationMs: Math.round(performance.now() - startedAt),
	}
}

const prefixOnly = process.argv.includes("--prefix-only")
const previous: {
	legacy: ReturnType<typeof runLedger>
	incremental: ReturnType<typeof runLedger>
} | null = prefixOnly ? JSON.parse(readFileSync(join(resultsRoot, "ledger-pilot-results.json"), "utf-8")) : null
const legacy = previous?.legacy ?? runLedger("legacy")
const incremental = previous?.incremental ?? runLedger("incremental")
if (legacy.canonicalSha256 !== incremental.canonicalSha256) {
	throw new Error(
		`control and incremental hashes differ: ${legacy.count}/${incremental.count}, ${legacy.bytes}/${incremental.bytes}`,
	)
}
const controlPrefix = await runPrefix(64)
const pilotPrefix = await runPrefix(16)
if (
	controlPrefix.completed ||
	!pilotPrefix.completed ||
	controlPrefix.completedPrefix !== 0 ||
	pilotPrefix.completedPrefix !== 16 ||
	pilotPrefix.remaining !== 48
) {
	throw new Error(`prefix pilot did not retain progress: ${JSON.stringify({ controlPrefix, pilotPrefix })}`)
}
writeFileSync(
	join(resultsRoot, "ledger-pilot-results.json"),
	`${JSON.stringify(
		{
			input: {
				path: source,
				sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
				bytes: sourceBytes,
			},
			jobsPerWave: 24,
			legacy,
			incremental,
			prefix: { control: controlPrefix, pilot: pilotPrefix },
			note: "Only isolated store/checkpoint latency and semantic prefix outcome are compared; no real gateway, factual truth, or production speed is implied.",
		},
		null,
		2,
	)}\n`,
)
console.log(JSON.stringify({ legacy, incremental, controlPrefix, pilotPrefix }, null, 2))
