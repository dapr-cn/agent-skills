# profile.yaml:仓库专属配置

技能只认 `profile.yaml` 里的信息;它放在**目标仓库**里(建议 `<repo>/translations/profile.yaml`),随仓库版本管理。人维护它,代理**不得修改**它(需要改动时写进运行记录的"需要人处理"一节)。

下文记 `RUN_DIR` 为运行开始时所在的目录(通常是 monorepo 根),`REPO` 为目标仓库根目录,`T` 为翻译根目录(`translationsRoot`)。**路径基准只有一条规则**:`repo` 相对 `RUN_DIR`;profile 里**所有其他路径**(含 `discovery.cwd`、`translationsRoot`、`writeScope`、`readOnly`、`evidence`)都相对 `REPO`;本技能里的命令在 `REPO` 下运行(`git -C REPO …` 例外)。`forbidden` 里的路径是描述性的,按字面理解,不做基准换算。

## 字段

```yaml
schema: 1
repo: repos/my-docs                     # 仓库根目录,相对运行目录(通常是 monorepo 根)
translationsRoot: translations          # T:译文、状态、术语表都在它下面
defaultLocale: zh-CN
locales:                                # 已接入的目标语言;skill 只处理被选中的一个
  zh-CN:
    name: 简体中文
    cjk: true                           # true 时对译文启用 CJK 占比软校验(--min-cjk-ratio)
    dir: zh-cn                          # 可选:output.template 里 {dir} 的取值
    notes: references 外的语言特有约定(一两行,可空)

sources:
  description: 一句话说明源文档是什么、来自哪里
  # 源文档的发现方式二选一(都有时 glob 优先)。
  glob:                                 # 内置发现:源文档就在仓库里,不必写适配器
    root: docs                          # 相对 REPO;文档的 `doc` 名 = 相对 root 的路径
    include: ["**/*.md", "**/*.mdx"]    # 支持 **、*、?、{a,b}
    exclude: []
  discovery:                            # 发现命令:在 REPO 下运行,按"发现命令契约"输出
    cwd: .                              # 相对 REPO
    command: node translations/discover.mjs --locale {locale}
  extensions: [.md, .mdx]               # 仅用于说明;真正的范围由发现命令决定

externalTranslations:                   # 仓库之外(通常是上游)已经提供的译文
  policy: skip                          # skip:已有外部译文的文档不翻译、不改写
  evidence:                             # 术语引导可参考的外部译文(只读、质量未经核实)
    - vendor/upstream/docs/i18n/{locale}/

output:                                 # 译文落点;缺省 <T>/locales/<L>/content/<doc>
  template: "src/content/docs/{locale}/{doc}"   # {locale}、{dir}(locales.<L>.dir,缺省同语言代码)、{doc};相对 REPO,不得越出仓库

writeScope: [translations/]             # 允许写入与提交的路径(相对 REPO);用了 output.template 就要把它的目录也列进来
readOnly:                               # 明确只读;优先级高于一切
  - vendor/
  - src/content/docs/
  - scripts/
  - src/
  - test/
  - package.json
  - package-lock.json
forbidden:                              # 不得触碰的路径或事项
  - path/to/a/live/deployment             # 不得读写、重启或杀进程的路径
  - git push / stash / reset / checkout / 新建分支 / --no-verify

priority:                               # 路径分层;靠前的先做,同层内按字节数从小到大
  - { tier: 1, match: ["README.md", "docs/getting-started/", "docs/guides/"] }
  - { tier: 2, match: ["docs/routing/", "docs/security/", "docs/reference/"] }
  - { tier: 4, match: ["docs/changelog/", "docs/assets/"] }   # 未匹配的默认第 3 层

budgets:
  maxRunMinutes: 240
  maxDocs: 10
  maxSourceBytes: 80000
  minMinutesToStartDoc: 20

models:                                 # 任务里带的模型分层提示(编排者映射到 subagent 的 model)
  translate: haiku
  review: haiku
  escalate: sonnet

glossary:
  promoteAfter: 2                       # 术语候选要几篇文档一致才升为正式术语;1 = 立即入库(筛选仍然生效)
  ignore: []                            # 额外的"普通词":这些源词永远不会成为术语候选
autoGlossary: true                      # finalize 接受文档时自动把 subagent 的术语候选并入术语表;false 则只能手动 tr.mjs glossary merge
keepBaseSource: true                    # 完成时保存译成的那版源文(state/base/),之后源文变了可按 diff 增量更新;false 则整篇重译

commit:
  enabled: true
  messagePrefix: "docs(translation)"    # 英文 Conventional Commit 前缀
  trailer: ""                           # 追加到提交信息末尾的署名行;空则沿用调用会话要求的署名

timezone: America/Los_Angeles           # 运行记录与 runId 用的时区

rules:                                  # 本仓库额外的翻译规则(叠加在 translation-procedure.md 之上,冲突时以这里为准)
  doNotTranslateSeeds: [ProductName, BrandName]  # 术语表引导时直接进 doNotTranslate 的名称
  links: 相对链接保持原样(站点导入时会统一改写)
  frontmatterTranslatable: [title, description]
  extra:
    - 任意本仓库特有的规则,一条一行
```

