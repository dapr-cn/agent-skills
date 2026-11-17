# 状态、恢复与待办挑选

记号:`T` = profile 的 `translationsRoot`;`L` = 目标语言代码;`LD = T/locales/<L>`;`STATE = LD/state`;`SD = <SKILL_DIR>`。所有路径相对仓库根 `REPO`。

## 1. 目录契约

```
T/
├── profile.yaml                       # 人维护;代理不改
├── README.md
└── locales/<L>/
    ├── content/<doc>                  # 通过硬校验的译文;路径 = 源文档相对路径(profile 有 output.template 时译文在那里,没有这个目录)
    ├── drafts/<doc>                   # 没通过硬校验的草稿;留作续做与排错,不是成品
    ├── state/
    │   ├── ledger.jsonl               # 追加式台账:唯一的历史事实来源
    │   ├── snapshot.json              # 状态快照(由台账与文件派生,可重建)
    │   ├── backup/snapshot.<run>.<ms>.json   # 覆盖快照前的备份,保留最近 14 份
    │   ├── base/<doc>                 # 译成时的那版源文(keepBaseSource),用于增量更新
    │   └── run.lock                   # 运行锁(statectl 管理)
    ├── glossary/{glossary.json,pending.json,changes.jsonl,style.md}   # 见 glossary-and-style.md;pending.json 是待定术语
    └── runs/<runId>.md                # 每次运行的记录
```

## 2. 状态快照 `snapshot.json`

```json
{
  "schema": 1, "locale": "zh-CN", "updatedAt": "<ISO>", "lastRun": "<runId>",
  "sourceRevision": "<源版本标识,例如子模块 HEAD;没有则为 null>",
  "glossaryVersion": 12, "glossarySha256": "<glossary.json 的 sha256>",
  "docs": {
    "<doc>": {
      "status": "done", "sourceSha256": "<源文本 sha256>", "sourceRevision": "<同上>",
      "translationPath": "<T>/locales/<L>/content/<doc>", "translationSha256": "<译文 sha256>",
      "glossaryVersion": 12, "attempts": 1, "runId": "<runId>", "doneAt": "<ISO>",
      "reviewedAt": null, "flags": [], "note": "",
      "adopted": true,                     // 仅 adopt 记录的基线:没有 base 副本、不是由某次运行验证的
      "model": "haiku", "retries": 1, "seconds": 12, "tokens": {"in": 900, "out": 400},   // finalize 记录
      "termTargets": {"fallback": "回退"}  // 译成时本篇用到的术语及译法,用于漂移检测
    }
  }
}
```

`status` 取值:

| 值 | 含义 |
| --- | --- |
| `done` | 通过全部硬校验 |
| `done_flagged` | 通过硬校验但带 `flags`,需要人看 |
| `stale` | 源文本哈希变了 |
| `drift` | 术语表首选译法后来被改了,译文里还含旧译法(`scan` 判定,见 §5 第 4 步);一次 `terms-only` 修复失败也记为 `drift`(不退回整篇重译),连续 3 次失败记 `blocked` |
| `failed` | 本次没通过硬校验,草稿在 `drafts/` |
| `blocked` | `attempts ≥ 3`,等人处理;人把 `attempts` 改回 0 即重新进入待办 |
| `interrupted` | 上次运行在这一篇中途中断 |
| `superseded` | 外部(上游)后来补了同一文档的译文,本地译文保留但不再维护 |
| `orphaned` | 源文档已不在发布清单里,译文保留 |

## 3. 台账 `ledger.jsonl`

一行一个 JSON 对象,至少有 `ts`(脚本自动加)、`run`、`event`。`event` 取:`run_start`、`doc_start`、`doc_done`、`doc_adopted`、`doc_failed`、`doc_skipped`、`glossary_change`、`state_recovered`、`run_end`。文档类事件带 `doc`;`doc_start` 带 `sourceSha256`;`doc_done` 带 `status`、`sourceSha256`、`translationSha256`、`flags`;`doc_failed` 带 `status`(`failed` 或 `blocked`)与 `reason`。

只用脚本追加,不手写:

