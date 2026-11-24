# Changelog

## Unreleased

### Fixed

- `--print` runs that end without a prompt now exit with code `2` and write a `KIMCHI_NO_PROMPT:` message to stderr.
- `--print` runs that end without a final answer (empty, whitespace-only, thinking-only, or tool-only) now exit with code `3` and write a `KIMCHI_NO_RESULT:` message to stderr. Existing exit codes `1` and `74` are unchanged.

### Changed

- `--mode json` runs with no prompt or no final answer now exit with `2` or `3` instead of `0`. The JSON event stream on stdout is unchanged. Update scripts that relied on exit `0` for these runs.
- ACP and TUI behavior is unchanged.

See [docs/non-interactive-runs.md](docs/non-interactive-runs.md).
