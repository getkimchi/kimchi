/** Race one operation against a timer and always clear the losing timer.
 * onTimeout is useful for propagating cancellation; it does not replace the
 * operation's own settlement handling. */
export async function raceWithTimeout<T, TTimeout>(
	operation: Promise<T>,
	milliseconds: number,
	timeoutValue: TTimeout,
	onTimeout?: () => void,
): Promise<T | TTimeout> {
	if (!Number.isFinite(milliseconds)) return operation
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<TTimeout>((resolve) => {
		timer = setTimeout(
			() => {
				onTimeout?.()
				resolve(timeoutValue)
			},
			Math.max(0, milliseconds),
		)
	})
	try {
		return await Promise.race([operation, deadline])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
