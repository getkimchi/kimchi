interface Waiter {
	resolve: (release: () => void) => void
	reject: (reason: unknown) => void
	detach: () => void
}

interface CommandGroup {
	active: boolean
	waiters: Waiter[]
}

const groups = new Map<string, CommandGroup>()

/** One process-owned FIFO execution slot per panel. Reviewers run in-process;
 * file reads are not gated, but every spawned build/test/Bash command uses this. */
export async function acquireHeadlessCommandSlot(groupKey: string, signal?: AbortSignal): Promise<() => void> {
	signal?.throwIfAborted()
	let group = groups.get(groupKey)
	if (!group) {
		group = { active: false, waiters: [] }
		groups.set(groupKey, group)
	}
	const ownedGroup = group
	const release = () => {
		if (!ownedGroup.active) return
		ownedGroup.active = false
		drain(groupKey, ownedGroup)
	}
	if (!ownedGroup.active && ownedGroup.waiters.length === 0) {
		ownedGroup.active = true
		return release
	}
	return new Promise<() => void>((resolve, reject) => {
		const waiter: Waiter = { resolve, reject, detach: () => {} }
		if (signal) {
			const aborted = () => {
				const index = ownedGroup.waiters.indexOf(waiter)
				if (index >= 0) ownedGroup.waiters.splice(index, 1)
				waiter.detach()
				reject(signal.reason ?? new Error("The headless review command was cancelled."))
				drain(groupKey, ownedGroup)
			}
			if (signal.aborted) {
				aborted()
				return
			}
			signal.addEventListener("abort", aborted, { once: true })
			waiter.detach = () => signal.removeEventListener("abort", aborted)
		}
		ownedGroup.waiters.push(waiter)
	})
}

function drain(key: string, group: CommandGroup): void {
	if (group.active || group.waiters.length === 0) {
		if (!group.active && group.waiters.length === 0) groups.delete(key)
		return
	}
	const waiter = group.waiters.shift()
	if (!waiter) return
	waiter.detach()
	group.active = true
	waiter.resolve(() => {
		if (!group.active) return
		group.active = false
		drain(key, group)
	})
}
