# `tr.mjs`:命令参考

`SD/scripts/tr.mjs`,只依赖 Node 内置模块,在任意目录都能运行(仓库根由 `--profile` 的路径推断,或用 `--repo` 指定)。`scan`、`status`、`check` 只读;`init`、`adopt`、`next`、`assemble`、`finalize`、`fail`、`glossary merge` 才写,且只写 profile 声明的范围(状态目录、译文落点、草稿)。

通用选项:

| 选项 | 作用 |
| --- | --- |
| `--profile <file>` | profile.yaml(除 `init`、带 `--job` 的命令外必需) |
| `--locale <L>` | 目标语言;缺省取 `defaultLocale`。`scan` / `status` 接受 `all` |
| `--repo <dir>` | 覆盖仓库根的推断(profile 不在 `<repo>/<translationsRoot>/profile.yaml` 时用) |
| `--run-dir <dir>` | 相对路径的基准,默认当前目录 |
| `--discovery-file <ndjson>` | 用已保存的发现输出代替运行适配器(离线、测试) |
| `--source-root <dir>` | 源文件所在目录;`--verify`、`next` 需要它(适配器的 `_meta.sourceRoot` 也行) |
| `--no-exec` | 不执行 profile 里的 `discovery.command`(对不信任的仓库用);`glob` 和 `--discovery-file` 不受影响 |
| `--discover-timeout <s>` | 发现命令超时(默认 300 秒,超时 SIGKILL) |
| `--no-hints` | `scan` / `status` 不检查术语表杂质(见下) |
| `--json` | 机器可读输出 |

退出码:0 正常;1 闸门或校验失败;2 用法或输入错误;3 锁被占用。

## `init`

`init --repo <dir> [--translations-root translations] [--locale zh-CN]… [--glob "<pattern>"]… [--source-root .] [--exclude <glob>]… [--output-template "<tpl>"] [--description "<text>"] [--dry-run]`

生成 `profile.yaml`、`README.md` 与 `locales/<L>/{drafts,state,glossary,runs[,content]}/.gitkeep`,**从不覆盖已有文件**。首个 `--locale` 成为 `defaultLocale`;`zh` / `ja` / `ko` 自动 `cjk: true`。`--output-template` 把译文落点设为站点内容树(见 `profile-spec.md`),并把它的静态前缀加进 `writeScope`,此时不建 `content/`。术语表不在这里创建:`glossary.json` 不存在就是"首次引导"的信号。

## `scan`(只读)

`scan --profile <p> [--locale L|all] [--max-docs N] [--max-bytes N] [--out <plan.json>] [--json]`

按 `state-and-recovery.md` 第 5 节的表归类并挑选。输出头部(仓库、源与记录的版本、状态来源、术语表)、各类计数、覆盖率、本次清单(`*` 为选中;`[incremental]` 表示 `stale` 且有基线副本可做 diff)、`needs a human decision`(`edited`、`untracked`、`orphan`、`blocked`、`missing`,以及译文被手改过的 `stale`)。JSON 里 `snapshotSource` 不是 `snapshot` 就是发生了恢复,要写进运行记录的"状态恢复"。`--locale all` 的 JSON 形如 `{locales: {<L>: …}}`。`--out` 不允许写进翻译根目录。

覆盖率 = (`fresh` + `edited`) / 可翻译文档数;可翻译 = 发现的文档去掉 `external` / `superseded` 与 `orphan`。

**术语表杂质提示**(`scan` 和 `status` 共有):每次运行都用 `glossary audit` 的判据快速检查一遍术语表(读一次已完成的译文),只在有问题时在头部多一行:`glossary  needs attention: 3 entries were never a term, 31 lack evidence in the finished translations`,并给出可直接运行的命令(带上你传的 `--source-root`)。三类问题:**从来就不是术语**(筛选规则不通过)、**缺证据**(`origin: auto` 的术语在已完成译文里用到的文档少于 `glossary.promoteAfter` 篇)、**一个译法对应两个源词**。术语表干净时不输出任何东西。找不到源文件(适配器没给 `sourceRoot` 且没传 `--source-root`)时无法按证据判断,只报静态问题并说明;JSON 里 `glossary.hints` 给出 `remove`、`demote`、`collisions`、`inconsistent`、`evidenceJudged`、`evidenceSkipped`、`documents`、`total`(没有术语表或 `--no-hints` 时为 `null`)。

## `status`(只读)

`status --profile <p> [--locale L|all] [--group-depth 2] [--verify] [--fail-under PCT] [--fail-on a,b] [--json]`

头部同 `scan`,再加每个目录前缀的 total / done / todo / other、"不是最新或需要处理"的清单、按模型汇总的用量(文档数、重试、token、秒数、带标记数,来自 `finalize` 记录)。`--locale all` 输出"语言 × 状态"矩阵。`--verify` 对每篇 `fresh` / `edited` 译文重跑 `check-translation.mjs`;找不到源文件的跳过并计数。闸门:`--fail-under 95`;`--fail-on stale,failed,blocked,orphan,interrupted,drift,glossary`(`glossary` = 上述杂质提示的 `total` 大于 0);`--verify` 有硬失败。任一语言触发闸门即退出 1。

