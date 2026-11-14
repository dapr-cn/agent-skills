# agent-skills

Agent skills of the [dapr-cn](https://github.com/dapr-cn) organization. Each skill is a top-level folder with a `SKILL.md`.

| Skill | Purpose |
| --- | --- |
| [`dapr-docs-translation`](dapr-docs-translation/SKILL.md) | Resumable translation of whole Markdown/MDX documents with durable per-repo state, driven by a main session plus cheap-model subagents. `scripts/tr.mjs` scaffolds a repo (`init`), classifies new/stale/drift/edited/orphan documents and picks batches (`scan`), adopts existing translations as a baseline (`adopt`), writes self-contained subagent jobs (`next`), checks/assembles/finalizes drafts, merges glossary candidates and reports completeness (`status`). Repository facts live in the target repository's `profile.yaml`. |

The skill was copied from the `doc-translation` skill of `newbe36524/personal-agent-skills` and renamed.

## Tests

```bash
npm test
```
