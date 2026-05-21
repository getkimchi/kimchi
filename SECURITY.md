# Security Policy

## Reporting a Vulnerability

We take security issues seriously. If you discover a vulnerability, please report it responsibly through [GitHub Private Vulnerability Reporting](https://github.com/castai/kimchi/security/advisories/new) for this repository. This allows us to coordinate a fix before disclosing details publicly.

When reporting, please include as much of the following as possible:

- Affected version or specific commit hash
- Description of the vulnerability and its impact
- Steps to reproduce the issue
- Suggested fix or mitigation (if any)
- Optionally: proof-of-concept or simple reproduction case

We are committed to responding within the timelines below.

## Response Timeline

| Stage                      | Commitment                                                   |
|----------------------------|--------------------------------------------------------------|
| Acknowledgment             | Within **3 business days** of report confirmation            |
| Initial investigation      | Within **7 business days** of acknowledgment                 |
| Fix development & testing  | Depends on complexity; we aim for the shortest reasonable time |
| Coordinated disclosure     | Fix shipped before or alongside public disclosure            |

We will keep you informed of our progress throughout the process. If the timeline changes, we will communicate the updated estimate.

## Supported Versions

Kimchi is currently in early development (`0.0.0`). Until a stable release is published, **the latest commit on the `main` branch is the only supported version**.

| Version  | Supported          |
|----------|--------------------|
| `0.0.0` (latest `main`) | :white_check_mark: |
| Older commits / branches | :x:                |

## Responsible Disclosure

- **No public disclosure before a fix is available.** Please do not discuss the vulnerability in public issues, forums, or social media until we have had a reasonable opportunity to address it.
- **Act in good faith.** Do not exploit the vulnerability beyond what is necessary to demonstrate the issue during responsible disclosure.
- **Allow reasonable time for resolution.** If a fix is not addressed within the timelines above, feel free to follow up via the reporting channel.

## Security Best Practices for Users

To reduce your exposure to security risks when using Kimchi:

- **Keep the CLI updated.** Run `pnpm update -g @kimchi-dev/cli`, or reinstall from official sources regularly.
- **Verify binary checksums.** When downloading pre-built binaries from GitHub Releases, compare the published SHA-256 checksum (found in the corresponding GitHub Release notes) with the file you downloaded.
- **Install only from official sources.** Use [GitHub Releases](https://github.com/castai/kimchi/releases) or the official npm registry (`@kimchi-dev/cli`). Avoid unofficial mirrors or distribution channels.
- **Review `.envrc` and local configuration.** As with any CLI that reads environment or configuration files, audit the contents before running Kimchi in your environment.

## Acknowledgments

We sincerely appreciate the security research community's efforts to keep Kimchi and its users safe. Researchers who report valid vulnerabilities will be credited by name (or pseudonym, at their preference) in the relevant GitHub Security Advisory, unless they request otherwise.

Thank you for helping us maintain a secure project.