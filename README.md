# agent-skills

Agent skills of the [dapr-cn](https://github.com/dapr-cn) organization. Each skill is a top-level folder with a `SKILL.md`.

| Skill | Purpose |
| --- | --- |
| [`dapr-docs-translation`](dapr-docs-translation/SKILL.md) | Resumable translation of whole Markdown/MDX documents with durable per-repo state, driven by a main session plus cheap-model subagents. `scripts/tr.mjs` scaffolds a repo (`init`), classifies new/stale/drift/edited/orphan documents and picks batches (`scan`), adopts existing translations as a baseline (`adopt`), writes self-contained subagent jobs (`next`), checks/assembles/finalizes drafts, merges glossary candidates and reports completeness (`status`). Repository facts live in the target repository's `profile.yaml`. |
| [`dapr-docs-translate-incremental`](dapr-docs-translate-incremental/SKILL.md) | Daily incremental translation of an already bootstrapped Dapr docs version: sync the sources, pick the pending backlog with the engine, check completeness, and commit only `translations/` and `translated_content/` (dry run by default for the commit). |
| [`dapr-docs-translation-verify`](dapr-docs-translation-verify/SKILL.md) | Read-only gate before publishing or opening a PR: runs `status --verify`, the zh data audit and the docs verify dry run, and reports `canOpenPr` with the reasons and a `verdict.json` for the upstream step. |
| [`dapr-docs-version-bootstrap`](dapr-docs-version-bootstrap/SKILL.md) | First-time bootstrap of a new `vX.Y`: detects the previous translated version, registers the repositories in monospecs, cuts `vX.Y_content` from it (never `adopt`), writes the profile and `release.yaml`, and reports fresh, stale and new counts. Dry run by default, each step confirmed on its own. |
| [`dapr-docs-upstream-pr`](dapr-docs-upstream-pr/SKILL.md) | Offers a verified translation upstream in two confirmed stages: pushes `vX.Y_content` to `dapr/docs-zh`, then prepares and opens the pull request for `dapr/docs` from `repos/fork-docs`. Requires a fresh passing gate verdict; never force-pushes. |

The skill was copied from the `doc-translation` skill of `newbe36524/personal-agent-skills` and renamed.

## Tests

```bash
npm test
```
