# Changelog

## Unreleased

### Fixed

- Non-interactive runs (`--print`, or any run whose stdin or stdout is not a terminal) that end without a prompt now exit with code `2` and write a `KIMCHI_NO_PROMPT:` message to stderr.
- Non-interactive runs that end without a final answer (empty, whitespace-only, thinking-only, or tool-only), or whose prompt an extension handled so the agent never ran, now exit with code `3` and write a `KIMCHI_NO_RESULT:` message to stderr. Existing exit code `1` (text mode) and `74` are unchanged.

### Changed

- `--mode json` runs with no prompt or no final answer now exit with `2` or `3` instead of `0`. Model error, abort, and truncation still exit `0` in JSON mode. The JSON event stream on stdout is unchanged. Update scripts that relied on exit `0` for these runs.
- ACP and TUI behavior is unchanged.

See [docs/non-interactive-runs.md](docs/non-interactive-runs.md).
