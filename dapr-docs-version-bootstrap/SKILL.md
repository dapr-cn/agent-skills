---
name: dapr-docs-version-bootstrap
description: 'First-time bootstrap of a new Dapr docs version vX.Y for the Chinese translation workflow. Use when a new upstream docs branch (dapr/docs vX.Y) appears and its translation repository has no vX.Y_content branch yet: detect the previous translated version, register repos/vX.Y and repos/vX.Y_zh in monospecs, cut vX.Y_content from the previous _content branch so translations, glossary and baselines come along, write the new profile and release.yaml, and report fresh, stale and new counts. Use for "引导新版本", "新版本首次翻译", "bootstrap v1.18", "创建 vX.Y_content". Dry run by default; every step is confirmed on its own; it never uses adopt.'
---

# dapr-docs-version-bootstrap

为新的 `vX.Y` 做首次引导。它把新版本接入翻译流程:登记仓库、从上一版的译文分支切出 `vX.Y_content`、写新的 profile 与 `release.yaml`、盘点初始状态。

## 什么时候用

- 上游 `dapr/docs` 已有 `vX.Y` 分支,而译文仓库 `dapr/docs-zh` 还没有 `vX.Y_content`。
- 要为该版本做第一次引导(之后的日常翻译用 `dapr-docs-translate-incremental`)。

不用于:日常增量翻译、发布前检查、向上游提交译文。

## 输入

- `--version vX.Y`(必填):要引导的版本。
- `--previous vP`(可选):上一版。缺省时自动探测:译文远端中比目标小、且存在 `vP_content` 分支的最大版本。指定时必须存在该分支。
- `--source-url`、`--zh-url`(可选):上游与译文仓库的 URL。缺省取 `.hagicode/monospecs.yaml` 中最新版本的 `repos/vX.Y`、`repos/vX.Y_zh` 条目。
- `--mono-root`、`--engine`:同其他技能。

不写死任何版本或 URL:版本分支由 `git ls-remote --heads` 探测,只识别 `^v(\d+)\.(\d+)$`(上游)与 `^v(\d+)\.(\d+)_content$`(译文),按数值排序;`new_content_vX.Y` 等旧命名被忽略。

## 步骤

| 步骤 | 类型 | 内容 | 完成判定 |
| --- | --- | --- | --- |
| S0 | read | `git ls-remote --heads` 探测两个远端,确定上一版 | 总是完成 |
| S1 | local-write | 克隆 `repos/vX.Y`(分支 `vX.Y`) | `repos/vX.Y/.git` 存在 |
| S2 | local-write | 克隆 `repos/vX.Y_zh`,分支为上一版的 `vP_content` | `repos/vX.Y_zh/.git` 存在 |
| S3 | branch-create | 在 `repos/vX.Y_zh` 中 `git switch -c vX.Y_content` | 本地分支存在 |
| S4 | local-write | 在 `.hagicode/monospecs.yaml` 末尾追加 `repos/vX.Y` 与 `repos/vX.Y_zh`(`optional: true`,URL 取自上一版条目) | 两个条目都存在 |
| S5 | local-write | 更新 profile 的版本字段,写入 `release.yaml`,只提交这两个文件 | profile 指向新版本且 `release.yaml` 为新版本 |
| S6 | local-write | `zh:data:sync`,再 `tr.mjs scan --json`,报告 fresh / stale / new | 不标记完成(可重复运行) |
| S7 | public-push | 普通推送 `vX.Y_content` 到译文远端(从不 `--force`) | 远端分支与本地 HEAD 相同 |

- 步骤按顺序进行,每一步依赖前一步完成。`plan` 显示每一步的完成状态,中断后重新运行会跳过已完成的步骤。
- 目标的上游分支不存在、上一版无法确定、远端已有 `vX.Y_content` 而本地没有克隆时,计划停止并说明原因,不执行任何步骤。

## 默认 dry-run 与逐步确认

```bash
# 只输出计划:步骤、完成状态与每一步的计划哈希
node repos/agent-skills/dapr-docs-version-bootstrap/scripts/bootstrap.mjs plan --version v1.18

# 查看某一步会做什么(不执行)
node …/bootstrap.mjs apply --version v1.18 --step S3

# 确认并执行这一步:哈希必须与当前计划一致
node …/bootstrap.mjs apply --version v1.18 --step S3 --execute --confirm <hash>
```

- 默认只做 `ls-remote` 探测,仓库、分支与 monospecs 全部不变。
- `--execute` 只运行 `--step` 指定的那一步,其余步骤不会运行。
- `--confirm` 必须等于该步骤在当前仓库状态下重新计算的哈希。哈希覆盖步骤编号、远端、分支、目标提交、命令和输入文件的内容,所以远端分支一动、或计划之后文件被改,旧的确认值都会被拒绝(退出码 3)。
- 历史记录、运行日志、环境变量、上一次的输出都不能当作确认。确认值只能来自本次调用的命令行。
- S7 推送需要它自己的确认。通常由 `dapr-docs-upstream-pr` 阶段 A 完成推送。

退出码:`0` 成功或 dry run;`1` 计划停止、前置步骤未完成或步骤失败;`2` 用法或配置错误;`3` `--confirm` 与计划不一致。

## 为什么不用 adopt

`tr.mjs adopt` 把已有译文记为基线,但被采纳的文档没有基线源文副本,以后源文一变只能整篇重译。从上一版的 `vP_content` 切出新分支,`translations/`(台账、术语表、基线副本)与 `translated_content/` 一次带全,并保留历史,`scan` 才能正确判断 `stale`。计划里不会出现 `adopt`。

## release.yaml 与 profile.yaml

- `profile.yaml` 只改版本相关字段:`repo`,以及 `sources.description` 中的版本号。`priority`、`budgets`、`rules` 等人工设置原样保留。schema 不变。
- `translations/release.yaml`:如果已存在且 `version` 就是 `vX.Y`,保持不变。否则从继承的文件(若有效)取 `upstreamPr.forkDocs` 各字段,生成新版本的文件,`version`、`previousVersion`、`upstreamBranch` 设为新版本。生成后会校验结构,缺字段则失败。已有人工维护的同版本文件绝不覆盖。

## 报告

S6 完成后报告 `fresh`、`stale`、`new` 三类数量,与 `tr.mjs scan --json` 的 `summary` 一致。

## 文件清单

- `scripts/bootstrap.mjs`:`plan`、`apply`,以及 S0 到 S7 的执行。
- `scripts/branches.mjs`:`ls-remote` 解析、版本排序、上一版选择(纯函数)。
- `scripts/monospecs-edit.mjs`:文本追加 monospecs 条目,保留原文(幂等)。
- `scripts/lib/`:`yaml.mjs`、`config.mjs`、`git.mjs`、`guard.mjs`(与其他技能的拷贝逐字相同)。
- 测试:`tests/dapr-docs-version-bootstrap/`。

## 前置工具

Node.js、pnpm、git,以及对上游和译文远端的访问权限。
