# Contributing to Kimchi

Thank you for your interest in contributing to Kimchi! This document outlines the process for contributing and the governance model we follow.

## Contributor License Agreement (CLA)

Before we can accept your contribution, you must agree to the **Kimchi Contributor License Agreement (CLA)**.

- **Why a CLA?** It ensures the project can freely distribute and relicense contributions while protecting both contributors and users. This preserves the option for the project to make future licensing decisions with community notice, without needing to track down every past contributor for consent.
- **How to agree:** Review [CLA.md](CLA.md) in this repository. By opening a pull request, you agree to the terms set out there. We are also working on wiring up CLA Assistant for automated checks.

All contributions — code, documentation, bug reports, design proposals — are welcome once the CLA is acknowledged.

## License

Kimchi is licensed under the **Apache License 2.0**. By contributing, you agree that your contributions will be licensed under the same terms.

## Governance

- CAST AI Group, Inc. stewards Kimchi as the primary maintainer.
- We aim for open, transparent decision-making. Major architectural changes are discussed in issues before implementation.
- We do not plan restrictive license shifts without clear advance notice to the community. If a license change is ever on the roadmap, it will be telegraphed early rather than sprung as a surprise.

## Getting Started

1. Open or find an issue describing the bug or feature.
2. Fork the repo, create a feature branch, and make your changes.
3. Ensure tests pass and code follows the existing style.
4. Open a pull request and complete the CLA check.

## Contribution workflow

1. **Open an issue first.** For anything beyond a typo fix, open an issue and get maintainer acknowledgement before starting work. This avoids duplicated effort and ensures the change aligns with the project direction.
2. **Fork and branch.** Fork the repo and create a feature branch (`feat/your-feature` or `fix/your-fix`).
3. **Keep PRs focused.** One issue per PR. Large PRs are hard to review and slow to merge.
4. **Pass CI.** Run `pnpm run check` and `pnpm run test` locally before opening a PR. PRs that fail CI will not be reviewed.
5. **Fill in the PR template.** Every field in the template exists for a reason. PRs with blank or placeholder descriptions will be closed.

## What we will and won't accept

**Likely to be accepted:**
- Bug fixes with a clear reproduction case
- Performance improvements with benchmark data
- Features that were discussed and approved in an issue first

**Unlikely to be accepted without prior discussion:**
- Large refactors or architectural changes
- New dependencies
- Features that duplicate existing functionality

## Review SLA

We aim to triage new issues within **3 business days** and provide a first review on PRs within **5 business days**. If you haven't heard back, a polite ping on the issue is welcome.

## Code of Conduct

Be respectful, constructive, and assume good intent. We enforce the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
