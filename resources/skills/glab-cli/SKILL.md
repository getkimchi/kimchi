---
name: glab-cli
description: Use the GitLab CLI (`glab`) for MRs, reviews, approvals, issues, releases, and CI pipelines — reading discussions, posting notes, fetching job traces, triaging failures. Prefer `glab` over web URLs.
---

# glab CLI

`glab` is the canonical CLI for GitLab. Prefer it over scraping web URLs or guessing API paths. Discover flags with `glab <cmd> --help` rather than enumerating here.

Auth: `glab auth status`. If logged out, ask the user to run `glab auth login`.

Project: inferred from cwd. Pass `-R OWNER/REPO` (or `GROUP/SUBGROUP/REPO`) when outside.

Terminology: **MR** = merge request, **note** = comment, **discussion** = thread, **pipeline** = CI run, **job** = CI step.

Consent: posting notes/approving, merging, releasing, and any `glab api` write are external actions — explicit user approval first; read-only `glab` commands are fine.

Output: pipeline/job traces and `--paginate` on large result sets are huge — cap with `| tail -N`, `--jq` filters, or per-page fetches. For big MR diffs, list changed paths first (diffs endpoint `--jq '.[].new_path'`), then read targeted files.

## MR review — non-obvious bits

Find MRs awaiting your review: `glab mr list -r @me` (vs `-a @me` for assignee). `glab mr view 123 --unresolved` shows only open threads.

Discussions vs notes — two endpoints:
```bash
glab api projects/:fullpath/merge_requests/123/discussions --paginate   # threaded, line-anchored
glab api projects/:fullpath/merge_requests/123/notes       --paginate   # flat note stream
```

Resolve a discussion (need note ID from the discussions API):
```bash
glab mr note resolve 123 3107030349
```

Inline (line-anchored) review comments — `glab` has no flag yet; use the API:
```bash
glab api projects/:fullpath/merge_requests/123/discussions \
  -X POST \
  -f body="this is wrong" \
  -f position[position_type]=text \
  -f position[base_sha]=BASE_SHA \
  -f position[start_sha]=START_SHA \
  -f position[head_sha]=HEAD_SHA \
  -f position[new_path]=src/foo.py \
  -f position[new_line]=42
```
SHAs come from `glab api projects/:fullpath/merge_requests/123 --jq '.diff_refs'`.

Reply to a specific thread:
```bash
glab api projects/:fullpath/merge_requests/123/discussions/DISCUSSION_ID/notes \
  -X POST -f body="fixed in abc1234"
```

Approve with SHA pinning: `glab mr approve 123 -s abc1234`. MR-create shortcut: `glab mr create -f` fills title/description from commits.

## Pipelines & jobs

`glab ci view` is a **TUI** — never call from a headless harness. Use these instead:

```bash
glab ci trace lint -b feature-x                          # job by name + branch
glab ci trace 224356863                                  # job by ID
glab api projects/:fullpath/jobs/JOB_ID/trace | tail -200 # raw log, capped
glab api projects/:fullpath/pipelines/12345/jobs --jq '.[] | {id,name,status}'
```

Bare `glab ci trace` (no args) is also interactive — avoid.

## `glab api` cheatsheet

- `-f key=val` — string field
- `-F key=val` — typed (numbers, booleans, null)
- `-X METHOD` — HTTP verb
- `-H "Header: val"` — request header
- `--paginate` — follow all pages
- `--jq '.field'` — filter response
- placeholders: `:fullpath`, `:repo`, `:group`, `:namespace`, `:branch`, `:user`, `:username`, `:id`
