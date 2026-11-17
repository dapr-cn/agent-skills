# 术语表与风格笔记(累计增长,但不漂移)

文件都在 `LD/glossary/`(`LD = T/locales/<L>`)。目标:每一篇都比上一篇更一致,同时**已有的首选译法不会被悄悄改掉**。

## 1. 术语表 `glossary.json`

每次修改后 `version` 加 1,并往 `changes.jsonl` 追加一行 `{ts, run, op, id, ...}`(`op` 取 `add`、`bump`、`conflict`、`promote`、`demote`(audit 降级或移除)、`revert`(`glossary revert` 的人工决定)、`external-edit`、`maintain`)。

```json
{
  "schema": 1, "version": 12, "updatedAt": "<ISO>",
  "doNotTranslate": [
    { "term": "ProductName", "note": "产品名", "origin": "bootstrap", "locked": false }
  ],
  "terms": [
    {
      "id": "fallback", "source": "fallback", "target": "回退", "alt": [],
      "note": "路由失败后切换到下一个目标", "origin": "auto", "locked": false,
      "confidence": "medium", "occurrences": 7,
      "firstSeen": { "doc": "docs/routing/…", "run": "20261026-0100" },
      "lastSeen":  { "doc": "docs/guides/…",  "run": "20261027-0100" },
      "conflicts": [ { "target": "降级", "doc": "docs/…", "run": "…" } ]
    }
  ]
}
```

- `source` 是源语言词形,`target` 是目标语言的首选译法(`check-translation.mjs` 读的就是这两个字段)。
- `origin`:`bootstrap`(首次从外部译文挖出)、`auto`(你在翻译中新增)、`human`(人加的)。
- **`locked: true` 的条目与 `origin: human` 的条目永远不得由你修改。**
- 整表按 `id` 排序;`id` 为源语言词小写、空格转连字符。

## 2. 引导(只在 `glossary.json` 不存在时做一次)

用 `tr.mjs glossary bootstrap`(见 `commands.md`),不再由模型手工完成:

1. 先 dry-run:`tr.mjs glossary bootstrap --profile <p> [--source-root <源根>]`,看报告——每篇文档哪些类别对齐、哪些对齐失败(要写进运行记录),以及学到的术语与名称。
2. 满意后 `--apply`:创建 `glossary.json`(`version: 1`)和起始 `style.md`,记 `glossary_change`。`--max-docs`(默认 12)、`--min-docs`(默认 2)、`--max-terms`(默认 150)可调。
3. 没有 `externalTranslations.evidence`(没有上游译文)的仓库:不用引导,术语表从空开始,只放 profile `rules.doNotTranslateSeeds`;`finalize` 的自动入库会在翻译中逐步长出来。
4. 术语表之后变大、也可能有杂质时,用 `tr.mjs glossary audit` 复检(见 `commands.md`)。

规则(脚本已实现,留作排错时对照):外部译文质量未经核实,所以只产生 `confidence: medium` 的条目;**同一配对至少 2 篇文档一致**;结构对齐对不上的类别(或小节)整块放弃,不硬凑;普通词(`File`、`Command`、`Variable`、`Factor` 这类任何技术文档都有的词)不收;取到的有效条目很少是正常的,不要为凑数放宽过滤。

## 3. 入库(每篇文档完成后立刻做;用任务流程时由 `tr.mjs finalize` 自动完成)

**质量闸门**(`finalize` 与 `glossary merge` 共用,不在术语表里的候选依次过三关):

1. **筛选**——拒绝"不是术语"的候选,并把原因写进 `changes.jsonl`(`op: reject`)和命令输出的 `rejected`:`identifier`(路径、文件名、`--flag`、驼峰或下划线符号)、`too-long`(超过 4 个词,或译法超过 30 个字符)、`too-short`、`generic`(file、option、setting 这类任何文档都有的普通词,及 profile `glossary.ignore` 里的词)、`title`(文档自己的标题)、`untranslated`(译法与源词相同,应当用 do-not-translate)、`not-in-source`(原文正文里没有这个词)、`not-used`(译文里没有这个译法)。
2. **撞车**——译法已经是另一个源词的首选译法 → 不入库,记 `collision`。
3. **暂存**——首次出现只进 `glossary/pending.json`,不改 `glossary.json`、不升版本。**当 `glossary.promoteAfter`(默认 2)篇文档一致时才升为正式术语**:另一篇文档再次报告同一译法,或者另一篇文档的**原文里有这个词、译文里用了这个译法**(靠使用确认,它不需要再报一遍)。同一个词的不同译法分别暂存,先达到门槛的胜出,其余记为它的 `conflicts`。`promoteAfter: 1` 则立即入库(筛选仍然生效)。
4. 待定项会作为建议出现在后续任务的 `glossary.pending` 里,让后面的文档尽量沿用,术语表因此收敛;`scan` / `status` 的头部显示待定数量。

