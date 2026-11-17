# 单篇翻译流程

对每篇被挑中的文档:`doc_start` 记账 → 下面第 1–7 步 → 记 `doc_done` 或 `doc_failed` → 更新快照 → 术语入库(见 `glossary-and-style.md`)→ 下一篇。

**推荐流程(任务 + subagent)**:主会话运行 `tr.mjs next --out-dir <scratch> --run <runId>`,为每个任务派一个全新的 subagent,提示词只需:"读 `<job.json>`,按其中 `instructions` 完成,最后只回复 result JSON"。任务已包含源文路径、本篇术语与不翻译名称、风格笔记、profile 规则、`mode`(整篇 / 增量 diff / 仅换术语)、旧译文与 diff、分块清单和 `commands.check`。subagent 翻译 → 写草稿(长文档按 `chunks/NNN.src.md` 逐块翻成 `NNN.out.md`,再 `commands.assemble`)→ `commands.check`(硬失败最多修 2 轮)→ 写 `result.json`。主会话逐个 `tr.mjs finalize --job …`(通过则落盘、记账,**并把术语候选并入术语表**;不通过 `tr.mjs fail --job … --reason …`;硬校验反复失败的任务可改用 profile `models.escalate` 的模型重派一次)。**状态、术语表、台账只由主会话经脚本写**。复审(第 6 步)只对带 `flags` 的文档做。下面第 1–7 步说明的是同一套规则,手工翻译或排错时照着做。

## 1. 读入

读源文档,取 `sourceSha256`。

- `stale` 文档同时读旧译文;若快照里旧的 `sourceRevision` 仍可对比(例如子模块里还有那个提交),用版本控制的 diff 只更新变化的部分,其余旧译文原样保留;对比不了就整篇重译,但沿用旧译文的术语与措辞。
- `drift` 文档只替换受影响的术语(必要时改写所在句子),不重译全文。普通词义的旧译法保留并列入 `result.keptTerms`;标题改了则同文档的 `#锚点` 同步。

## 2. 准备术语

从术语表取出本篇出现的条目(英文词不区分大小写、按词边界匹配,单复数与连字符形式视为同一词),形成"本篇术语表";另取 `doNotTranslate` 里出现的名称。读 `glossary/style.md`。

## 3. 翻译规则

先读 profile 的 `rules`;与下面冲突时以 profile 为准。

- **忠实、通顺**:不增删信息,不加译者注,不"润色"原意。技术文档用书面、克制的语气。
- **原样保留**(硬性):fenced 代码块(整块逐字节不变,含其中的注释;profile 的 `rules.checks.fenceComments: translate` 放宽为:**只有注释文字可译**,注释符号之前的代码、注释以外的字符串与标识符仍须逐字不变)、行内代码(`rules.checks.inlinePlaceholders: translate` 时,说明性占位符如 `[HOST NAME]` 可一对一换成含中文的写法,标识符、命令、参数、键名仍不可译)、URL、链接与图片的目标地址、HTML 标签与属性、命令与参数、环境变量名、配置键、JSON/YAML 键、型号与标识符、产品与供应商名、`doNotTranslate` 里的名称、表情符号。
- **frontmatter**:键与顺序不变,只翻译 profile `rules.frontmatterTranslatable` 列出的键(默认 `title`、`description`)的值;其余值不变。不添加语言切换条,不在标题后追加语言名后缀。
- **可译**:标题、正文、列表、表格单元格里的说明文字、链接的可见文字、图片 alt、引用块、`<details>` 摘要。
- **术语**:命中"本篇术语表"的词一律用首选译法;未命中的新术语,选一个简洁、行业里通行的译法,**整篇保持一致**,并记为"术语候选"。拿不准的专有名词宁可保留原文,必要时在首次出现处写成"译名(Original)"。
- **标点与排版**:遵循 `glossary/style.md` 与 profile 里该语言的 `notes`。(中文的基线:全角标点;中英文、中文与数字之间加一个半角空格;读者称"你"不称"您"。其他语言用对应的行业惯例。)
- **文内锚点**:Starlight 等站点按标题文本生成锚点,译文标题的锚点会变。把指向**本篇**标题的 `#fragment` 改写成译文标题的实际 slug(规则同 `github-slugger`:小写、去标点、空格转 `-`;非拉丁字符保留);校验器会核对。指向**其他文档**的 `path#fragment` 不改,fragment 保持原样,并在 `flags` 记 `cross-doc-anchor`。
- **相对链接路径**保持原样,除非 profile 另有规定。

## 4. 写出草稿