## `adopt`

`adopt --profile <p> [--locale L] [--only <glob>]… [--if-translation-newer] [--dry-run] [--run <id>]`

把**已有的、没有记录的译文**(`untracked`)记为基线:当前源哈希与译文哈希写入快照(`adopted: true`),台账记 `doc_adopted`。整批只写一次快照。已有记录的文档不动。`--only` 限定范围;`--if-translation-newer` 只收"译文的最后修改不早于源文"的文档(按各自所在 git 仓库的提交时间,未提交的改动算"现在",不在 git 里的用 mtime),避免把早已过期的译文误当成最新;跳过的文档连同原因一并列出。先 `--dry-run`。会取运行锁(被占用时退出 3)。采纳的基线没有基线源副本,所以之后源文变了只能整篇重译(`incremental: false`),旧译文作参考。

## `next`

`next --profile <p> --out-dir <dir> [--locale L] [--max-docs N] [--max-bytes N] [--doc <name>]… [--run <id>] [--chunk-bytes N]`

为挑中的文档(或 `--doc` 指定的)各写一个自包含任务 `<out-dir>/<文档路径用 __ 连接>/job.json`,并写 `<out-dir>/manifest.json`。`--run` 给出时对每个任务追加 `doc_start` 台账事件(崩溃后能识别为 `interrupted`)。`--out-dir` 不允许在翻译根目录内。`job.json` 含:源文路径与哈希、草稿与最终路径、`mode`(`translate` / `incremental` / `retranslate-with-reference` / `terms-only`)、本篇用到的术语与不翻译名称、风格笔记、profile 规则、`models` 提示、旧译文与源文 diff、`driftTerms`、分块清单(源文超过 `2 × --chunk-bytes`(默认 12 KB)时切成约 `--chunk-bytes`(默认 6 KB)的块,切点只落在标题或段落边界,绝不落在 frontmatter、围栏代码块、JSX 组件或 `<details>` 内),以及给 subagent 的指令。

## `check` / `assemble`

`check --job <job.json> [--file <draft>]`:对草稿跑 `check-translation.mjs`(参数取自任务),输出 JSON,退出码 0 / 1(硬失败)/ 2(用法或文件读不了)。软校验里与术语表有关的两条:`glossary`(首选译法用得比源词出现的次数少)和 `term-collision`(术语表里一个译法对应本文中同时出现的两个源词)。`assemble --job <job.json>`:把 `chunks/NNN.out.md` 按序拼成草稿(每块去尾部空白,块间一个空行)并立即 `check`;缺块或空块退出 1 并列出。

## `finalize` / `fail`

`finalize --job <job.json> [--run <id>] [--model M] [--retries N] [--seconds S] [--tokens-in N] [--tokens-out N] [--flags '["…"]']`:确认源文自任务生成后没变、草稿通过硬校验,然后原子写入最终路径、删除草稿、记账(哈希由脚本算)、保存源文基线副本(`keepBaseSource`)、记录本篇用到的术语译法(`termTargets`,供漂移检测)和成本字段。成本字段取自 `result.json`,命令行可覆盖。软校验的发现与 subagent 的 `flags` 合并成 `flags`,有则记 `done_flagged`;环境类提示(`anchor-check-skipped`)只进输出的 `warnings`。

**术语增长是 `finalize` 的一部分**:`result.json` 里的 `termCandidates` 在文档被接受时并入术语表(规则同 `glossary merge`:新词入库、同译法累计、译法不同只记冲突、从不改首选译法)。这是为了让增长不依赖编排者记得再调一次命令。细节:① 术语表不存在时自动创建;② 新词的译法与另一个源词撞车(`collision`)时不入库,该文档带 `term-collision` 标记;③ 本篇用到的术语(含这篇自己新引入的)按合并后的术语表记进 `termTargets`,之后改了这些术语的译法就会触发 `drift`;④ 写完把 `result.json` 标 `mergedAt`,不会重复合并,`ok: false` 的结果不合并;⑤ 取术语表锁:同一个 `--run` 持有的锁直接沿用,被**别的**运行占着时,文档照常记账,候选留在 `result.json` 里,输出的 `glossary.reason` 说明,之后用 `glossary merge --job-dir` 补;⑥ 术语候选要先过**质量闸门**(筛选 → 撞车 → 暂存,见 `glossary-and-style.md` 第 3 节):首次出现只进 `glossary/pending.json`,`promoteAfter`(默认 2)篇文档一致才升为正式术语;没有自己候选的文档也会参与"靠使用确认"。⑦ 输出里的 `glossary` 字段汇报 `merged`、`version`、`added`(含升级的)、`promoted`、`reused`、`conflicts`、`staged`、`confirmed`、`pending`(待定总数)、`rejected`(逐条带原因)、`collisions`。关闭:`--no-glossary`(单次)或 profile `autoGlossary: false`(整个仓库)。`fail --job <job.json> --reason "<why>"`:`attempts` 加 1,记 `failed`,第 3 次记 `blocked`;草稿保留。

