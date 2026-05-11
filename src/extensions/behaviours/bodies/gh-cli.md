---
name: gh-cli
description: Use the GitHub CLI (`gh`) for pull request review (as reviewer or author), workflow run troubleshooting, and general GitHub operations. Use when interacting with PRs, reviews, comments, CI checks, GitHub Actions runs, issues, or releases — including reading inline review comments, posting reviews, fetching CI logs, or triaging failures.
---

# gh CLI

`gh` is the canonical interface for GitHub. Prefer it over scraping web URLs or guessing API paths. Discover flags with `gh <cmd> --help` rather than enumerating here.

Auth: `gh auth status`. If logged out, ask the user to run `gh auth login`.

Repo: inferred from cwd. Pass `-R OWNER/REPO` when outside the repo.

## PR review — non-obvious bits

Find PRs awaiting your review: `gh pr list --search "review-requested:@me"`.

Existing review state — two endpoints, easy to confuse:
```bash
gh api repos/OWNER/REPO/pulls/123/comments  --paginate   # inline, line-anchored
gh api repos/OWNER/REPO/issues/123/comments --paginate   # PR-level conversation
```

Post inline comments in one review (line-anchored, multi-comment) — no `gh pr review` flag for this; use the API:
```bash
gh api repos/OWNER/REPO/pulls/123/reviews -f event=COMMENT \
  -f body="overall notes" \
  -F 'comments[][path]=src/foo.py' -F 'comments[][line]=42' \
  -F 'comments[][body]=this is wrong because…'
```

Resolve a review thread (GraphQL):
```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=THREAD_NODE_ID
```

Reply to a specific inline thread:
```bash
gh api repos/OWNER/REPO/pulls/123/comments/COMMENT_ID/replies -f body="fixed in abc1234"
```

Top-level review verbs: `gh pr review <N> --approve|--request-changes|--comment -b "…"` (see consent section before posting).

## Workflow runs

Default to **failed-only** logs, never the full log:
```bash
gh run view 123456 --log-failed          # preferred
gh run view 123456 --log | tail -200     # only if --log-failed isn't enough
```

Find the run behind a PR's latest push: `gh pr checks 123 --json name,state,link,workflow`.

## `gh api` cheatsheet

- `-f key=val` — string param
- `-F key=val` — typed (numbers, booleans, `@file`)
- `-X METHOD` — HTTP verb
- `--jq '.field'` — filter response
- `--paginate` — follow `Link` headers

## Never without explicit consent

Anything that publishes, mutates, or notifies needs an explicit in-conversation request. Do **not** run these unprompted:

- Posting to a PR/issue: `gh pr review` (any of `--approve`, `--request-changes`, `--comment`), `gh pr comment`, `gh issue comment`, posts via `gh api .../comments` or `.../reviews`.
- State changes on PRs: `gh pr merge` (any flags), `gh pr close`, `gh pr reopen`, `gh pr ready` (and `--undo`), `gh pr edit`.
- CI: `gh run rerun`, `gh run cancel`.
- Issues: `gh issue close`, `gh issue reopen`, `gh issue edit`, `gh issue delete`.
- Releases: `gh release create`, `gh release edit`, `gh release delete`.
- Any `gh api -X POST/PATCH/PUT/DELETE` that mutates state, including resolving review threads.
- Git remote ops: pushing branches, force-push, deleting branches/tags.

Read-only commands (`list`, `view`, `diff`, `checks`, `status`, `gh api` GETs) are fine. When in doubt, surface the command and wait.

## Output discipline

- `gh run view --log` is huge — `--log-failed` or `| tail -N`.
- `gh api ... --paginate` can be massive — add `--jq`.
- `gh pr diff` on big PRs — `--name-only` first, then targeted reads.