写到 `LD/drafts/<doc>`:UTF-8、无 BOM、无 `\r`、以**单个**换行结尾。

## 5. 硬校验

在仓库根目录运行:

```bash
node SD/scripts/check-translation.mjs <源文档> LD/drafts/<doc> \
  --translatable <frontmatterTranslatable,逗号分隔> \
  --glossary LD/glossary/glossary.json \
  [--min-cjk-ratio 0.2 --cjk-punctuation]   # profile 里该语言 cjk: true 时两项都加上
```

在**仓库根目录**运行即可(任务流程里用 `tr.mjs check --job …`,效果相同;锚点核对内置了与 `github-slugger` 等价的 slug 规则,不依赖任何包,在哪里运行都会核对)。

输出 JSON `{ok, hard, soft}`,退出码 0/1。

- **硬校验(任一失败即不合格)**:frontmatter 键集合与顺序一致且非翻译字段值相同;fenced 代码块数量与每块内容逐字节一致(`fenceComments: translate` 时只比较注释以外的代码行,忽略注释行、空行与行尾空白);行内代码片段的多重集一致(`inlinePlaceholders: translate` 时允许一对一换成含中文的片段);链接与图片目标序列一致(外部 URL 末尾的 `/` 视为同一目标;仅同文档 `#fragment` 允许变化,且在源里能解析的必须在译文里仍能解析);**CJK 标点**(`--cjk-punctuation`):汉字紧邻的、或行内代码与其后汉字之间的 `, . : ; ! ?` 与括号必须是全角,否则不合格——这类问题是机械的,直接改标点,不要靠复审去发现;标题数量与级别序列一致;每张表格的行数与列数一致;HTML 标签名称的多重集一致;格式(UTF-8、无 BOM、无 `\r`、单个结尾换行)。
- **软校验(只产生 `flags`)**:非代码文本里的数字多重集不一致(`numbers`);术语表里的词在源正文出现 N 次而首选译法在译文里出现少于 N 次(`glossary`,按次数对比,不是"出现过就算");术语表里**同一个首选译法对应两个不同源词、且两词都出现在本文**(`term-collision`,例如"代理"既是 agent 又是 proxy 的译法,读者分不清——这是术语表自己要裁决的问题,不是译文的错,留在 flags 里等人处理)——逐条核对:确实该用首选译法却用了别的说法或"本工具/该"之类代称的,改回首选译法;确属自然省略的,在 `flags` 里留一句说明;疑似残留大段原文(`untranslated`)。把软校验的 `check` 名与摘要写进 `flags`。

不合格就按报告修草稿,**最多重试 2 轮**;仍不合格 → 记 `doc_failed`(`status=failed`),`attempts` 加 1,草稿留在 `drafts/`,继续下一篇。`attempts` 达到 3 记 `blocked`。

## 6. 复审(独立于翻译)

用全新的子代理(没有就在主会话里换一遍"只对照原文找错"的视角),给它源文、译文、本篇术语表与风格笔记(可以一并附上 `doNotTranslate` 清单),要求按"漏译 / 误译 / 术语不一致 / 语气与排版"逐项列出具体问题与建议改法。你逐条核实后修正确有其事的问题,再回到第 5 步硬校验一次;没有把握的问题不改,记入 `flags`(如 `review: <一句话>`)。复审只做一轮。复审里反复出现的同类问题是风格笔记的素材(见 `glossary-and-style.md`)。

## 7. 落盘与记账

硬校验通过后:

1. 临时文件 + `mv` 写到 `LD/content/<doc>`(目录不存在就创建);删除对应的草稿(这是唯一允许删除的文件类型,且仅限已成功转正的草稿)。
2. 有 `flags` 记 `done_flagged`,否则 `done`;算 `translationSha256`(`sha256sum`)。
3. **用一条命令记账**(任务流程里就是 `tr.mjs finalize --job …`,它还会记录模型与成本、`termTargets` 和源文基线副本;下面是手工用的底层命令。哈希由脚本从文件算出,不要手填,也不要自己拼快照):

   ```bash
   node SD/scripts/statectl.mjs doc finalize --dir STATE --run <runId> --doc <doc> \
     --source <源文档> --translation LD/content/<doc> \
     --status done|done_flagged [--flags '["glossary: …"]'] --attempts <n> \
     --glossary-version <当前版本> --glossary-sha256 <glossary.json 的 sha256> --source-revision <源版本标识>
   ```

   它会同时计算源文与译文的 sha256(两者相同则拒绝)、追加台账 `doc_done`、备份并原子更新快照。有 `flags` 必须用 `done_flagged`。
4. 进入术语入库。
