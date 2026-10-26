import { randomUUID } from "node:crypto"
import { mkdir, open, stat } from "node:fs/promises"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { writeFileDurably } from "../../config/json.js"
import { isWorkId } from "../../shared/work-id.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { object, SHA256_HEX } from "../work-attribution/summary.js"
import { backendFor } from "./ledger/records.js"
import { machineFingerprint } from "./machine.js"

/** The state file's size limit; older versions kept their pending snapshots in it. */
const MAX_STATE_BYTES = 24 * 1024 * 1024

export interface ReportingState {
	version: 1
	enabled: boolean
	/** New state follows SaaS uploads until an explicit /pr-reporting choice is saved. */
	followsTelemetry?: true
	defaultNoticeShown?: true
	producerId: string
	/** The original producer's machine; the event producer rotates when the hardware changes. */
	machine?: string
	/** Pending snapshots of older versions. Kept on disk and never read; older versions require the field. */
	entries?: Record<string, unknown>
	error?: string
}

export function reportingDirectory(agentDir: string): string {
	return join(agentDir, "pr-cost-reporting")
}

export function reportingStatePath(agentDir: string): string {
	return join(reportingDirectory(agentDir), "state.json")
}

function empty(): ReportingState {
	return {
		version: 1,
		enabled: isTelemetryEnabled(),
		followsTelemetry: true,
		producerId: randomUUID(),
		entries: {},
	}
}

export async function readReportingState(agentDir: string): Promise<ReportingState> {
	return (await loadReportingState(agentDir)).state
}

/** The new reporting producer rotates independently of the identity saved in the state file. */
export async function reportingProducer(agentDir: string, assertCurrent: () => void): Promise<string> {
	assertCurrent()
	const machine = await machineFingerprint()
	assertCurrent()
	const backend = backendFor(agentDir)
	const legacy =
		backend.getNote("agent", "reporting-producer") === undefined ? await readReportingState(agentDir) : undefined
	return backend.tx(() => {
		assertCurrent()
		const previous = backend.getNote("agent", "reporting-producer")
		if (previous === undefined && !legacy) throw new Error("PR reporting producer disappeared")
		const value: unknown =
			previous === undefined
				? { version: 1, producerId: legacy?.producerId, machine: legacy?.machine }
				: JSON.parse(previous)
		if (
			!object(value) ||
			value.version !== 1 ||
			!isWorkId(value.producerId) ||
			(value.machine !== undefined && (typeof value.machine !== "string" || !SHA256_HEX.test(value.machine)))
		)
			throw new Error("Invalid PR reporting producer")
		const next = { version: 1, producerId: value.producerId, machine: value.machine }
		if (machine) {
			if (next.machine && next.machine !== machine) next.producerId = randomUUID()
			next.machine = machine
		}
		const body = JSON.stringify(next)
		if (body !== previous) backend.putNote("agent", "reporting-producer", body)
		assertCurrent()
		return next.producerId
	})
}

/** Changes with every saved update, since each one replaces the file; empty before the first. */
export async function reportingStateVersion(agentDir: string): Promise<string> {
	const saved = await stat(reportingStatePath(agentDir)).catch(() => undefined)
	return saved ? JSON.stringify([saved.ino, saved.size, saved.mtimeMs]) : ""
}

/** The validated state and, when the file exists, its text, so an unchanged update can skip the write. */
async function loadReportingState(agentDir: string): Promise<{ state: ReportingState; text?: string }> {
	try {
		const file = await open(reportingStatePath(agentDir), "r")
		let value: ReportingState
		let text: string
		try {
			if ((await file.stat()).size > MAX_STATE_BYTES) throw new Error("PR reporting state exceeds its local size limit")
			text = await file.readFile("utf8")
			value = JSON.parse(text)
		} finally {
			await file.close()
		}
		if (
			value?.version !== 1 ||
			typeof value.enabled !== "boolean" ||
			(value.followsTelemetry !== undefined && value.followsTelemetry !== true) ||
			(value.defaultNoticeShown !== undefined && value.defaultNoticeShown !== true) ||
			!isWorkId(value.producerId) ||
			(value.machine !== undefined && !SHA256_HEX.test(value.machine))
		)
			throw new Error("Invalid PR reporting state")
		if (value.followsTelemetry) value.enabled = isTelemetryEnabled()
		return { state: value, text }
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return { state: empty() }
		throw new Error("PR reporting state is unreadable; queued reports were not replaced", { cause: error })
	}
}

async function update(
	agentDir: string,
	mutate: (state: ReportingState) => void,
	assertCurrent: () => void = () => {},
): Promise<ReportingState> {
	const directory = reportingDirectory(agentDir)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	let compromised: Error | undefined
	const release = await lock(directory, {
		retries: { retries: 20, minTimeout: 10, maxTimeout: 50 },
		stale: 5000,
		update: 1000,
		onCompromised: (error) => {
			compromised = error
		},
	})
	const check = () => {
		if (compromised) throw compromised
		assertCurrent()
	}
	try {
		const { state, text } = await loadReportingState(agentDir)
		const before = JSON.stringify(state)
		check()
		mutate(state)
		check()
		if (text === undefined && JSON.stringify(state) === before) return state
		state.machine ??= await machineFingerprint()
		check()
		const body = `${JSON.stringify(state)}\n`
		// Passes run every 30 seconds; unchanged state is not rewritten or synced.
		if (body === text) return state
		if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("PR reporting state exceeds its local size limit")
		await writeFileDurably(reportingStatePath(agentDir), body, check)

		const parent = await open(directory, "r")
		try {
			await parent.sync()
		} finally {
			await parent.close()
		}
		return state
	} finally {
		if (!compromised) await release()
	}
}

/** An explicit choice also restarts delivery: queued event batches retry at once. */
export function setReportingEnabled(agentDir: string, enabled: boolean): Promise<ReportingState> {
	return update(agentDir, (state) => {
		state.enabled = enabled
		state.followsTelemetry = undefined
		state.error = undefined
		// The note keeps its original name, so retry notes saved by earlier versions still compare against it.
		if (enabled) backendFor(agentDir).putNote("agent", "legacy-snapshot-resume", randomUUID())
	})
}

/** Claim the installation notice under the state lock so concurrent sessions show it once. */
export async function takeReportingNotice(agentDir: string): Promise<boolean> {
	let show = false
	await update(agentDir, (state) => {
		if (state.enabled && state.followsTelemetry && !state.defaultNoticeShown) {
			state.defaultNoticeShown = true
			show = true
		}
	})
	return show
}

export function recordReportingError(agentDir: string, error: string | undefined): Promise<ReportingState> {
	return update(agentDir, (state) => {
		if (state.enabled) state.error = error
	})
}

/**
 * Rereads consent before an event batch is frozen, sent or acknowledged. The action runs under the state lock, so
 * turning reporting off cannot interleave with it; its check also fails once SaaS uploads that this state follows are
 * turned off.
 */
export async function withReportingConsent(
	agentDir: string,
	action: (check: () => void) => void,
	assertCurrent: () => void,
): Promise<boolean> {
	let ready = false
	await update(
		agentDir,
		(state) => {
			if (!state.enabled) return
			const consent = () => {
				assertCurrent()
				if (state.followsTelemetry && !isTelemetryEnabled()) throw new Error("PR reporting is disabled")
			}
			action(consent)
			consent()
			ready = true
		},
		assertCurrent,
	)
	return ready
}