## 发现命令契约

`sources.discovery.command` 是仓库提供的**只读**适配器,输出**NDJSON**,每个会发布的源文档一行:

```json
{"doc":"docs/guides/CLI-COMPANION.md","bytes":2749,"sha256":"<源文件文本的 sha256>","external":false}
```

- `doc`:源文档相对于「源根」的路径,稳定、唯一;译文落在 `T/locales/<locale>/content/<doc>`。
- `bytes`:源文本的 UTF-8 字节数。`sha256`:对源文件文本取 sha256(UTF-8,与 `sha256sum` 一致)。
- `external`:这个语言的外部译文是否已存在(为 `true` 时按 `externalTranslations.policy` 处理)。
- **可选的第一行元数据**:`{"_meta":{"sourceRevision":"<源版本标识,例如子模块 HEAD>","sourceRoot":"<源根,相对 REPO>"}}`。有 `sourceRevision` 时运行用它,没有就记 `null`;`sourceRoot` 让 `tr.mjs status --verify` 找到源文件(没有时用 `--source-root` 指定)。每行文档也可带 `"path"`(源文件相对 REPO 的路径)。读取文档行时跳过带 `_meta` 的行。
- `glob` 内置发现的 `sourceRevision` 取 `root` 所在 git 仓库的 HEAD(不在 git 里则为 `null`)。
- 命令只读、无副作用、可重复运行;失败(非零退出)时本次运行停止并报告。`{locale}` 在运行前替换为目标语言代码。
- 源文档不在仓库内(例如上游子模块)时,`doc` 仍是源根下的相对路径;子模块未初始化应让命令失败,而不是输出空列表。

## 提交前提与临时文件

- **人维护的文件要先入库**:`profile.yaml`、发现适配器(如 `discover.mjs`)、`README.md` 属于人写的内容,应在第一次运行**之前**由人提交,避免运行的提交把它们当作自己的产物一并带走(提交范围是 `writeScope` 整个目录)。
- **署名**:`commit.trailer` 写成目标仓库自己历史提交里用的署名行(查 `git log` 的 trailer);留空才沿用调用会话要求的署名。仓库自己的提交钩子或贡献规则若禁止某类署名,在这里写明,不要等钩子拒绝。注意:某个子模块里的钩子只作用于子模块自身的提交,不作用于外层仓库。
- **临时文件**放会话的 scratchpad;没有就用 `mktemp -d` 在仓库**之外**建目录。不要放进 `writeScope`,更不要放进被跟踪的目录。

## 接入新仓库

1. 运行 `node <SKILL_DIR>/scripts/tr.mjs init --repo <repo> --source-root <docs 目录> --glob "**/*.md" --locale zh-CN`(可重复 `--locale`、`--glob`、`--exclude`;`--dry-run` 只列出将创建的文件)。它生成 `translations/profile.yaml`、`README.md` 与各语言目录,**从不覆盖已有文件**。
2. 补全 profile(`description`、`readOnly`、`priority`、各语言 `notes`、`rules`)。源文档来自上游子模块等没有现成 glob 的情况,把 `sources.glob` 换成 `sources.discovery` 并写适配器(能复用仓库自己的"哪些文档会发布"逻辑最好),输出符合契约;先手动运行,确认行数与预期一致。
3. 运行 `tr.mjs scan --profile <profile.yaml>`,确认发现数与分类符合预期。
4. 仓库里**已有译文**(`scan` 显示 `untracked`):`tr.mjs adopt --profile <p> --dry-run [--only <glob>] [--if-translation-newer]` 看清单,确认后去掉 `--dry-run`。
6. 手动跑一晚(把 `maxDocs` 临时调小),检查术语表引导结果与运行记录,再排定时。

译文怎样进入站点的构建(覆盖层、导入脚本、审阅基线)**不属于本技能**,由仓库自己的工作处理;本技能只保证译文目录里的内容通过校验、状态可追溯。