```bash
node SD/scripts/statectl.mjs ledger append --dir STATE --json '{"event":"doc_start","run":"<runId>","doc":"<doc>","sourceSha256":"<sha>"}'
```

## 4. 写入纪律

1. 台账只追加(`statectl ledger append`);从不改写、不截断、不重排。**写错了怎么办**:不改历史行,追加一条同类新事件(例如再记一次 `doc_done`,`note` 说明原因);`ledger replay` 以同一文档的最后一条为准。
2. 一篇文档完成时用 `statectl doc finalize`(见 `translation-procedure.md` 第 7 步),它同时负责台账与快照,哈希由脚本计算。其余需要改快照的场合用 `statectl snapshot write --dir STATE --run <runId> --file <新快照.json>`:脚本先校验 JSON、备份旧快照、裁剪备份只留 14 份,再用临时文件原子替换。**不要直接覆盖 `snapshot.json`。**新快照先写到 `STATE` 之外的临时位置(例如会话的 scratchpad)。
3. 其他 JSON(术语表)同样"先写临时文件,`jq empty` 校验通过,再 `mv`"。
4. 每篇文档在 `doc_start` 记账之后才开始翻译;在译文落盘并通过校验之后才记 `doc_done` 并更新快照。**每完成一篇立刻更新快照与术语表**——崩溃最多丢当前这一篇。
5. 绝不删除 `T/` 下已有的译文、草稿、台账、备份;唯一例外:某篇成功转正后,删除它对应的那份草稿。

## 5. 开工流程

按顺序;任何一步失败就停下并写运行记录(能写台账的写台账)。

1. **环境**:读 profile 并核对 `repo`、`translationsRoot` 存在;取时间(`TZ=<timezone> date '+%F %T %z'`),`runId = <YYYYMMDD>-<HHMM>`;`git -C REPO status --short`,记下已有的未提交改动(只处理 `writeScope` 内的文件);确认磁盘余量大于 1 GB(`df -Pk REPO`);取源版本标识:发现命令输出的第一行 `_meta` 里的 `sourceRevision`(见 `profile-spec.md`);没有则为 `null`。
2. **加锁**:`node SD/scripts/statectl.mjs lock acquire --dir STATE --run <runId> --max-minutes <maxRunMinutes+30>`。退出码 3(busy)= 另一次运行未过期 → **直接退出**并写一行说明,不写台账。结束(含异常结束)时 `lock release`;脚本只释放自己持有的锁。锁只按年龄判定过期。
3. **恢复状态**。目录或状态文件都不存在 = **首次运行(初始化)**,不是恢复:按第 1 节创建骨架、状态视为空、**不记** `state_recovered`。只有"本应存在的状态缺失或损坏,被回退重建"才记 `state_recovered`。
   1. **仅当 `COMMIT` 为真**:若 `git -C REPO status --short -- <writeScope>` 里有**属于本技能产物**的未提交改动(`locales/` 下的文件),先按 `run-and-report.md` 的提交步骤提交一次,信息写明 `recover uncommitted work from an interrupted run`。人维护的文件(`profile.yaml`、发现适配器、`README.md`)应在首次运行前就已入库,见 `profile-spec.md`;`COMMIT` 为假时跳过本步。
   2. `statectl snapshot load --dir STATE`:先试 `snapshot.json`,无效则自动回退到最新的有效备份(stderr 会写明来源)。退出码 4 = 都没有 → 用 `statectl ledger replay --dir STATE` 从台账重建;台账也没有 → 对 `content/` 下每个文件,与发现命令给出的当前源哈希比对(相同记 `done`,不同记 `stale`)重建。**任何一级回退都记 `state_recovered` 事件**并写进运行记录的"状态恢复"一节。
   3. 台账里有 `doc_start` 而没有后续 `doc_done`/`doc_failed` 的文档 → 状态置 `interrupted`(`attempts` 加 1,不删草稿)。
   4. 校验快照与磁盘一致:译文文件存在且 `translationSha256` 与 `sha256sum` 一致;不一致(被人改过)→ 以磁盘为准更新哈希,`flags` 加 `edited-outside-run`,**不覆盖该文件**。
