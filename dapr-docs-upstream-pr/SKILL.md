---
name: dapr-docs-upstream-pr
description: 'Offers a verified Chinese translation of a Dapr docs version upstream, in two confirmed stages. Use after dapr-docs-translation-verify passed for the version, when the translations must be pushed to dapr/docs-zh and a pull request prepared or opened against dapr/docs: "向上游提交译文", "开 PR 到 dapr/docs", "提交译文 PR", "推送 vX.Y_content", "open the upstream PR". Default is a plan; stage A pushes the translation branch, stage B moves the fork to the pushed commit, builds, and prepares the PR; each push and each PR creation needs its own confirmation. It never force-pushes and never merges a diverged branch.'
---

# dapr-docs-upstream-pr

把通过验证的译文向上游提交。它分两个阶段,每一次推送或建 PR 都需要单独的确认。

## 什么时候用

- `dapr-docs-translation-verify` 对该版本给出了 `canOpenPr: true` 的结论(`verdict.json`),并且结论仍然新鲜。
- 要把 `vX.Y_content` 推到 `dapr/docs-zh`,并准备或开出面向 `dapr/docs` 的 PR。

不用于:翻译(用 `dapr-docs-translate-incremental`)、检查(用 `dapr-docs-translation-verify`)、引导新版本(用 `dapr-docs-version-bootstrap`)。

## 前置条件

1. 一份新鲜且通过的闸门结论。`checkGate` 要求:`canOpenPr` 为 true;`headCommit` 等于译文仓库当前 HEAD;`statusDigest` 与当前工作区状态一致;`generatedAt` 在 `--max-age-minutes`(默认 30)之内;版本与仓库与参数一致。任一条件不满足,只输出拒绝原因,不输出任何确认值。
2. `translations/release.yaml` 有效,其 `upstreamPr.forkDocs` 给出 fork 路径、子模块路径、上游 URL 与上游分支。
3. 工具:Node.js、git、`gh`(已登录)、Hugo 与 `npm`(B3 的构建需要)。缺少任何一个,对应步骤失败并停止,不会退回到别的做法。

## 两个阶段

| 步骤 | 类型 | 做什么 |
| --- | --- | --- |
| A1 | 公开推送 | 普通推送 `vX.Y_content` 到译文远端(`dapr/docs-zh`,地址取自 monospecs)。从不 `--force`。 |
| A2 | 公开 PR(可选) | 只有给了 `--zh-pr-base` 才出现。在 `dapr/docs-zh` 上开 PR,需要单独确认。 |
| B1 | 本地写 | 在 `repos/fork-docs` 确保有指向上游的 `upstream` 远端,抓取上游分支,只做快进(`git update-ref`,旧值必须是新值的祖先)。分叉时停止,不合并、不重置。 |
| B2 | 本地写 | 从上游分支切出工作分支 `translations-vX.Y`,初始化 `translations/docs-zh` 子模块,在子模块里检出 A1 推送的提交,然后只提交子模块这一项。 |
| B3 | 本地写 | `npm ci && npm run build`。成功后把 PR 标题与描述写入 `--out`。构建失败就停,不写草稿,不推送。 |
| B4 | 公开推送 | 把工作分支普通推送到 fork(`repos/fork-docs` 的 origin)。需要单独确认。 |
| B5 | 公开 PR | 在 `dapr/docs` 上开 PR:base 是上游分支,head 是 `fork-owner:translations-vX.Y`。需要单独确认。 |

- 阶段 A 只包含 A1。阶段 B 包含 B1 到 B3,只有在 A1 已经完成(目标提交已经在 `dapr/docs-zh` 远端上)时才会开始。
- 四步 PR 流程(快进、切子模块、构建、起草 PR)由本技能定义。`fork-docs` 的 README 没有对应的小节,不要依赖它的文字。

## 脚本用法

```bash
# 只输出计划、各步骤的哈希与阶段哈希;闸门未通过时只输出拒绝原因
node repos/agent-skills/dapr-docs-upstream-pr/scripts/upstream-pr.mjs plan --version v1.18 --gate <scratchpad>/verdict-v1.18.json

# 阶段 A:dry run,然后用阶段哈希确认
node …/upstream-pr.mjs apply --version v1.18 --gate verdict.json --stage A
node …/upstream-pr.mjs apply --version v1.18 --gate verdict.json --stage A --execute --confirm <stage-A-hash>

# 阶段 B 的本地步骤(B1 到 B3),需要 --out 收 PR 文本
node …/upstream-pr.mjs apply --version v1.18 --gate verdict.json --stage B --out <scratchpad>/pr-v1.18 --execute --confirm <stage-B-hash>

# B4 与 B5 各自单独确认
node …/upstream-pr.mjs apply --version v1.18 --gate verdict.json --step B4 --out <scratchpad>/pr-v1.18 --execute --confirm <B4-hash>
node …/upstream-pr.mjs apply --version v1.18 --gate verdict.json --step B5 --out <scratchpad>/pr-v1.18 --execute --confirm <B5-hash>
```

退出码:`0` 成功或 dry run;`1` 闸门拒绝、前置步骤未完成、步骤失败或分叉;`2` 用法或配置错误;`3` `--confirm` 与计划不一致。

## 确认的规则

- 默认只出计划。`--execute` 必须与 `--confirm` 一起给出,且确认值等于当前计划的哈希(阶段哈希或步骤哈希)。
- 哈希覆盖步骤编号、远端、分支、目标提交与命令。阶段 B 的确认不会覆盖 B4 或 B5;阶段 A 的确认不会覆盖阶段 B。
- 历史记录、先前的计划输出、环境变量都不能当作确认。确认只能来自本次调用的命令行。
- 闸门结论过期、目标提交变了、工作区状态变了,旧的确认值都会被拒绝。

## 安全边界

- 推送都是普通推送。远端分支不是本地分支的祖先时,推送被拒绝并报告,不尝试强制推送。
- 快进只允许在 `repos/fork-docs` 的上游分支上进行;分叉时停止,不合并、不重置。
- B3 构建失败时不写 PR 文本,也不推送到 fork。

## 文件清单

- `scripts/upstream-pr.mjs`:`checkGate`(闸门新鲜度)、`buildPlan`、`apply`、CLI。
- `scripts/lib/`:`yaml.mjs`、`config.mjs`、`git.mjs`、`guard.mjs`(与其他技能的拷贝逐字相同)。
- 测试:`tests/dapr-docs-upstream-pr/`(本地裸仓库夹具,fork 的子模块由本地路径提供)。

## 前置工具

Node.js、git、`gh`(已登录,有 `dapr/docs` 的 PR 权限)、Hugo 与 `npm`。
