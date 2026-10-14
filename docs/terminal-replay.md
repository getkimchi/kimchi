# Terminal recordings in session exports

Kimchi automatically records interactive terminal output so an unexpected display problem can be watched later. Run `/export report.html`, choose **Transcript + replay (raw terminal output)**, then open the HTML and select **Replay** beside **JSONL** in the header. **Transcript** returns to the conversation at the same scroll position. Playback fills the viewing area and works locally, with play, pause, seeking, speed and recorded terminal resizes. It makes no model calls or recording-service requests.

Changing speed preserves both position and play/pause state without rebuilding the terminal. Returning to the transcript pauses replay; reopening keeps the same position, speed and part. The browser retains only the selected part decoded while the HTML stays open. Switching parts replaces that cache; recorded output and pauses are unchanged. **Download part**, next to the part selector, saves the selected part and its player as a standalone HTML file that opens offline.

## Linked harness steps

New recordings include a **Harness steps** panel beside the terminal. Select a prompt, completed response, tool call, tool result or error to pause on its associated screen and inspect its text. **Previous step** and **Next step** move through the selected part. **Next error** jumps to its next captured failure; **Pause on errors** stops playback there automatically. Resuming continues beyond that failure. Scrubbing or playing the recording follows the trace. Selecting another recording part loads that part's steps, and **Download part** includes them in the offline file.

The harness observes each step after the interactive UI handles it, then attaches it to the next completed terminal frame. The marker carries the delay between observation and that frame. Several steps can share a frame; collapsed tools, overlays and scrolling can hide their content. A step with no completed frame remains inspectable and says so rather than seeking to an unrelated screen. Older recordings say **No linked steps in this recording.** Their terminal playback still works.

Tool results follow live completion order, including parallel calls. They contain the result and failure flag supplied to the TUI; later transcript replacements can differ. Error navigation relies on the harness reporting a failure, so an error returned as successful content remains a normal result in the trace. Distinct frames remain individually seekable even when they share a clock sample.

Expand **Session details**, **Saved session content** or **Request diagnostics** inside a selected step to inspect the original export's extra information. Where available, this includes model/provider, stop reason, input/output/cache tokens, reported cost, response and trace IDs, saved tool arguments/results, HTTP status, retry information and request errors. Request duration measures time to response headers, not the complete streamed response. Reported cost is the value saved by the harness, not verified billing.

These details are assembled at export time from the already-redacted session data. New prompt/response markers carry their original message timestamp and optional response ID; tools use their call ID. Only unique matches within the same session are attached. Missing or ambiguous matches are shown explicitly, including older prompt/response markers without those identifiers. Related diagnostics follow the matched response's parent chain without crossing another message. Saved final content is labelled separately because it can differ from the live output on the recorded screen. The same details travel with **Download part**.

Captured trace text stays bounded inside the recording's storage budget. Tool arguments and results can contain sensitive text even when the terminal shows a collapsed summary. The raw export choice covers both the terminal and its captured trace; transcript redaction does not change them. Saved-session enrichment is separately bounded to 64 KiB per step and 1 MiB per part, with shortening and omission notices. It adds export work and HTML size; live capture only copies the message timestamp/response ID. Model reasoning, image payloads and continuous debug logs are not recorded. Resumed history is not presented as newly executed steps, and expired parts also lose their steps.

The replay page follows the transcript export's compact monospace design, with harness steps on the left and the recorded terminal beside them. All parts use Kimchi's play/pause button and seek slider. The browser mounts only visible step rows and avoids a DOM node for every timeline marker. Trace navigation and error pauses stay available; this reduces browser work without changing harness capture. Standalone downloads use the same layout and controls.

This supports inspection of a past run. It does not pause a live agent, inspect process memory, re-execute tools or prove that a later code change fixes the issue.

### Research and implementation choice

The useful pattern in [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) is selecting an action to see the corresponding visual state and details. [rrweb custom events](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/custom-event.md) provide a similar link between semantic events and a recording timeline. Neither is a terminal recorder, so this implementation adds semantic markers to the existing terminal stream.

