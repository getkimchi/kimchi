# Check PR cost accuracy

Compare a saved `costs.json` with an independent request inventory, billing receipts and human PR labels:

```sh
pnpm exec tsx src/extensions/work-attribution/accuracy-cli.ts report.json reference.json
```

The command reads these two files and prints the differences. It makes no network or model calls, reads no credentials and writes nothing. Keep real receipts and labels outside the repository.

By default, Kimchi saves the report at `~/.config/kimchi/harness/work/<workId>/costs.json`. It contains request rows, PR totals and all six unallocated buckets for that work and every work connected to it. Kimchi refreshes it at most every five minutes per work, and at once when it is missing, so a report saved right after a price arrived can lag `/work` by a few minutes. Works are connected when they contribute to the same PR or when a work link, such as a `/work link` correction, moves requests between them. Connections are transitive: if work A shares a PR with work B, and B shares another PR with work C, A's report also includes C's requests and PR totals. Prepare reference entries for every request in that file. Do not add per-work reports together: connected works repeat the same requests.

## Prepare the reference before inspecting matcher output

Use provider or gateway receipts to list requests, their billing accounts and exact billed prices. Label which PR each request belongs to using the task history and Git evidence. Do not generate this reference from the work summary, `costs.json`, matcher confidence or the allocator under test: that would repeat the same mistakes on both sides.

The version 1 reference has one entry per request:

```json
{
  "version": 1,
  "requests": [
    {
      "requestId": "request-1",
      "account": {
        "apiUrl": "https://api.example.test",
        "organizationId": "11111111-1111-4111-8111-111111111111",
        "userId": "22222222-2222-4222-8222-222222222222"
      },
      "costUsd": "1.000000001",
      "expected": {
        "kind": "pull-request",
        "pullRequestId": "github:github.com/acme/api#7"
      }
    }
  ]
}
```

- `requestId` joins the independent inventory to a recorded request.
- `account` identifies the billing API, organization and API-key owner from independent evidence. Use the recorded API base URL and both UUIDs. Do not copy them from the report or use today's login to fill a gap. The command validates these fields without contacting the provider.
- `costUsd` is the exact billed USD amount as a decimal string, with at most nine fractional digits. Use `null` when the receipt is missing; zero means the request is known to be free.
- `expected` is the human ownership label. Current discovery uses the provider, host and provider's numeric PR ID, encoded as a JSON string: `"[\"github\",\"github.com\",\"12345\"]"`. This is the API's `id`, not the PR number. Older URL-only records use `provider:host/owner/repo#number`, as in the example above; GitLab subgroup paths are allowed. Establish the identity from independent Git provider evidence, using the same key format as the saved report.

These ownership labels keep different cases separate:

| Label | Meaning |
| --- | --- |
| `{"kind":"pull-request","pullRequestId":"github:github.com/acme/api#7"}` | The request belongs exclusively to this merged PR. |
| `{"kind":"shared","pullRequestIds":["github:github.com/acme/api#7","github:github.com/acme/api#8"]}` | Both PRs share the request. Its charge stays in the shared bucket; the check does not divide it. |
| `{"kind":"no-pr","reason":"unlinked"}` | This request should have no PR allocation. `reason` defaults to `unlinked`; use `unmerged` or `post-merge` for those cases. |
| `{"kind":"unknown"}` | The human reviewer cannot decide. The result remains incomplete. |

Repeated labels are errors, even if identical. Conflicting accounts, ownership or prices are reported separately. Missing account evidence, a missing captured request, an unlabelled observed request or a missing price prevents a complete result.

## What gets checked

The report must contain the full `requests`, `pullRequests` and `unallocated` fields produced by the cost calculator. The check compares:

1. Request coverage in both directions, including requests that were never captured.
2. Each request's account and charge against its independent receipt.
3. Request ownership, including the complete shared PR set.
4. Each PR's total, confirmed and inferred portions, and contributing request IDs, plus its shared, inferred and unknown references.
5. The inferred, shared, unlinked, unmerged, post-merge and unknown aggregate buckets.

