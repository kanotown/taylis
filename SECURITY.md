# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately, either

- through GitHub's private vulnerability reporting (the repository's **Security** tab → "Report a vulnerability"), or
- by email to **kanotown@gmail.com**.

Include what is affected (server, a client, the deployment scripts), the version or commit, steps to reproduce and the
impact you expect. You will get an acknowledgement when the report has been read. This is a personal project, so
there is no guaranteed response time, but security reports are handled before anything else.

Please give a reasonable amount of time for a fix before disclosing the issue publicly.

## Supported versions

Only the **latest release** (the newest `v*` tag and the official client builds made from it) receives security
fixes. Self-hosted servers should be kept on the latest release.

## Scope

In scope: the server (`server/`), the clients (`apps/`), and the deployment files and scripts (`infra/`, `.github/`).
The design-level security model is described in [docs/SECURITY.md](docs/SECURITY.md).

Out of scope: problems that need an already-compromised server, database or backup (operators can read all data by
design, see the README), and vulnerabilities in third-party dependencies that are not exploitable through Taylis
(report those upstream).