## `glossary merge`

`glossary merge --profile <p> (--job-dir <dir> | --file <candidates.json>) [--locale L] [--run <id>] [--dry-run]`

**补合并用**(正常情况下 `finalize` 已经合并过了,这里会因 `mergedAt` 而跳过)。把 subagent 在 `result.json` 的 `termCandidates` 里返回的候选并入术语表(`--file` 是 `[{doc, source, target, note?, doNotTranslate?}]`)。规则:候选先过质量闸门(见上);通过并升级的新词 `origin: auto`;译法相同则 `occurrences` 加 1(≥3 升 `high`);译法不同只记 `conflicts`,**从不改首选译法**,`locked` / `human` 条目的 `target` 不会被改;新词的译法若已是另一个源词的首选译法,**不入库**,记 `collision`(摘要里 `collisions` 列出,`changes.jsonl` 里带 `with`),由人裁决;`version` 对每篇有改动的文档加 1;写 `changes.jsonl` 与台账 `glossary_change`,并同步快照里的 `glossaryVersion` / `glossarySha256`(这样合并不会被当成人工修改)。已合并的 `result.json` 带 `mergedAt`,不会重复合并;`ok: false` 的跳过。要加锁,被占用退出 3。

## `glossary audit`

`glossary audit --profile <p> [--locale L] [--min-docs N] [--static-only] [--apply] [--run <id>] [--json]`

对**存量术语表**重跑质量闸门(默认只报告,`--apply` 才写)。判据只看事实:
- **移除**(`demote … to: removed`):没有证据也该去掉的"不是术语"——筛选规则不通过(`generic`、`identifier`、`untranslated`、`too-long`…);不翻译名称同样检查,但 CamelCase 的品牌名(`OmniRoute`、`OpenAI`)不算标识符。
- **退回待定**(`to: pending`):`origin: auto` 的术语,在已完成的译文里"源文含该词且译文用了该译法"的文档少于 `--min-docs`(默认 `glossary.promoteAfter`)篇。它连同证据(用到它的文档)进 `pending.json`,之后任何一篇文档用同样的译法就会自动重新升级。
- **保留并只报告**:`origin: human`、`locked`,以及来自上游译文的 `bootstrap` 条目(不要求证据,只过静态筛选)。同一译法对应多个源词(`collision`)、术语在文档里出现但译文没用该译法(`inconsistent`)也只报告。
`--static-only` 只应用静态筛选,不按证据降级(没有已完成的译文时用);否则没有任何已完成译文会直接退出 2,免得把所有 auto 术语都误判为"没证据"。`--apply` 一次升一个版本,写 `changes.jsonl`(`op: demote`)、台账、并同步快照里的术语表版本与哈希(不会被当成人工修改);取运行锁。

## `glossary bootstrap`

`glossary bootstrap --profile <p> [--locale L] [--max-docs 12] [--min-docs 2] [--max-terms 150] [--apply] [--merge] [--run <id>] [--json]`

**首次引导,无需模型**:从 profile `externalTranslations.evidence`(`{locale}` 会被替换)里的上游译文学习。步骤:按路径后缀把源文档与上游译文配对(取最长公共后缀,并列的跳过)→ 按优先级和大小取最多 `--max-docs` 篇 → 结构对齐:标题(一级标题是文档标题,跳过)、表格第一列、粗体,以及译文里的"译名（Original）"注释;标题对得上时表格和粗体**按小节**逐节对齐,计数对不上的小节整节丢弃,不硬凑(输出里列出每篇哪些类别、几节对齐失败)→ 统计"源词 → 译词"配对,**至少 `--min-docs`(默认 2)篇文档一致**才算,票数并列的记为 `ambiguous` 不猜 → 过质量闸门的筛选,另加引导专用的更严规则:文档标题与页面名(`… Guide`、`… Reference`)、小写开头的零碎词、译法里出现源词没有的拉丁词(对齐错位的标志)→ 同一译法对应两个源词时保留票数多的 → 在两篇以上文档里原样保留的名称进 `doNotTranslate`,再加上 profile 的 `rules.doNotTranslateSeeds`。
默认 dry-run,只报告。`--apply` 创建 `glossary.json`(`version: 1`,`origin: bootstrap`,`confidence: medium`)和起始 `style.md`、写 `changes.jsonl` 与台账;`glossary.json` 已存在时拒绝(退出 2),要加 `--merge`:只添加它还没有的,已有的译法不动,分歧记为 `conflicts`。取运行锁。