下面是手工入库时的规则(脚本也遵循):

用 `next` / subagent 流程时,subagent 在 `result.json` 的 `termCandidates` 里返回候选,`tr.mjs finalize` 在接受文档的同一步里把它们并入术语表,**不需要再调别的命令**(`tr.mjs glossary merge --job-dir` 只用来补合并锁被占时留下的候选):下面的规则由脚本执行(新增、`occurrences`、`conflicts`、版本、`changes.jsonl`、台账、快照同步),**并行的 subagent 因此不会各自改术语表**。手工翻译时按下面的规则自己做。

对翻译时收集的"术语候选"逐个处理:

- **只收领域术语与固定短语**(名词或名词短语、标题里的核心概念、专有名词),**不收**普通词汇、句子片段与一次性出现的词。专有名词与不该翻译的名称进 `doNotTranslate`。
- 已存在且译法相同 → `occurrences` 加 1,更新 `lastSeen`;累计使用 ≥ 3 篇文档时 `confidence` 升为 `high`。
- 已存在但译法不同 → **不改首选译法**,把新译法追加到 `conflicts`(同一译法不重复记)。你自己翻译时永远用首选译法,所以冲突只会来自外部证据或你的疏漏,留给人在运行记录里裁决。
- 不存在 → 新增,`origin: auto`、`confidence: medium`(只出现一次的专名可记 `low`)。**例外**:新词的译法与术语表里另一个源词的首选译法相同(如 agent 与 proxy 都译"代理")→ **不入库**,记 `collision`(带 `with: <已有 id>`)留给人裁决;`tr.mjs glossary merge` 的输出里 `collisions` 列出它们。
- 写完用 `jq empty` 校验,再 `mv`;记 `changes.jsonl`。**版本计数**:一篇文档的一批入库只让 `version` 加 1,`changes.jsonl` 里每个被改动的条目一行,每行带同一个新 `version`。

## 4. 人工修改的识别与传播

每次运行开始时(在"术语表就绪"一步),把 `glossary.json` 的 sha256 与快照里记录的 `glossarySha256` 比较:

- 相同 → 没有人动过。
- 不同,且台账里没有对应的 `glossary_change` → 视为人工修改:记 `glossary_change`(`op: external-edit`),`version` 加 1,更新 `glossarySha256`。
- 漂移由 `tr.mjs scan` 自动判定(快照里每篇文档记着译成时的 `termTargets`,与当前术语表对比;以及被 `glossary revert --to source` 回退为英文的术语,其旧译法仍在已完成译文里且源文用到该术语的文档),不用再靠推断。`drift` 文档走"只替换术语"的修复(`next` 生成 `mode: terms-only` 的任务),不重译。修复时只换术语用法:普通词义(如 `主题` 作 theme/subject、`协调` 作普通动词、`重试策略` 泛指 retry strategies)保留原样,并在 `result.keptTerms` 里列出 id、句子与理由;标题换了则同文档的 `#锚点` 同步改。修复落账后记 `reviewedTerms`,保留下来的普通词义不会让文档再次成为 drift。

## 5. 风格笔记 `style.md`

累计的规则清单,每条一行。翻译前必读。

- **起始规则**(首次创建时写入;语言特有的部分取自 profile `locales.<L>.notes`):源文档的语气与人称保持一致;列表与表格的句末标点跟随源文档;`Yes`/`No`、`Enabled`/`Disabled` 这类固定状态词在整个站点内统一译法(进术语表)。中文再加:全角标点;中英文与数字之间加半角空格;读者称"你";英文单词与代码保持原写法。
- **增长规则**:只有当复审或硬校验在**不少于 2 篇**文档里指出同一类问题时,才追加一条规则(写成可执行的句子,例如"表格里的 `Yes`/`No` 译为'是'/'否'")。总数不超过 40 条,满了就合并相近的条目而不是继续追加。每次追加都在运行记录里列出。

## 6. 保养(每次运行结束前)

去重、按 `id` 排序、检查 `conflicts` 里同一替代译法出现 ≥ 3 次的条目(写进运行记录等人裁决,**不自行翻案**)、检查 JSON 有效、核对 `version` 与 `changes.jsonl` 对得上。
