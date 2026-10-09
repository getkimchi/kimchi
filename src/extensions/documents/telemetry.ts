/**
 * Document-tool telemetry: metadata only, never content.
 * Fields: format, size range, unit count, duration, error type, surface.
 * The sink is injected by index.ts at registration time so tests capture
 * events and assert no fixture text leaks into them.
 */

import type { DocumentFormat } from "./model.js"

export interface DocumentTelemetryEvent {
	tool: "read_document" | "read" | "at-file" | "doctor"
	format?: DocumentFormat
	/** bucketed: never an exact size (content-adjacent fingerprint). */
	sizeRange?: "lt1mb" | "1-5mb" | "5-20mb" | "gt20mb"
	units?: number
	durationMs?: number
	errorType?: string
}

export type DocumentTelemetrySink = (event: DocumentTelemetryEvent) => void

let sink: DocumentTelemetrySink = () => {}

export function setDocumentTelemetrySink(next: DocumentTelemetrySink): void {
	sink = next
}

export function emitDocumentEvent(event: DocumentTelemetryEvent): void {
	try {
		sink(event)
	} catch {
		// Telemetry must never break a read.
	}
}

export function sizeRangeOf(bytes: number): DocumentTelemetryEvent["sizeRange"] {
	if (bytes < 1024 * 1024) return "lt1mb"
	if (bytes < 5 * 1024 * 1024) return "1-5mb"
	if (bytes <= 20 * 1024 * 1024) return "5-20mb"
	return "gt20mb"
}
