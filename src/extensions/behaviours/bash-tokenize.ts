/**
 * Pragmatic shell tokeniser — extracts the *executable* of every command
 * stage in a Bash one-liner, the way an agent might emit one.
 *
 * Not a full Bash parser. Handles the constructs that show up in
 * agent-generated commands and that our gh/glab matchers need to be robust
 * against:
 *
 * - Stage separators: `;`, `&&`, `||`, `|`, `&`, newline.
 * - Command substitution: `$(...)` and backticks recurse as nested commands.
 * - Subshell groups: `(...)` recurses as a nested command when it opens a
 *   stage.
 * - Quoting: single quotes (literal), double quotes (with `\` escapes and
 *   `$()` / backtick recursion inside).
 * - Backslash escapes outside single quotes.
 * - Env-var prefixes: `FOO=bar BAZ=qux gh pr list` resolves to `gh`.
 * - Comments: `#` at a token boundary skips to the next newline.
 * - Heredocs: `<<EOF` / `<<-EOF` swallows lines until the closing delimiter.
 *
 * Deliberately not handled (rare in agent commands):
 * - Process substitution `<(...)` / `>(...)`.
 * - Brace groups `{ ...; }`.
 * - Aliases, function definitions, `eval`.
 *
 * False-positive direction is preferred over false-negative — a missed
 * heredoc body whose contents happen to start with `gh` is the kind of
 * surprise we want to keep out of the registry.
 */

/**
 * Return the executable token of every command stage in `command`.
 *
 * Order matches lexical order of the input. Each entry is the bare program
 * name as written (no path resolution, no quote normalisation beyond the
 * quoting rules above).
 */
export function bashExecutables(command: string): string[] {
	const exes: string[] = []
	walk(command, 0, undefined, exes)
	return exes
}

