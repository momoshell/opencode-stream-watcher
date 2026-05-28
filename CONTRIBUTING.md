# Contributing

Thanks for your interest. This project is small and scoped — please read the relevant doc before opening a PR.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) — conventions, file layout, what NOT to add. Applies to humans and AI assistants both.
- Read [`docs/DESIGN.md`](docs/DESIGN.md) — the design rationale.
- Pick a [good-first-issue](https://github.com/momoshell/opencode-stream-watcher/labels/good-first-issue) if you're new.

## Development setup

Requires [Bun](https://bun.sh/) for build and dev. (opencode itself uses Bun internally.)

```bash
git clone git@github.com:momoshell/opencode-stream-watcher.git
cd opencode-stream-watcher
bun install
bun run typecheck
bun run build
```

## Live testing inside opencode

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf "$(pwd)/dist/plugin.js" ~/.config/opencode/plugins/stream-watchdog.js
```

Restart opencode. The plugin loads on startup. Edit, rebuild, restart opencode to pick up changes.

To reproduce a stall, follow [`scripts/stall-fixture.md`](scripts/stall-fixture.md) *(coming in v0.1)*.

## Workflow

1. Find an open issue, comment to claim it.
2. Branch: `feat/<short-desc>` or `fix/<short-desc>`.
3. Implement the issue's acceptance criteria. Nothing more.
4. Update CHANGELOG if user-visible behavior changed.
5. Push, open PR with `Closes #N` in the body.
6. CI must be green.

## Code style

- TypeScript strict mode, no `any`.
- No `console.log` — use `client.app.log`.
- One file per concern (see `AGENTS.md` for the layout).
- No commented-out code in committed files.

## Commit messages

- Imperative present tense: "add WARN toast" not "added".
- Body explains *why*, diff explains *what*.
- One logical change per commit.

## PR review

- Small PRs get reviewed faster.
- Diffs over ~300 lines should be split unless the issue is genuinely indivisible.
- Reviews come from the maintainer. AI-assisted reviews are welcome as additional input but don't replace the human gate.

## Releases

Maintainer-only.

Prerequisites:

- The release commit is already on `main`.
- The repo-level `NPM_TOKEN` secret is configured for the GitHub Actions publish step.
- Maintainer approval is given before pushing the first release tag (`v0.1.0`).

Release flow:

1. Confirm the release commit and docs are merged to `main`.
2. Create and push a tag in `vX.Y.Z` format from `main` (for this release: `v0.1.0`).
3. GitHub Actions runs `release.yml` and publishes to npm.

Do not claim the npm token can be verified locally; publication depends on the repo secret in GitHub.

## Reporting issues

Use the bug or feature templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Include the opencode version, the plugin version, and the relevant lines from `~/.local/share/opencode/log/`.

## License

By contributing, you agree your contributions are MIT-licensed.