4. **盘点与挑选**:运行
   ```bash
   node SD/scripts/tr.mjs scan --profile <profile.yaml> --locale L --out <STATE 之外的 plan.json>
   ```
   它运行发现、读快照(快照 → 备份 → 台账重放,与 `statectl snapshot load` 同序)、对每篇文档归类并按预算挑选;只读,不写仓库(`--out` 指向翻译根目录内会被拒绝)。发现命令由脚本包住并带超时(`--discover-timeout`,默认 300 秒)。归类规则(脚本实现,以此表为准):

   | 条件 | 归类 |
   | --- | --- |
   | `external=true` 且本地没有译文 | `external`,不处理(外部负责) |
   | `external=true` 且本地有译文或有记录 | `superseded` |
   | 无记录、无译文文件 | `new`,待翻译 |
   | 无记录但译文文件存在 | `untracked`,不自动处理,交给人(采纳或重译) |
   | 记录为 `blocked`,或 `failed`/`interrupted` 且 `attempts ≥ 3` | `blocked`,跳过 |
   | 记录为 `failed` / `interrupted` | 同名归类,重试 |
   | 记录的 `sourceSha256` 与当前源不同 | `stale`;若译文文件也被人改过,`edited: true`,进 `attention` |
   | 记录为 `drift`,且源未变 | `drift`(仍有待修复的旧译法时;已修复则为 `fresh`) |
   | 源未变但译文文件不在 | `missing`,当作待翻译 |
   | 源未变,译文文件哈希与记录不同 | `edited`:人在运行之外改过,计入完成,**不覆盖** |
   | 最后一个台账事件是 `doc_start` 且无活动运行 | `interrupted`(3 次则 `blocked`) |
   | 源未变,译文哈希一致 | `fresh` |
   | 快照里有、发现里没有 | `orphan`(译文也已不在磁盘上时,`tr.mjs orphan prune` 移除记录;译文仍在则不动、只报告) |

   `drift` 由 `scan` 判定,两个来源:(a) 快照里记录了译成时每个术语的译法(`termTargets`),术语表里该术语的 `target` 后来变了、而译文里仍含旧译法;(b) 术语被 `glossary revert --to source` 回退为英文,`changes.jsonl` 的 revert 行记着旧译法 `from`,已完成译文仍含它、源文正文用到该术语、且快照里没有 `reviewedTerms[id] === from` 的记录(没有 `termTargets` 的文档也判)。两者都只看 `fresh` 文档;`edited` 文档不判、不改。`driftTerms` 列出 id、旧、新。`terms-only` 修复落账时写 `reviewedTerms`(本篇审过的旧译法)与 `termTargets`(英文目标),所以修复后不再重判,普通词义的旧译法也不会造成循环。术语表在运行之外被改过时 `scan` 头部会写 `glossary … (changed outside a run)`。**`interrupted` 也由 `scan` 判定**:台账里某文档最后一个事件是 `doc_start`、且没有运行锁在持有(锁只按年龄判断)→ `interrupted`,`attempts` 按未完成的 `doc_start` 连续次数累加,达到 3 记 `blocked`。台账只有 `doc_start`(一次刚开始的运行)而没有完成事件时,不会据此重建快照。

5. **排序并按预算挑选**(`scan` 已按此挑好,输出的 `picked` 就是本次清单):`interrupted` 与 `stale` 优先,其次 `drift`,再次 `new` / `failed` / `missing`;`blocked` 跳过。同组内先按 profile 的 `priority` 分层(未匹配的为第 3 层),层内按 `bytes` 从小到大(先落袋为安)。依次累加,遇到 `maxDocs` 或 `maxSourceBytes` 即停;单篇超过 `maxSourceBytes` 时允许单独处理一篇。`--max-docs`、`--max-bytes` 可覆盖 profile。
6. **术语表就绪**:见 `glossary-and-style.md`("引导"与"人工修改的识别")。
7. 写台账 `run_start`(含源版本标识、待办各类数量、本次挑选的清单),然后进入 `translation-procedure.md` 的逐篇流程。

## 6. 停止条件

连续 3 篇失败(很可能是校验器或环境问题,停止并报告)、触及预算、剩余时间不足 `minMinutesToStartDoc`。时间或预算用尽时,完成当前这一篇的落盘与记账,再收尾。
