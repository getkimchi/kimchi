const WORK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** UUID identity shared by local work records and saved plan metadata. */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && WORK_ID_PATTERN.test(value)
}
