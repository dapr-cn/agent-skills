---
name: dapr-docs-translation-verify
description: 'Read-only verification gate before a translated Dapr docs version is offered upstream or published. Use before opening a pull request or publishing translations, when someone asks "can we open the PR", "发布前检查", "开 PR 前检查", "能不能提交到上游", or wants the translation status verified. It runs the status check with verify and fail-on, the zh data audit and the docs verify dry run, then reports canOpenPr with the reasons. It only reads: it never commits, pushes, branches or repairs anything.'
---

# dapr-docs-translation-verify

发布前或开 PR 前的只读检查。它运行三项检查,看译文仓库里「将被提交的内容」是否都在允许范围内,然后给出 `canOpenPr` 与原因,并把结论写成 `verdict.json` 供 `dapr-docs-upstream-pr` 校验。

## 什么时候用

- 译文要向上游提交之前(`dapr-docs-upstream-pr` 要求一份新鲜且通过的结论)。
- 想知道某个版本的译文现在能不能发布,要一个说得清原因的结论。

不用于:翻译本身(用 `dapr-docs-translate-incremental`)、引导新版本(用 `dapr-docs-version-bootstrap`)。

## 三项检查

| 检查 | 命令(在 mono 根运行) |
| --- | --- |
| `status-verify` | `node <engine>/scripts/tr.mjs status --profile <zh>/translations/profile.yaml --source-root data/source --verify --fail-on stale,failed,blocked,orphan,drift,glossary` |
| `zh-data-audit` | `pnpm run zh:data:repair --mode audit --version <v> --repo <zh>` |
| `docs-verify` | `pnpm run docs:verify --dry-run --version <v> --source-repo <src> --zh-repo <zh>` |

- 版本、仓库路径都显式传入,相对 mono 根;不依赖各命令自己的默认值。
- 三项都运行,即使前一项失败也继续,每一项的退出码和原因都记录下来。

## 判定

- **fail**:某项检查退出非零;某项检查根本没有启动(没有退出码,例如缺少 `pnpm` 或 Hugo);工作区或暂存区里有 `writeScope`(`translations/`、`translated_content/`)之外的改动。
- **blocked**:改动落在 `syncOutputPaths`(通常是 `data/`)里,原因是「同步产物需单独人工提交」;或者某项检查运行期间改写了仓库(闸门前后各取一次 `git status` 快照,比较后发现变化)。
- **pass**:以上都没有。只有 pass 时 `canOpenPr` 为 `true`。

`fail` 与 `blocked` 同时出现时结论为 `fail`,两条原因都会列出。

## 闸门没过之后

本技能只读,不修。结构校验失败时,修复用引擎的命令(在译文仓库里写 `translated_content/` 与 `translations/`,不在这里做):

1. `tr.mjs triage --profile … --source-root data/source --out-dir <译文仓库之外>`:把失败分成 `auto`、`retranslate`、`review` 并写清单。
2. `tr.mjs fix-punctuation …`(与 `fix-anchors`):`auto` 类和锚点由脚本确定性修复。
3. `tr.mjs requeue --triage retranslate`:结构对不上的译文送回待办,由增量翻译技能重译。
4. `review` 类由人读后决定:有意的修改就保留,错误就 `requeue --only-from` 重译。

之后重新运行本闸门。

## 脚本用法

```bash
# 只列出将运行的命令,不运行任何东西
node repos/agent-skills/dapr-docs-translation-verify/scripts/gate.mjs plan --version vX.Y

# 运行三项检查并输出结论;--out 写入 verdict.json(必须在译文仓库之外)
node repos/agent-skills/dapr-docs-translation-verify/scripts/gate.mjs run --version vX.Y --out <scratchpad>/verdict-vX.Y.json
```

退出码:`0` canOpenPr 为 true;`1` 闸门未通过(fail 或 blocked);`2` 用法或配置错误(例如找不到版本)。

## 结论的内容

`verdict.json` 包含:`canOpenPr`、`verdict`(pass / fail / blocked)、`reasons`、每项检查的 `command`、`exit`、`verdict` 与 `stderr` 尾部、`scope`(写入范围内、同步产物、范围外三类路径)、`version`、`repo`、`headCommit`(译文仓库当前 HEAD)、`statusDigest`(工作区状态摘要)、`generatedAt`。上游提交技能用 `headCommit`、`statusDigest` 和 `generatedAt` 判断结论是否仍然新鲜。

## 规则

- 闸门自身只读:不修改工作区、索引或引用,不提交、不推送、不建分支、不 `git stash`、`git reset`、`git checkout`。
- `--out` 不能写在译文仓库之内,否则写入的文件会改变它所描述的状态。
- 不修复任何问题。发现 `stale`、`drift` 等问题时,由翻译技能或人工处理后重新运行闸门。

## 前置工具

Node.js、pnpm、git,以及 `docs:verify` 需要的 Hugo。Hugo 不可用时 `docs-verify` 无法启动,闸门按规则判为 `fail`,这是预期行为。
