import { describe, expect, it } from "vitest"
import { bashExecutables, bashInvokesCommand } from "./bash-tokenize.js"

describe("bashExecutables", () => {
	it("returns the single executable of a simple command", () => {
		expect(bashExecutables("ls -la")).toEqual(["ls"])
	})

	it("returns empty for an empty command", () => {
		expect(bashExecutables("")).toEqual([])
		expect(bashExecutables("   \n\t  ")).toEqual([])
	})

	it("walks pipeline stages", () => {
		expect(bashExecutables("ls -la | grep foo | wc -l")).toEqual(["ls", "grep", "wc"])
	})

	it("walks sequence stages", () => {
		expect(bashExecutables("a; b && c || d")).toEqual(["a", "b", "c", "d"])
	})

	it("treats newlines as stage separators", () => {
		expect(bashExecutables("a\nb\nc")).toEqual(["a", "b", "c"])
	})

	it("treats `&` as a stage separator", () => {
		expect(bashExecutables("server & client")).toEqual(["server", "client"])
	})

	it("does not split on `|` inside double quotes", () => {
		expect(bashExecutables('echo "a | b" | wc')).toEqual(["echo", "wc"])
	})

	it("does not split on `;` inside single quotes", () => {
		expect(bashExecutables("echo 'a; b' ; wc")).toEqual(["echo", "wc"])
	})

	it("recurses into command substitution", () => {
		// `do` and `done` are shell keywords but the tokeniser is keyword-blind:
		// after a `;` it sees a fresh stage and records the first token as the
		// executable. That's fine for our use — we never match against keywords.
		expect(bashExecutables("for x in $(ls -la); do echo $x; done")).toEqual(["for", "ls", "do", "done"])
	})

	it("recurses into backtick substitution", () => {
		// Outer `echo` flushes when whitespace hits, then the recursive call
		// emits `whoami`. Order is lexical-with-recursion-after-flush.
		expect(bashExecutables("echo `whoami`")).toEqual(["echo", "whoami"])
	})

	it("recurses into subshell groups", () => {
		expect(bashExecutables("(cd /tmp && ls)")).toEqual(["cd", "ls"])
	})

	it("strips env-var assignment prefixes", () => {
		expect(bashExecutables("FOO=bar gh pr list")).toEqual(["gh"])
		expect(bashExecutables("FOO=bar BAZ=qux gh pr list")).toEqual(["gh"])
	})

	it("treats `=` inside an arg as an arg, not an env var", () => {
		// `--flag=value` is not a leading `WORD=value` because it begins with `-`.
		expect(bashExecutables("cmd --flag=value")).toEqual(["cmd"])
	})

	it("skips `#` comments at token boundary", () => {
		expect(bashExecutables("ls # gh pr list")).toEqual(["ls"])
		expect(bashExecutables("# all commented\nls")).toEqual(["ls"])
	})

	it("does not treat `#` mid-token as a comment", () => {
		expect(bashExecutables("echo a#b")).toEqual(["echo"])
	})

	it("preserves quoted token contents", () => {
		expect(bashExecutables("'/usr/bin/gh' pr list")).toEqual(["/usr/bin/gh"])
		expect(bashExecutables('"/usr/bin/gh" pr list')).toEqual(["/usr/bin/gh"])
	})

	it("handles backslash escapes outside quotes", () => {
		expect(bashExecutables("\\ls -la")).toEqual(["ls"])
	})

	it("swallows heredoc bodies", () => {
		expect(bashExecutables("cat <<EOF\ngh pr list\nEOF\nls")).toEqual(["cat", "ls"])
	})

	it("swallows heredoc bodies with `<<-` and tab-stripped delimiter", () => {
		expect(bashExecutables("cat <<-END\n\tgh pr list\n\tEND\nls")).toEqual(["cat", "ls"])
	})

	it("swallows heredoc with quoted delimiter", () => {
		expect(bashExecutables("cat <<'EOF'\ngh\nEOF\nls")).toEqual(["cat", "ls"])
	})

	it("does not break on `<<<` here-string", () => {
		// Here-strings don't take a body; we treat the `<<` as a literal token,
		// which is fine — the executable is still `cmd`.
		expect(bashExecutables("cmd <<< 'input'")).toEqual(["cmd"])
	})
})

describe("bashInvokesCommand", () => {
	it("returns true when the target appears as any executable", () => {
		expect(bashInvokesCommand("cd /tmp && gh pr list", "gh")).toBe(true)
		expect(bashInvokesCommand("ls", "gh")).toBe(false)
	})

	it("does not match against substrings", () => {
		expect(bashInvokesCommand("git fetch", "gh")).toBe(false)
		expect(bashInvokesCommand("ghost", "gh")).toBe(false)
	})

	it("matches from inside command substitution", () => {
		expect(bashInvokesCommand("count=$(gh pr list | wc -l)", "gh")).toBe(true)
	})

	it("does not match inside string literals", () => {
		expect(bashInvokesCommand('echo "gh foo"', "gh")).toBe(false)
		expect(bashInvokesCommand("echo 'gh'", "gh")).toBe(false)
	})

	it("does not match heredoc body lines", () => {
		expect(bashInvokesCommand("cat <<EOF\ngh foo\nEOF", "gh")).toBe(false)
	})
})
