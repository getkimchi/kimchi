import {
	confirm as clackConfirm,
	multiselect as clackMultiselect,
	password as clackPassword,
	select as clackSelect,
	isCancel,
} from "@clack/prompts"

/**
 * Outcome of a wizard prompt.
 *
 * - `next` — user answered, value carried forward
 * - `back` — user pressed Esc; runner should rewind one step
 * - `cancel` — user pressed Ctrl-C; runner should abort
 */
export type Outcome<T> = { kind: "next"; value: T } | { kind: "back" } | { kind: "cancel" }

interface KeyTracker {
	uninstall: () => void
	lastCancelKey: () => "escape" | "ctrl-c" | null
}

/**
 * Subscribe to raw keypress events on stdin while a clack prompt is active
 * so we can tell whether the resulting cancel symbol came from Esc or
 * Ctrl-C. clack treats both as "cancel" and gives us no way to distinguish,
 * so we sniff keypress events in parallel — node's EventEmitter fan-out
 * means clack still gets its events too.
 */
function trackCancelKey(): KeyTracker {
	let last: "escape" | "ctrl-c" | null = null
	const listener = (
		_str: string | undefined,
		key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
	) => {
		if (!key) return
		if (key.ctrl && key.name === "c") {
			last = "ctrl-c"
		} else if (key.name === "escape") {
			last = "escape"
		} else {
			// A non-cancel keypress arrived (typing, navigation). Reset so a
			// later submit doesn't get misclassified by a stale escape.
			last = null
		}
	}
	process.stdin.on("keypress", listener)
	return {
		uninstall: () => process.stdin.off("keypress", listener),
		lastCancelKey: () => last,
	}
}

async function awaitWithCancelDetection<T>(backable: boolean, prompt: () => Promise<T | symbol>): Promise<Outcome<T>> {
	const tracker = trackCancelKey()
	try {
		const result = await prompt()
		if (isCancel(result)) {
			return tracker.lastCancelKey() === "escape" && backable ? { kind: "back" } : { kind: "cancel" }
		}
		return { kind: "next", value: result as T }
	} finally {
		tracker.uninstall()
	}
}

export interface SelectOption<T> {
	value: T
	label: string
	hint?: string
}

export async function select<T>(opts: {
	message: string
	options: SelectOption<T>[]
	initialValue?: T
	backable: boolean
}): Promise<Outcome<T>> {
	return awaitWithCancelDetection(opts.backable, () =>
		clackSelect<T>({
			message: opts.message,
			options: opts.options as Parameters<typeof clackSelect<T>>[0]["options"],
			initialValue: opts.initialValue,
		}),
	)
}

export async function multiselect<T>(opts: {
	message: string
	options: SelectOption<T>[]
	initialValues?: T[]
	required?: boolean
	backable: boolean
}): Promise<Outcome<T[]>> {
	return awaitWithCancelDetection(opts.backable, () =>
		clackMultiselect<T>({
			message: opts.message,
			options: opts.options as Parameters<typeof clackMultiselect<T>>[0]["options"],
			initialValues: opts.initialValues,
			required: opts.required,
		}),
	)
}

export async function confirm(opts: {
	message: string
	initialValue?: boolean
	backable: boolean
}): Promise<Outcome<boolean>> {
	return awaitWithCancelDetection(opts.backable, () =>
		clackConfirm({ message: opts.message, initialValue: opts.initialValue }),
	)
}

export async function password(opts: {
	message: string
	validate?: (v: string | undefined) => string | undefined
	backable: boolean
}): Promise<Outcome<string>> {
	const result = await awaitWithCancelDetection<string | undefined>(
		opts.backable,
		() => clackPassword({ message: opts.message, validate: opts.validate }) as Promise<string | symbol | undefined>,
	)
	if (result.kind !== "next") return result
	return { kind: "next", value: result.value ?? "" }
}