/** True iff any stage of `command` invokes `target` as the executable. */
export function bashInvokesCommand(command: string, target: string): boolean {
	for (const exe of bashExecutables(command)) {
		if (exe === target) return true
	}
	return false
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Walk from `start`, emitting executables into `out`. Returns the index just
 * past where walking stopped — either end of input, or the matching `closer`
 * for a recursed substitution / subshell.
 */
function walk(s: string, start: number, closer: ")" | "`" | undefined, out: string[]): number {
	let i = start
	let expectingExe = true
	let currentToken = ""
	let tokenStarted = false

	function flushToken(): void {
		if (!tokenStarted) return
		if (expectingExe) {
			// An env-var assignment (WORD=value) keeps us in expectingExe state so
			// the *next* token gets recorded as the executable.
			const eq = currentToken.indexOf("=")
			if (eq > 0 && ENV_VAR_NAME.test(currentToken.slice(0, eq))) {
				// swallow assignment, stay in expectingExe
			} else {
				out.push(currentToken)
				expectingExe = false
			}
		}
		currentToken = ""
		tokenStarted = false
	}

	function endStage(): void {
		flushToken()
		expectingExe = true
	}

	while (i < s.length) {
		const c = s[i]

		// Closer for a recursive call (subshell or backtick).
		if (closer && c === closer) {
			endStage()
			return i + 1
		}

		// Whitespace ends the current token but stays within the stage.
		if (c === " " || c === "\t") {
			flushToken()
			i++
			continue
		}

		// Newline ends the stage.
		if (c === "\n") {
			endStage()
			i++
			continue
		}

		// Stage separators.
		if (c === ";") {
			endStage()
			i++
			continue
		}
		if (c === "&") {
			endStage()
			i += s[i + 1] === "&" ? 2 : 1
			continue
		}
		if (c === "|") {
			endStage()
			i += s[i + 1] === "|" ? 2 : 1
			continue
		}

		// Comment at token boundary.
		if (c === "#" && !tokenStarted) {
			while (i < s.length && s[i] !== "\n") i++
			continue
		}

		// Subshell group `(...)` opens a stage.
		if (c === "(" && expectingExe && !tokenStarted) {
			i = walk(s, i + 1, ")", out)
			// After `)` the outer stage is "done" — anything trailing is args.
			expectingExe = false
			continue
		}

		// Command substitution `$(...)`.
		if (c === "$" && s[i + 1] === "(") {
			flushToken()
			i = walk(s, i + 2, ")", out)
			// Substitution acts like a word in the outer command; if we were
			// expecting an executable, the substitution result *is* it, but we
			// can't know the value statically — treat as opaque, leave
			// expectingExe true so a subsequent `cmd` after the substitution is
			// still considered an executable. Common shape: `$(date) cmd …` is
			// vanishingly rare; the alternative shape `cmd $(date)` only loses
			// nothing because flushToken already emitted no-op.
			continue
		}

		// Backtick command substitution.
		if (c === "`") {
			flushToken()
			i = walk(s, i + 1, "`", out)
			continue
		}

		// Single quotes — literal.
		if (c === "'") {
			tokenStarted = true
			i++
			while (i < s.length && s[i] !== "'") {
				currentToken += s[i]
				i++
			}
			if (i < s.length) i++ // consume closing quote
			continue
		}

		// Double quotes — escapes + recursion.
		if (c === '"') {
			tokenStarted = true
			i++
			while (i < s.length && s[i] !== '"') {
				const d = s[i]
				if (d === "\\" && i + 1 < s.length) {
					currentToken += s[i + 1]
					i += 2
					continue
				}
				if (d === "$" && s[i + 1] === "(") {
					i = walk(s, i + 2, ")", out)
					continue
				}
				if (d === "`") {
					i = walk(s, i + 1, "`", out)
					continue
				}
				currentToken += d
				i++
			}
			if (i < s.length) i++ // consume closing quote
			continue
		}

		// Backslash escape outside quotes.
		if (c === "\\" && i + 1 < s.length) {
			tokenStarted = true
			currentToken += s[i + 1]
			i += 2
			continue
		}

		// Heredoc — `<<DELIM` or `<<-DELIM`. Swallow the body up to the line
		// containing only the delimiter (with `<<-` allowing leading tabs).
		if (c === "<" && s[i + 1] === "<") {
			const stripTabs = s[i + 2] === "-"
			let j = i + (stripTabs ? 3 : 2)
			// Optional whitespace then a delimiter token (possibly quoted).
			while (j < s.length && (s[j] === " " || s[j] === "\t")) j++
			let delim = ""
			if (s[j] === '"' || s[j] === "'") {
				const q = s[j]
				j++
				while (j < s.length && s[j] !== q) {
					delim += s[j]
					j++
				}
				if (j < s.length) j++
			} else {
				while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) {
					delim += s[j]
					j++
				}
			}
			if (delim === "") {
				// Not actually a heredoc (e.g. `<<<` here-string falls through to
				// generic token handling). Emit the `<<` literally and move on.
				tokenStarted = true
				currentToken += "<<"
				i += 2
				continue
			}
			// Find end of current line, then scan for the delimiter line.
			while (j < s.length && s[j] !== "\n") j++
			if (j < s.length) j++ // step past newline into body
			while (j < s.length) {
				const lineStart = j
				if (stripTabs) while (j < s.length && s[j] === "\t") j++
				let lineEnd = j
				while (lineEnd < s.length && s[lineEnd] !== "\n") lineEnd++
				const line = s.slice(j, lineEnd)
				if (line === delim) {
					j = lineEnd
					if (j < s.length) j++ // consume newline
					break
				}
				j = lineEnd
				if (j < s.length) j++
				// Defensive: if we somehow loop without progress, bail out.
				if (j <= lineStart) break
			}
			i = j
			// The heredoc swallowed the trailing newline of the delimiter line,
			// which in normal shell ends the surrounding command. Reset stage
			// state so what follows is treated as a fresh command.
			endStage()
			continue
		}

		// Generic token character.
		tokenStarted = true
		currentToken += c
		i++
	}

	endStage()
	return i
}