Kimchi keeps semantic markers in captured order alongside output and resize events. Its playback controller stops processing at an error marker before drawing subsequent output; the trace panel seeks through the same ordered stream. [xterm.js](https://github.com/xtermjs/xterm.js) renders terminal bytes while Kimchi owns timing, controls, navigation and the page design.

Pinned Pi 0.85.1 supplies public session events but no terminal-to-trace mapping. Its extension hooks precede the interactive UI subscriber and can replace finalized messages; a subscriber after the UI sees the final event. The terminal redraw is scheduled later, so an event timestamp alone can stop before an error appears. Completed synchronized-output bursts supply the frame boundary. The [Pi package catalog](https://pi.dev/packages) and bounded upstream issue/PR searches did not reveal a ready-made adapter for this flow. No upstream patch is needed.

The pinned session emits message events to subscribers before saving their entries. Reading its current leaf inside that subscriber would therefore link to an earlier entry. Export enrichment uses the original message identity instead and declines ambiguous matches. If redaction masked a saved response ID, a unique role/timestamp match still allows its details to appear while the ID stays masked. It preserves the captured frame and failure flag when saved transcript replacements differ.

The default export choice is **Transcript only (redacted)**. A terminal recording can contain visible drafts, secrets and text cleared from the screen. The recording is raw; the transcript keeps its existing redaction. Review the recording before sharing the file. JSONL and noninteractive exports do not include raw recordings.

## Recording limits

| Limit | Default |
| --- | --- |
| Pending recording data | 1 MiB per active recorder |
| One recording part | 32 MiB decoded or 8 MiB compressed, whichever is reached first |
| Retained parts across sessions | 16 slots, at most 128 MiB compressed data plus small metadata files |
| Retention | Inactive parts older than 7 days are removed when another part starts; expired parts are excluded from export |
| One export | All retained parts for that session, compressed; each part is repacked separately and only the selected part is decoded for playback |

Recordings live under the harness directory in `terminal-recordings/`, with owner-only directory and file permissions. Multiple processes reserve separate slots. Old inactive parts are replaced first; an active part is never evicted. If every slot is active, a new session continues without recording.

When a part fills, capture continues in the next numbered part. A short-lived worker reconstructs the screen from the completed part and saves a starting checkpoint for the next part. The worker keeps reconstruction off the interactive event loop; it still consumes CPU and temporary RAM. It does not redraw the live terminal or run a second terminal emulator on ordinary writes. Later parts remain playable after older parts are removed. A five-day session can therefore keep recording, but the amount retained depends on output volume rather than elapsed time. Idle time adds almost no data.

The HTML identifies continued parts, buffer limits, storage errors and interrupted capture. If a single frame plus its starting checkpoint cannot fit in a part, capture stops with a size-limit notice. Excessive output or slow storage can still fill the bounded queue and stop recording. An abruptly killed process can lose its final unflushed fraction; committed chunks remain readable. Recording writes never wait for disk I/O, and lifecycle operations give a stalled recorder at most one second before proceeding. The explicit raw replay export may take longer while retained parts are read and compressed; transcript-only exports skip this work. Base64 and the embedded player make an HTML export larger than the stored compressed data.

Open `/resources`, select **Extensions**, and toggle **Terminal recording** to control automatic capture. It defaults to on and takes effect immediately. Turning it off closes the current part; turning it on starts a new visit with a complete screen. The choice persists through the existing `terminalRecording` setting in `~/.config/kimchi/harness/settings.json`, including older explicit false values. Existing recordings remain available.

`--no-session`, print, RPC and ACP sessions do not record a terminal. ACP exposes the same resource setting for configuration, with no terminal capture. To clear stored recordings, remove `terminal-recordings/` while Kimchi is closed.

## What replay proves

The player receives captured output bytes, timing and dimensions. It can show incorrect clearing, duplicated lines, cursor placement, wrapping, menus and streaming. Each startup or session replacement starts a separate recording, with numbered parts and timestamps in the selector. A full repaint starts a replacement session's recording so differential rendering has a valid initial frame; size-based part rotation preserves the existing screen instead.

This is terminal playback, not pixel video. Fonts, Unicode widths, terminal-specific sequences and inline image protocols may render differently. Use a screen recording for terminal-host or GPU defects. Playing an old recording also cannot prove a fix: use a controlled TUI regression to execute the changed renderer.

Two fidelity limits reproduced in both the previous player and this implementation: joined emoji can occupy more columns than Kimchi expects, and part checkpoints can lose background colours on blank alternate-screen cells. Keep the original terminal-host capture when either detail is central to the issue.

## Implementation and validation

`src/terminal-replay/` owns capture, bounded storage and export integration. A small adapter starts capture before Pi's first interactive frame; session hooks own export consent and cleanup. Writes to both attached stdout and stderr are observed, including terminal methods that bypass `Terminal.write`. Raw input is not recorded. Output is encoded as asciicast v3; independently compressed, length-framed chunks make incomplete final writes ignorable.

UTF-8 string writes are captured without allocating an intermediate Buffer. The tap normalizes lone UTF-16 surrogates as Node's UTF-8 encoding does, and retains the streaming decoder for Buffer writes and other encodings. This reduces work on each normal redraw without changing capture timing or storage limits.

Capture batches up to 256 KiB or one second of pending output before compressing at gzip level 1. Event timestamps are recorded before batching, so this changes disk-write frequency rather than replay timing. Export and close flush immediately. The queue remains capped at 1 MiB; an abrupt termination can lose roughly the latest second of buffered output, plus any write still in progress. Slow storage or output arriving faster than a part checkpoint can finish can still stop capture at the queue limit.

The flush timer is one-shot and exists only while data is pending. Once that batch is saved, idle capture has no recurring timer, compression, disk writes or checkpoint worker. An explicit empty flush waits for any existing write without rewriting unchanged metadata. A long quiet interval is stored as the next event's elapsed time, not repeated blank frames. Actual terminal output, including spinners, and resize events remain recorded. Tests cover a simulated five-day pause and a separate 20-second idle TUI observation; neither is a five-day soak.

Export repacks each part at gzip level 6 and compresses its saved trace details separately. The player document is escaped JSON rather than a second base64 layer around already encoded recordings. This reduces HTML size at the cost of more export-time compression; live capture keeps its fast compression setting. Only the selected part and its details are decoded in the browser, and downloaded parts keep their details compressed.

The offline player uses a pinned normal package dependency. Setup/build copies its installed browser assets and Kimchi's controller into ignored generated files; no separate download script is needed. It runs in a sandboxed iframe with network access disabled by Content Security Policy, terminal input and recorded-link activation disabled, and no clipboard addon. The transcript and subagent viewers keep their existing rendering. Generated upstream export templates are not edited.

### Owning the replay UI

`resources/terminal-replay/playback.js` owns playback, seeking, resize and speed. `player.html` owns the interface and trace inspection. `scripts/copy-resources.js` stages the normal `@xterm/xterm` dependency and its Unicode11 addon during setup/build. The browser and part checkpoints use the same Unicode width rules. The former `scripts/stage-terminal-replay.js` downloader is removed. Neither browser renderer nor playback controller runs on live output writes.

The following alternatives were researched and tried in Chromium 147 on 2026-10-13, using the same ordered fixture and original 73.315-second GLM-5.3 recording. The fixture covers clearing, colour, CJK/combining text, split control sequences, recorded resize, backward seek and a one-microsecond failure/recovery boundary. Tests ran offline in a sandbox with network access denied.

| Option | Verified result | Decision |
| --- | --- | --- |
| [asciinema-player 3.17.0](https://github.com/asciinema/asciinema-player/releases/tag/v3.17.0) | Previous implementation passed all eight fixture checkpoints and ten real marker screens. | Working baseline; replaced to own playback and use normal package assets. |
| [xterm.js 6.0.0](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0) | Passed all eight checkpoints, ten real screens, pause/speed/error stopping, hostile OSC input and 20 combining-text reset cycles. Non-graphic screen text matched the baseline; screenshots were inspected separately because the baseline draws block glyphs with CSS. | Selected. Public [write/reset/resize APIs](https://xtermjs.org/docs/api/terminal/classes/terminal/) supply rendering; Kimchi owns the recording controller. |
| [ghostty-web 0.4.0](https://github.com/coder/ghostty-web) | Offline WASM loading worked. A write after reset crashed with combining text and multi-codepoint emoji: ten failures and six passing ASCII/CJK/simple-emoji controls, each using a fresh WASM instance. | Rejected for backward-seek lifecycle failure, consistent with [upstream issue 141](https://github.com/coder/ghostty-web/issues/141). Large-part test skipped after the crash. |
| [tty-player](https://github.com/chris-morgan/tty-player/tree/083734213d1c1ed23b5530915aaa0c85ab61d764) | Passed 26 of 27 checks, including ten real screens. Recorded resize from 80×24 to 40×12 stayed at 80×24 and wrapped incorrectly. Ttyrec conversion also needs a separate marker channel. | Rejected for resize failure. No npm package; source last changed in 2020 and depends on an old term.js fork. Large-part test skipped. |

The xterm.js package integrity matched the registry. It has no runtime dependencies; its upstream repository was active on the research date. GitHub listed no published advisories and OSV returned no match for 6.0.0. Those bounded checks do not prove absence of vulnerabilities. Package code and required notices remain in installed/generated assets, outside tracked source.

In one shared 32 MiB JSONL trial (220,455 events; 21.27 MiB terminal output), the xterm prototype applied the already-parsed stream in 660 ms. The previous player opened in 401 ms and then sought to the end in 174 ms. The controller paths differ, so these are responsiveness observations, not a controlled engine speed comparison. Replacing the browser renderer does not reduce or increase live capture work. Production checks cover recorded dimensions, backward seeks, exact failure frames, Unicode, speed changes, dense traces, retained parts and offline downloads.

### Ten concurrent real-model sessions

Two rounds ran ten native TUI sessions per arm: official [v1.9.2](https://github.com/getkimchi/kimchi/releases/tag/v1.9.2), preview recording OFF, and the same preview recording ON. All **60 sessions passed**, with no provider errors or paid retries. Every session used GLM-5.3, medium thinking, a 120×40 terminal, the same four reads (one deliberate missing file), then 40 numbered lines. Twenty recordings contained all 80 expected framed tool results.

| Metric | v1.9.2 | Preview OFF | Preview ON |
| --- | ---: | ---: | ---: |
| Mean primary CPU per session | 8.85 s | 8.52 s | 10.04 s |
| Median command peak RAM per session | 316.84 MiB | 329.34 MiB | 336.71 MiB |
| Reported output tokens across 20 sessions | 132,665 | 132,562 | 139,322 |

The same-build observed difference was **+1.52 CPU seconds per session (+17.8%)** and **+7.37 MiB median peak RAM**. Per-round CPU differences were +2.2% and +36.0%. ON produced 5.1% more output tokens and spent 13.0% longer in active work; real reasoning/timing and host load varied. These samples do not establish an exact recorder penalty or universally negligible overhead. The earlier deterministic three-session batches measured about +2% CPU; the different workloads should be assessed separately.

Recording data across 20 ON sessions was 65.51 MiB raw and 9.34 MiB compressed. Allocated space was 9.78 MiB at close and 9.46 MiB on later inspection; logical bytes were unchanged and the difference's cause was not established. This is measured short-session storage, not a five-day extrapolation.

The baseline commit was `c635f5384`; preview `281b1a1a9` also contains two unrelated release differences, so use ON/OFF for the switch comparison. CPU uses the maximum sampled cumulative counter for each owned PID, preserving zero-valued exit samples. Concurrent RAM uses simultaneous snapshots; observed sampling medians were 166–177 ms. Driver/tmux CPU, input latency, slow disks and five-day soak behavior were not measured. Builds, browser tests and encoding were paused during sampling; unrelated host activity remained. The subsequent browser replacement does not change ordinary capture writes. Its Unicode alignment affects part-boundary reconstruction; that and resource-toggle transitions have separate functional checks and were not measured in these runs.

Run focused contracts with `pnpm exec vitest run src/terminal-replay src/utils/export-post-process.test.ts src/utils/export-post-process.redaction.test.ts`. After `pnpm run build:binary`, run `node scripts/run-tui-e2e.js 'session-replay[.]test[.]ts$' --trace`. Anchor the filename: test filters match the complete path, including worktree names.

Run `pnpm exec tsx src/terminal-replay/player.check.ts` with Playwright's installed Chromium to check the exported player in a real browser. This preserves a deliberate duplicate-line defect across retained parts, then verifies clearing, Unicode placement, resize wrapping, controls, transcript scroll, subagent navigation and a downloaded part playing with networking disabled. For an installed Chrome, use `REPLAY_BROWSER_CHANNEL=chrome REPLAY_BROWSER_HEADED=1` before the command. Chrome 155.0.8059.40 in headless mode missed native clicks near the bottom of a sandboxed iframe, including in a minimal page without the player; headed Chrome and Playwright's Chromium 147 did not reproduce that problem.

For real-model evidence, use the bundled `resources/skills/kimchi-tmux/SKILL.md`, an isolated HOME/tmux server and `KIMCHI_BINARY` pointing at this checkout's binary. Capture actual output, export it, open the file offline, test pause/seek/speed/resize, and compare terminal text placement at known times. Keep raw artifacts and temporary credentials out of Git; remove test credentials when done.
