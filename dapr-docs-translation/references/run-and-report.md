# 收尾、运行记录与自检

## 1. 无待办时

待办为空(或只剩 `blocked`)时不要硬找活干:

1. 做术语表保养(`glossary-and-style.md` 第 6 节),并核对所有 `done` 译文的哈希与快照一致。
2. 复审最多 2 篇最久未复审(`reviewedAt` 最早或为空)的 `done` 文档:只对照源文做 `translation-procedure.md` 第 6 步的复审,**只修客观错误**(漏译、误译、术语不一致、结构问题),每处改动都重新硬校验、记台账、更新哈希与 `reviewedAt`;风格偏好不改。
3. 写运行记录,明确写"无待办",结束。整个过程控制在 10 分钟内。

## 2. 收尾步骤

1. 对**每个**本次触及过的文档,确认快照状态与磁盘一致(`tr.mjs finalize` / `fail` 已经原子更新了快照与台账,这里只是核对);更新快照的 `updatedAt`、`lastRun`、`sourceRevision`、`glossaryVersion`、`glossarySha256`,用 `statectl snapshot write` 写入。
2. 运行 `node SD/scripts/tr.mjs status --profile <profile.yaml> --locale L`(隔几次运行加 `--verify` 重跑全部已完成译文的结构校验),把完成度与"需要人处理"的文档写进运行记录;`--fail-under` / `--fail-on` 可做 CI 闸门。
3. 记台账 `run_end`(完成、失败、跳过的数量,耗时,是否因预算停止)。
4. 写 `LD/runs/<runId>.md`(用 profile 所定语言写,默认中文;结论先行,只写结果与数字):
   - **概览**:`runId`、起止时间(profile 时区)、源版本标识、停止原因;
   - **本次结果**:完成 / 带标记 / 失败 / 跳过的文档清单(路径、字节数、状态);
   - **待办全貌**:各状态文档数,以及按当前进度估计还需几个晚上(注明这只是估计);
   - **术语表**:新增条数、新增的 `conflicts`、需要人裁决的事项、当前 `version`;风格笔记新增的规则;
   - **`flags` 汇总**与需要人看的文档;`blocked` 清单;
   - **状态恢复**(仅在发生时)与任何异常;
   - **需要人处理**:例如需要改 profile 的事项(代理不改 profile)。
5. **提交**(`COMMIT` 为真时):只提交 `writeScope`——

   ```bash
   git -C REPO add -A -- <writeScope>
   git -C REPO commit -m "<message>" -- <writeScope>
   ```

   `<message>` 用英文 Conventional Commit,前缀取 profile `commit.messagePrefix`,例如 `docs(translation): translate 3 docs to zh-CN (run 20261026-0100)`;正文写文档数、术语表新增数与 `glossary version`,并带上 profile `commit.trailer` 或当前会话要求的署名行。`git add` 必须带路径,不使用 `git add .`,不带上 `writeScope` 以外的任何改动(其他会话可能有暂存或未提交的改动,路径限定的提交不会碰它们)。钩子失败不绕过,在运行记录里写明、文件保留在工作区,**不推送**。
6. `statectl lock release --dir STATE --run <runId>`。
7. 在对话里给出不超过 15 行的摘要:`runId`、完成 / 失败 / 跳过数、剩余待办数、术语表新增与待裁决冲突数、提交哈希(或未提交的原因)、运行记录路径、需要人处理的事项。

## 3. 失败处理速查

| 情形 | 处理 |
| --- | --- |
| 空目录首次运行 | 初始化,不记 `state_recovered` |
| 发现命令失败、源目录未就绪 | 停止,不写台账,运行记录写原因并释放锁 |
| 状态文件损坏 | 按 `state-and-recovery.md` 第 5 节第 3 步的恢复顺序;记 `state_recovered` |
| 单篇硬校验反复失败 | `failed`,草稿留 `drafts/`,继续下一篇;累计 3 次进 `blocked` |
| 连续 3 篇失败 | 停止本次运行并报告 |
| 译文与磁盘哈希不符(被人改过) | 以磁盘为准,标 `edited-outside-run`,不覆盖 |
| 另一次运行持有未过期的锁 | 直接退出 |
| 提交失败 | 文件保留在工作区,下次运行开头先补提交 |
| 时间或预算用尽 | 完成当前这一篇的落盘与记账,再收尾 |
| profile 缺失或字段不全 | 停止并报告缺哪些字段;不要自行补全 profile |

## 4. 自检(结束前逐项确认)

- [ ] 只写了 profile `writeScope` 内的文件;没有改只读区域;没有推送。
- [ ] 台账只追加;快照经 `statectl snapshot write`(有备份、有校验);没有删除任何已有译文、台账或备份(转正后的草稿除外)。
- [ ] 每一篇 `done`/`done_flagged` 都实际跑过 `check-translation.mjs` 并通过;失败的在 `drafts/`,状态是 `failed` 或 `blocked`。
- [ ] 术语表只新增或追加冲突,没有覆盖 `locked`、`human` 或已有首选译法;`version` 与 `changes.jsonl` 对得上。
- [ ] 外部已有译文的文档没有被翻译或改写;`superseded`、`orphaned` 的译文没有被删除。
- [ ] 运行记录写明了停止原因、剩余待办与需要人裁决的事项;没有把没跑过的校验写成通过。
- [ ] 锁已释放;提交只含 `writeScope`(`COMMIT` 为真时)。