PR totals use the account and the complete PR key together. Two users billed for the same PR get separate output lines; a charge under the wrong account is a disagreement. Two totals for the same account and PR are malformed evidence.

With priced, exclusively labelled requests and no shared labels, a PR's expected final amount comes from the independent receipts. A reported open or closed state cannot turn that amount into unknown. This includes a known zero.

When no independently labelled request belongs exclusively to a PR, the command checks final totals against the report's provider state. An open or closed PR keeps an unknown final total; a merged PR with only post-merge requests has a known zero exclusive total. Provider state itself is not independently verified by the offline command.

An inferred request with one candidate PR contributes once to that PR's headline total. `explicit` holds confirmed spending and `inferred` holds inferred spending. Both portions must list their own requests and match the independent receipt amounts; a correct headline cannot hide a wrong split. An inferred request with several candidates stays outside each headline because its price has no agreed split.

The `unallocated.inferred` bucket lists all inferred requests, including those already counted in a headline. It is a confidence view, not an extra charge. Each candidate also lists the request in `inferredRequestIds`. The check verifies those lists without treating them as human ownership labels: if a human assigns an inferred request to one PR, its dollars can match while confirmed assignment coverage still counts it as missed. That comparison exits with code 3 and reports the ownership difference.

Amounts use integer arithmetic. The check shows each PR's signed error and the sum of absolute PR errors. Overcharging one PR by USD 1 and undercharging another by USD 1 yields USD 2 of absolute error, not zero. Missing evidence makes full errors unavailable; unknown prices are never displayed as zero-dollar expectations.

A request marked `priced` must have a valid decimal-string `totalCostUsd`. Missing or malformed final amounts make the comparison incomplete. If a valid amount differs from its receipt, the diagnostic names the differing field.

## Read the metrics

**Wrong assignment** divides wrongly assigned spending by all confidently assigned, labelled spending. If USD 1 is assigned correctly and USD 3 of unrelated chat is assigned to a PR, the result is 75% wrong assignment.

**Correct coverage** divides correctly assigned spending by labelled spending expected exclusively on a PR. Inferred, unresolved or shared output misses a label that expects one exclusive PR. A confirmed assignment to the wrong account also misses that label and counts as wrong. Correctly shared requests are checked in their own bucket, outside this exclusive-coverage denominator.

Version 1 weights both metrics by independent receipt prices. The command also prints the same ratios by request count, so free or inexpensive requests remain visible. Zero denominators show `n/a`; incomplete comparisons suppress full percentages. Nine-decimal percentages are truncated, not rounded.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The version 1 reference is complete and all checked report values match. |
| 1 | The command cannot run: wrong arguments, unreadable or invalid JSON, or an unsupported top-level input shape. |
| 2 | Evidence is empty, incomplete or malformed. Known amounts and the missing evidence are listed. |
| 3 | The evidence is complete, but prices, ownership or aggregate totals differ. |

An offline match proves agreement with the supplied reference. It does not establish that human labels are correct or represent ordinary usage. Keep held-out tasks separate from cases used to tune the matcher.

## Older label-only files

The command still accepts the previous array format:

```json
[
  { "requestId": "request-1", "expectedPullRequestId": "github:github.com/acme/api#7" },
  { "requestId": "request-2", "expectedPullRequestId": null }
]
```

This mode checks request ownership and label coverage using the report's own prices. Its output says that accounts, prices and aggregates were not independently checked. It also ignores inferred assignments and does not score PR headlines, so it can exit 0 while a PR total includes inferred spend labelled `null`. Exit 0 means the nonempty comparison is complete and confirmed assignments match the labels; wrong or missed assignments return 3, including zero-cost requests. Empty or incomplete comparisons return 2. Use a version 1 reference to also check accounts, prices, inferred assignments and full PR totals.

The label-only output includes observed, labelled, priced and scored request counts, known report spending, and scored spending. A USD 10 report with only USD 1 labelled is incomplete, including when the unlabelled requests were free.
