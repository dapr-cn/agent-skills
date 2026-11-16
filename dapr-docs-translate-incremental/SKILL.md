---
name: dapr-docs-translate-incremental
description: 'Daily incremental translation run for a Dapr docs version that is already bootstrapped (its translations/ and profile.yaml exist). Use when a scheduled or manual run must bring the Chinese docs of an existing vX.Y up to date: sync the source documents, pick the pending backlog with the dapr-docs-translation engine, translate it, check completeness, and commit only translations/ and translated_content/. Use it for "daily translation", "增量翻译", "每日翻译", "翻译待办", "同步源文后翻译". Not for a new version (use dapr-docs-version-bootstrap), not for pre-PR checks (use dapr-docs-translation-verify), and never pushes or creates branches.'
---

# dapr-docs-translate-incremental

每日增量翻译。它把「同步源文 → 盘点 → 翻译 → 核对 → 提交译文」固定成五步,确定性的部分由 `scripts/incremental.mjs` 完成,翻译本身由主会话按 `dapr-docs-translation` 引擎的流程驱动。

## 什么时候用

- 版本已经引导过(对应 `repos/vX.Y_zh/translations/profile.yaml` 存在),要做日常的增量翻译。
- 定时任务或手动运行,没有人回答问题;中断后可以从头再跑,已完成的文档不会重译。

不用于:新版本的首次引导(用 `dapr-docs-version-bootstrap`)、发布前或开 PR 前的只读检查(用 `dapr-docs-translation-verify`)、向上游提交(用 `dapr-docs-upstream-pr`)。

## 输入

- `--version vX.Y`:目标版本。省略时从 `<zh 仓库>/translations/release.yaml` 读取;两者都没有就报错退出,不会使用任何内置版本。
- `--zh-repo`:译文仓库,相对 mono 根。缺省为 `repos/<version>_zh`。
- `--mono-root`:mono 根。缺省从当前目录向上查找含 `.hagicode/monospecs.yaml` 的目录。
- `--engine`:引擎目录。缺省为本技能同级的 `dapr-docs-translation`。
- 仓库的 URL 与分支只来自 `.hagicode/monospecs.yaml`;脚本不写死任何版本或分支。

## 五步流程

| 步骤 | 做什么 | 命令 |
| --- | --- | --- |
| 1 | 同步仓库 | `pnpm run sync:repos` |
| 2 | 同步源文(只有这一步写 `data/`) | `pnpm run zh:data:sync --version <v> --source-repo <src> --zh-repo <zh>` |
| 3 | 盘点待办 | `node <engine>/scripts/tr.mjs scan --profile <zh>/translations/profile.yaml --source-root data/source --json` |
| 4 | 翻译待办(主会话) | 按 `dapr-docs-translation/SKILL.md` 的 `next` → subagent 翻译 → `check` → `finalize` |
| 5 | 核对完成度 | `node <engine>/scripts/tr.mjs status --profile … --source-root …` |

- `--source-root` 来自 profile 的 `sources.glob.root`,写成相对译文仓库的路径(`tr.mjs` 按译文仓库解析它),不是硬编码路径。
- 任一步以非零退出码结束(或根本无法启动),后续步骤都不再运行,报告指出失败的步骤。第 2 步失败时不盘点、不翻译、不提交。
- 第 3 步的待办为空时报告「无待办」,跳过第 4 步,仍然运行第 5 步。

## 脚本用法

```bash
# 只输出计划(不执行任何步骤)
node repos/agent-skills/dapr-docs-translate-incremental/scripts/incremental.mjs plan --version vX.Y

# 第一段:步骤 1 到 3
node …/incremental.mjs run --phase pre --version vX.Y
# (主会话按第 4 步翻译待办)
# 第二段:步骤 5
node …/incremental.mjs run --phase post --version vX.Y

# 提交:默认 dry-run,只列出将要提交的路径与命令
node …/incremental.mjs commit --version vX.Y
node …/incremental.mjs commit --version vX.Y --execute
```

退出码:`0` 成功;`1` 某一步失败,或提交被拒;`2` 用法或配置错误。

## 提交的范围

- 只提交 `translations/` 与 `translated_content/` 下有改动的路径。提交用 `git add -A -- <path>` 暂存这些路径,再用 `git commit -m <prefix> -- <path>` 只提交它们,提交信息前缀取 profile 的 `commit.messagePrefix`。
- 没有改动时不创建空提交。
- `data/`、`site/`、`scripts/` 等其他改动不会被提交,在输出中列出。`data/` 是 `zh:data:sync` 的产物,需要人工单独提交。
- 不使用 `--no-verify`,不推送,不创建分支,不 `git stash`、`git reset`、`git checkout`。

## 规则

- 不使用 `tr.mjs adopt`:采纳的译文没有基线源文副本,以后只能整篇重译。
- 翻译阶段只写 profile 声明的 `writeScope`(`translations/`、`translated_content/`);`data/`、`site/`、`scripts/` 为只读。
- 翻译后的完成度以第 5 步 `status` 为准;未完成的文档留给下次运行。
- 脚本不替你确认任何东西。提交默认 dry-run,`--execute` 只在本次调用中生效。

## 文件清单

- `scripts/incremental.mjs`:`plan`、`run --phase pre|post`、`commit`。
- `scripts/lib/`:`yaml.mjs`、`config.mjs`、`git.mjs`(与其他技能的拷贝逐字相同,由 `tests/shared-lib-sync.test.mjs` 保证)。
- 测试:`tests/dapr-docs-translate-incremental/`。

## 前置工具

Node.js、pnpm、git。翻译阶段还需要引擎所需的环境(见 `dapr-docs-translation/SKILL.md`)。
