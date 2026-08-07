/**
 * Test-side helpers for reading back what the OTLP transport POSTed.
 *
 * Parsed with the transport's own {@link LogRecord}, so the production wire format is the test
 * type — shared by every test file in this folder rather than inlined per file.
 */
import type { LogRecord } from "./transport.js"

/** One POSTed log record: event name plus flattened string attributes. */
export interface RecordedEvent {
	eventName: string
	attrs: Record<string, string>
}

function attrText(value: LogRecord["attributes"][number]["value"]): string {
	if ("stringValue" in value) return value.stringValue
	if ("intValue" in value) return value.intValue
	return String(value.doubleValue)
}

/** Every log record POSTed to the logs endpoint by the given fetch mock, in send order. */
export function logEvents(fetchMock: { mock: { calls: unknown[][] } }): RecordedEvent[] {
	return fetchMock.mock.calls
		.filter(([url]) => String(url).includes("/logs"))
		.flatMap(([, init]) => {
			const body = JSON.parse(String((init as { body?: unknown })?.body)) as {
				resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }>
			}
			return (body.resourceLogs ?? [])
				.flatMap((resource) => resource.scopeLogs ?? [])
				.flatMap((scope) => scope.logRecords ?? [])
				.map((record) => ({
					eventName: record.eventName,
					attrs: Object.fromEntries(record.attributes.map((a) => [a.key, attrText(a.value)])),
				}))
		})
}
