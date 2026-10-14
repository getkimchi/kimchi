globalThis.createTerminalReplay = function createTerminalReplay(recording, host, options = {}) {
	const events = recording.events
	const duration = Math.max(Number.isFinite(options.duration) ? options.duration : 0, events.at(-1)?.[0] || 0)
	const notifications = new EventTarget()
	const inner = document.createElement("div")
	inner.className = "kimchi-terminal-inner"
	host.classList.add("kimchi-terminal")
	host.appendChild(inner)
	const terminal = new globalThis.Terminal({
		cols: recording.cols,
		rows: recording.rows,
		scrollback: 0,
		disableStdin: true,
		allowProposedApi: true,
		cursorBlink: false,
		cursorInactiveStyle: "block",
		fontSize: 14,
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
		linkHandler: { activate() {}, allowNonHttpProtocols: false },
		theme: { background: "#18181e", foreground: "#c4c4cf" },
	})
	terminal.loadAddon(new globalThis.Unicode11Addon.Unicode11Addon())
	terminal.unicode.activeVersion = "11"
	// The viewer stays unfocused, so mirror recorded cursor shapes into its inactive style.
	terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
		const style = ["block", "block", "block", "underline", "underline", "bar", "bar"][params[0] ?? 1]
		if (style) terminal.options.cursorInactiveStyle = style
		return false
	})
	function resetCursor() {
		terminal.options.cursorInactiveStyle = "block"
		return false
	}
	terminal.parser.registerEscHandler({ final: "c" }, resetCursor)
	terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, resetCursor)
	terminal.open(inner)
	const screen = inner.querySelector(".xterm-screen")
	function fit() {
		const width = screen.offsetWidth
		const height = screen.offsetHeight
		if (!width || !height || !host.clientWidth || !host.clientHeight) return
		inner.style.width = `${width}px`
		inner.style.height = `${height}px`
		inner.style.transform = `scale(${Math.min(host.clientWidth / width, host.clientHeight / height)})`
	}
	const observer = new ResizeObserver(fit)
	observer.observe(host)
	observer.observe(screen)
	fit()

	let cursor = 0
	let offset = 0
	let position = 0
	let speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1
	let playing = false
	let disposed = false
	let revision = 0
	let animation = 0
	let clockPosition = 0
	let clockTime = 0
	let pending = Promise.resolve()
	let finishWrite
	const emit = (type, detail) => notifications.dispatchEvent(new CustomEvent(type, { detail }))
	function stop() {
		playing = false
		revision++
		cancelAnimationFrame(animation)
		animation = 0
	}
	function enqueue(operation) {
		pending = pending.then(operation).catch((error) => {
			if (disposed) return
			stop()
			emit("error", { error })
		})
		return pending
	}
	function write(text) {
		if (!text) return Promise.resolve()
		return new Promise((resolve) => {
			finishWrite = () => {
				finishWrite = undefined
				resolve()
			}
			terminal.write(text, finishWrite)
		})
	}
	function resize(cols, rows) {
		if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
			throw new Error("Invalid terminal size")
		}
		terminal.resize(cols, rows)
	}
	function anchor() {
		clockPosition = position
		clockTime = performance.now()
	}
	function clock(now) {
		return Math.min(duration, clockPosition + ((now - clockTime) / 1000) * speed)
	}
	async function advance(target, request, notify) {
		let yieldedAt = performance.now()
		while (!disposed && request === revision && cursor < events.length && events[cursor][0] <= target) {
			const [time, kind, value] = events[cursor]
			if (kind === "o") {
				const pieces = []
				let length = 0
				let next = cursor
				let nextOffset = offset
				let writtenAt = time
				// Bound each UTF-16 write to 1 MiB, including a single large output event.
				while (next < events.length && next - cursor < 2048 && length < 524288) {
					const [eventTime, eventKind, text] = events[next]
					if (eventTime > target || eventKind !== "o") break
					let end = Math.min(text.length, nextOffset + 524288 - length)
					const last = text.charCodeAt(end - 1)
					const following = text.charCodeAt(end)
					if (last >= 0xd800 && last <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) end--
					if (end === nextOffset && text.length > nextOffset) break
					pieces.push(text.slice(nextOffset, end))
					length += end - nextOffset
					nextOffset = end
					writtenAt = eventTime
					if (nextOffset === text.length) {
						next++
						nextOffset = 0
					}
				}
				await write(pieces.join(""))
				cursor = next
				offset = nextOffset
				position = writtenAt
			} else {
				if (kind === "r") {
					if (!/^\d+x\d+$/.test(value)) throw new Error("Invalid terminal size")
					resize(...value.split("x").map(Number))
				}
				cursor++
				position = time
				// Listeners may synchronously pause or seek. Never await a listener here.
				if (kind === "m" && notify) emit("marker", { index: value })
			}
			if (request !== revision || disposed) return false
			if (performance.now() - yieldedAt >= 8) {
				await new Promise((resolve) => setTimeout(resolve, 0))
				yieldedAt = performance.now()
			}
		}
		if (request !== revision || disposed) return false
		position = target
		return true
	}
	function schedule() {
		if (!playing || disposed || animation) return
		animation = requestAnimationFrame((now) => {
			animation = 0
			const request = revision
			const target = clock(now)
			enqueue(async () => {
				if (!playing || disposed || request !== revision) return
				if (!(await advance(target, request, true))) return
				if (position >= duration) {
					playing = false
					emit("ended")
				} else schedule()
			})
		})
	}
	async function seek(seconds) {
		if (disposed) return
		if (!Number.isFinite(seconds)) throw new Error("Invalid replay time")
		const target = Math.max(0, Math.min(duration, seconds))
		const request = ++revision
		cancelAnimationFrame(animation)
		animation = 0
		await enqueue(async () => {
			if (disposed || request !== revision) return
			if (target < position) {
				terminal.reset()
				resetCursor()
				resize(recording.cols, recording.rows)
				cursor = 0
				offset = 0
				position = 0
			}
			if (!(await advance(target, request, false))) return
			anchor()
			schedule()
		})
	}
	return {
		addEventListener(type, listener) {
			notifications.addEventListener(type, (event) => listener(event.detail))
		},
		async play() {
			if (disposed || playing) return
			playing = true
			emit("playing")
			const request = revision
			await pending
			if (!playing || disposed || request !== revision) return
			if (position >= duration) return seek(0)
			anchor()
			schedule()
		},
		async pause() {
			if (disposed) return
			const wasPlaying = playing
			stop()
			if (wasPlaying) emit("pause")
			await pending
		},
		seek,
		getCurrentTime: () => position,
		setSpeed(value) {
			if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid replay speed")
			const now = performance.now()
			clockPosition = playing ? clock(now) : position
			clockTime = now
			speed = value
		},
		dispose() {
			if (disposed) return
			disposed = true
			stop()
			observer.disconnect()
			terminal.dispose()
			finishWrite?.()
			inner.remove()
		},
	}
}
