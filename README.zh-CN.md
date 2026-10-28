> 🌏 [English](README.md)

# 🌳 Trees

> 一个会自己长大的经验森林 —— 项目长成大树，可复用的判断结成种子。先保持具体，复用够了再抽象。
>
> 长远目标：让知识跨会话、跨项目、跨人累积 —— 不靠投票，靠证据、独立复现和时间。

项目有完整档案，经验可以单独复用。留下的种子会生长、互补、合成，长期用不到的就先休眠。

`零依赖` · `本地优先` · `纯文件存储` · `框架无关` · `MIT`

---

## 为什么做这个

那天正在和 AI 聊项目，聊到一半，屏幕上突然跳出一行红字：上下文最多只能装 1,048,576 tokens，我这次发出去的是 1,049,359，就多了 783 个。整个会话当场废掉，前面聊的也全没了。

后来我才想清楚：**爆上下文只是症状，不是病。**

真正的病是，每个 AI 会话都是一次性的。背景要重讲，踩过的坑还要再踩，好不容易试出来的判断，会话一关就带不走；换个项目，同样的弯路再走一遍。往上下文里塞得再多，也只是把临时记忆撑大，经验仍然没有地方去。

再往远看一层：如果每个人的 AI 都各自从零学起，那些真正有用的判断会在世界里被反复重新发现。Trees 想给经验一个能留下来的地方 —— 先在自己机器上长成一片森林；再往远，是一片共享森林，人和 AI 可以沿着血缘学习、复现、纠正，而不是让投票和热度决定什么是对的。

所以我做的不是「更大的上下文」，而是**在正确的时刻，把正确的那几条经验送进上下文**。

## 核心机制：用够了再抽象

SkillEvolBench 等研究发现，从经验里蒸馏出的技能，效果常常还不如直接使用原始轨迹。我的理解是，蒸馏容易留下做法，却把当时为什么这么做、什么情况下才适用给省掉了。经验还没用上几次，就急着总结成通用规则，很多重要细节也就跟着丢了。

所以 Trees 先把具体经验留下来，后面的事慢慢做：

```
现有做法（过早抽象）   项目完成 → 立刻蒸馏成技能        ← 丢上下文
Trees（按需抽象）      项目完成 → 播种，保持具体
                      → 浇水（复用）攒够证据
                      → 才合成高级种子 = 模式         ← 归纳，不是猜测
```

说白了，浇水就是在数复用证据。`buried → sprouting → growing → advanced` 这套状态机，负责让抽象晚一点发生。

要让这个思路成立，下面三条得一起守住：

| 约束 | 含义 |
|---|---|
| 抽象延迟 | 种子生来是具体经验，不会自己变成模式；只有复用次数攒够了，或者参与了合成，才会升级 |
| 互补才合成 | 合成看的是互补，不是相似。而且互补分强弱，见下。只共享 1 个标签的低关联种子只做标记，不合成 |
| 原件不删 | 合成后原种子照样保留，标上 `synthesized_into`，随时可以拆回去 |

判断互补要看两面:**交集**(两边重合多少)和**并集**(合起来覆盖多广)。
重合多说明是同一件事,覆盖变宽才是真的更完整 —— 只看一面都会误判。

| 成色 | 意思 | 该怎么办 |
|---|---|---|
| 串联 | 一颗是另一颗的前置，先 A 才能 B | 必须绑在一起 |
| 强互补 | 各补一块，一方不灵的地方正是另一方的主场，合起来更完整 | 值得合成 |
| 部分互补 | 有补充，但不是新维度，合起来只强一点 | 可以合，收益一般 |
| 等价 | 两边说的是同一件事，合起来不增加信息 | 没必要合 |
| 互斥 | 同一个情境，却给了相反的做法 | 绝对别合，先搞清谁对 |

如果只有后面的那颗、前置还没出现，它就挂在那儿等 —— `trees waiting` 能看见谁在等什么，
等那东西真被播种进来时，`trees new` 会提示「这颗可能正是别人在等的」。

`trees candidates` 会把几种分开列出来，互斥的直接拒绝合成。
判定逻辑在 `synthesize.js`：先排掉互斥和等价，再认强互补。

## 用起来是这么转的

```
项目开始
  │
  ├─ 会话开始 → 注入库目录 + 当前项目的接续点
  │    └─ 干活：recall 召回【已完成项目】的种子 → 用上并验证 → water
  │
  ├─ 会话结束 → 只记录，不播种
  │    ├─ AI 总结这次做了什么 + 列出未完成事项
  │    ├─ 判断项目状态：ongoing / complete / unknown
  │    ├─ 生成会话节点（钥匙 s-XXXXXXXX），指向上一个会话
  │    └─ 写 .trees/last-key，下一次自动接上
  │
  ├─ 同一项目继续开会话 → 形成链 A → B → C
  │
  └─ 项目完成（AI 判断 + 条件满足）
       ├─ 选中的链合并成项目大树 TREES
       ├─ ★ 这时才第一次播种：从整条链的材料里提取种子
       ├─ 会话树标 merged_into，原件保留
       └─ 旁支：单独播种（plant-branch）或回收（recycle）

之后
  种子：浇水 → 生长 → 互补合成（人审）→ 高级种子 → 长期不用入盒
  会话树：无人接续 → 枯树休眠 → 回收
```

一个长项目可以跨很多会话，但**只有完成的项目才会播种**。做了一半放弃的会话树只是原料，不会往经验库里放半成品判断。

同一类情境反复用够 5 次，又碰上互补的伙伴，种子才有资格合成为更高级的经验。长期用不上的，先收进盒子，等哪天需要了再召唤回来。

## 概念

项目里用了几个名字，含义和存放位置都在这里：

| 元素 | 含义 | 存哪 |
|---|---|---|
| 大树 Tree | 一个项目的完整档案，可以整体复用 | `forest/trees/<id>.md` |
| 种子 Seed | 项目产出的可复用经验，是最小单元 | `forest/seeds/<id>.md` |
| 落叶 Leaf | 没有复用价值的杂事，只记一行日志，不进库 | `forest/leaves.log` |
| 盒子 Box | 长期没用的种子（休眠，可以召唤回来） | `forest/box/<id>.md` |
| 森林 Forest | 强关联的项目树群（`forest_id` 指向父树） | 写在 tree 里 |
| 分支 Branch | 树上多个 AI 的贡献区，用来积累 AI 能力画像 | 写在 tree 里 |
| 植树人 Planter | 种下这棵树的人。自己的树召回权重最高，别人的按 `confidence` 降权 | 写在 seed / tree 里 |
| 树牌 Plaque | 一句话总结 + 标签。看别人的树先看树牌，需要才打开正文 | 写在 tree 里 |

共享森林的层级、证据阶梯与两类先知见 [docs/03-共享森林框架.md](docs/03-共享森林框架.md)。

总不能什么杂事都往库里放。要不要留成种子，我只问一句：这次有没有产生下次还能用的判断？有就留下，没有就记成落叶。

## 快速开始

需要 Node.js ≥ 20，没有依赖要装。

```bash
git clone https://github.com/lim-life/Trees.git
cd Trees/tools

node bin/cli.js help        # 看命令
node tests/run.mjs          # 跑自测（120 项）
```

想先翻翻现成的数据，仓库里有一个样例森林。里面的 4 颗种子，都是做 Trees 时自己踩过的坑：

```bash
TREES_HOME=../examples/demo-forest node bin/cli.js status
TREES_HOME=../examples/demo-forest node bin/cli.js tree trees-oss
TREES_HOME=../examples/demo-forest node bin/cli.js show seed-0003
```

Windows PowerShell 下用 `$env:TREES_HOME="..\examples\demo-forest"; node bin/cli.js status`。

也可以从自己的一颗种子开始：

```bash
node bin/cli.js new "MSYS 里要用 /dev/null 而不是 NUL" --labels Windows,bash
node bin/cli.js ls
node bin/cli.js water seed-0001
node bin/cli.js status
```

要在全局使用 `trees` 命令：

```bash
cd Trees/tools && npm link
trees status
```

数据默认放在 `./forest`，想换位置就设 `TREES_HOME`：

```bash
TREES_HOME=/path/to/my-forest trees status
```

## 蒸馏（按需蒸馏 —— 这个项目的核心）

```
  trees candidates                 扫全库，找出互补的种子对
  trees synthesize <a> <b>         把两颗互补的种子蒸馏成一颗高级种子
  trees unsynthesize <id>          拆回原件（原件一直都在，合成从不删东西）
  trees waiting                    列出正在等前置的种子
  trees need <id> --for "<前置>"    登记前置（种子 id 或还没出现的描述）
```

## 文件长什么样

数据都存在能直接读的 Markdown 里，可以用 git 管，拷到别处照样用，也不用搬数据库。

一颗种子是这样的：

```markdown
---
id: "seed-0001"
title: "MSYS 路径要用 /dev/null 而不是 NUL"
labels: ["Windows", "bash", "路径"]
state: "growing"
prev_state: null
watered: 3
failed: 0
born: "2026-10-16"
last_watered: "2026-10-16"
from_tree: "radar"
from_branch: "claude-opus-5-5"
origin: "native"
confidence: 1
bloodline: []
synthesized_into: null
evidence: ""
---
## 判据
在 MSYS/Git Bash 里写路径时用。

## 做法
用 `/dev/null`，不要用 Windows 的 `NUL`。

## 不适用
原生 PowerShell / cmd 环境 —— 那里 `NUL` 才对。
```

正文分成判据、做法、不适用三段。我最在意的是最后那段：总结经验时很容易把适用边界省掉，结果做法记住了，换个环境照着用，又踩一次坑。

一棵树是这样的：

```markdown
---
id: "radar"
title: "手与剑居家雷达"
type: "工业设计"
created: "2026-09-20"
updated: "2026-10-16"
forest_id: null
root_path: "F:/项目/双手雷达PPT"
branches:
  - branch_id: "design"
    model: "claude-opus-5-5"
    role: "设计规范"
    outcome: "good"
    seeds_planted: ["seed-0012"]
seeds: ["seed-0001"]
---
## 项目做了什么
## 关键决策
## 复用说明
```

## 命令行

```
种子
  trees new "<标题>" [--labels a,b] [--from <文件.md>] [--needs "<前置>"]   手动播种一颗种子
  trees plant <项目路径>           从做完的项目里提取种子（要配模型）
  trees plant <路径> --dry-run     只看看会提出什么，不落盘
  trees ls [--state <状态>]        列出种子
  trees show <seed-id>             看种子详情
  trees water <seed-id> [--fail]   浇水（成功 +1 并推进状态；--fail 记失败且不推进）
  trees find <关键词>              按标题 / 标签 / 正文检索
  trees recall "<任务描述>"         召回该带进上下文的种子（默认 5 颗 / 4000 token）
  trees box <seed-id>              入盒（休眠）
  trees summon <seed-id>           召唤出盒
  trees sweep                      把 180 天没浇水的种子送进盒子

大树 / 森林
  trees trees                      列出所有大树
  trees tree <tree-id>             看一棵树（含挂在它下面的种子）
  trees forest <子树> --under <父树>   建强关联（自动防环）

项目链（长项目跨会话）
  trees tip                        看当前接续点、上次会话和未完成事项
  trees use <s-XXXXXXXX>           回档 / 切换接续点
  trees finish <s-XXXXXXXX>        合并会话链并首次播种
  trees unfinish <proj-id>         拆回项目树
  trees plant-branch <s-XXXXXXXX>  把旁支单独播种
  trees recycle <s-XXXXXXXX>       旁支回收（休眠）
  trees plant-project <proj-id>    重新播种一个项目

黑夜循环（系统自跑）
  trees dream [seed-id...]         今晚该学哪几颗（只出计划，不花钱）
  trees dream --run                真去学（要配模型）
  trees dream --config             看现在配的是哪个模型
  trees grow                       看自然生长装没装
  trees grow --show                只打印它会往你电脑上写什么，不动系统
  trees grow --install [--at HH:MM] 装上（默认 03:17）
  trees grow --uninstall           卸掉
  trees config [--from-env]        把模型配置存下来（定时任务读的是这份）

环境
  trees index                      生成 forest/index.md（几 KB 的目录，给新会话注入）
  trees index --print [--if-any]   只打印不落盘；--if-any 空库时什么都不输出
  trees init [--dry-run]           初始化数据目录（幂等）
  trees status                     总览 + AI 能力画像
```

`trees status` 也会根据已有数据算一张 AI 能力画像：

```
AI 能力画像 (越用越准 → 直接喂给派单决策)
   claude-opus-5-5        出种   8   成活率 100%
   gemini-3.8-flash       出种  12   成活率  60%
```

每颗种子的 `from_branch` 都记着它由哪个 AI 产出。等数据攒起来，给模型派活时就能翻翻这些记录，看看谁留下的经验更经得住复用，不必全凭印象。用得越多，这张画像也会越准。

## 状态机

```
buried ──浇水1次──▶ sprouting ──浇水≥2──▶ growing ──浇水≥5 或 被合成──▶ advanced
  ▲                                                                      │
  └──────────── 任意状态 ──180 天未浇水──▶ boxed ──被召唤──▶ 回到 prev_state ──┘
```

状态变化只看 `watered` 的次数，以及距 `last_watered` 过了多久。时间从上次使用算起，`born` 不参与。

`failed` 也不参与状态计算。失败会记下来，作为判断种子质量的证据，但不会让种子降级。入盒同样按 `last_watered` 算：种得再早，只要一直有人用，就该留在库里。

## 会话链与项目完成

长项目跨会话，所以会话不是项目，**会话树只是原料**：

- **会话树** `s-XXXXXXXX`：一次会话的总结、未完成事项、接续指针。
- **项目大树**：一条会话链合并而成，代表一个**已完成**的项目。
- **种子只从项目大树里出**。项目没完成，一颗都不播。

```bash
trees tip                       # 当前接续点、上次会话、未完成事项
trees use s-7F3KQ2M1            # 回档：从这个节点重新开一条分支
trees finish s-7F3KQ2M1         # 合并链并首次播种
trees unfinish proj-7F3KQ2M1    # 拆回
trees plant-branch s-XXXX       # 旁支单独播种
trees recycle s-XXXX            # 旁支回收
```

自动模式：

```bash
trees auto --enable             # 会话结束自动记录（默认关闭）
trees auto --finish             # 项目完成时自动合并并播种
trees auto --status             # 看开关、模型和最近回写
```

完成判断由本机 AI 做：`complete` + 没有未完成事项 + 没有后续会话，且（用户明确说过完成，或连续两次判断 complete）才会合并。**会话结束本身不算完成。**

旁支（没被选进合并链的分支）默认休眠，不会自动播种——低权重的半成品判断混进库里，只会让召回变脏。要它的经验就 `plant-branch`，不要就等回收。

会话文本会发给配置的模型，发送前会遮掉疑似密钥。

## 让它在夜里自己学

挑谁由系统定：闲置 30~150 天的种子，用得越少越优先，一晚最多 5 颗、每颗最多 4000 token。

**用哪个模型由你配** —— 每个人用自己的 key，谁也不占谁的便宜：

```bash
export TREES_LLM_BASE_URL=https://api.deepseek.com/v1
export TREES_LLM_API_KEY=sk-...
export TREES_LLM_MODEL=deepseek-chat

trees dream          # 先看今晚打算学哪几颗
trees dream --run    # 真去学
```

只要接口是 OpenAI 兼容的都能用。学习这活不需要贵模型，手头最便宜的那个就行。

**学习不算浇水。** 夜里学到的只是见识 —— `evidence` 和正文会被补充，
但 `watered`、`state`、`last_watered` 一个都不动。资历只能靠真用过。

## 自然生长

觉得手动跑麻烦，可以让它自己长 —— 每天在你不用电脑的时段学一会儿：

```bash
trees config --from-env    # 先把模型配置存下来（定时任务读的是这份，不是你的 export）
trees grow --show          # 先看看它会往你电脑上写什么 —— 什么都不会动
trees grow --install       # 真装（默认 03:17，可用 --at 改）
trees grow                 # 看装没装、上次跑了什么
trees grow --uninstall     # 卸掉
```

装的东西就两样：一个包装脚本（`~/.trees/grow.*`），和一条每天定点的计划任务
（Windows 用计划任务，macOS / Linux 用 crontab）。日志在 `~/.trees/grow.log`。

**装之前先跑 `--show`。** 它会一字不差地打给你看要写什么文件、注册什么命令 —— 一个按钮都不按。

## 三种起步方式

可以边做项目边积累，也可以从旧资料或别人的种子包开始：

| 起点 | 怎么用 |
|---|---|
| 空手开局 | 直接做项目，做完自然播种。空库不会报错，只给一句友好的提示 |
| 批量提取 | `trees plant <路径>`，从做完的项目或笔记里提取种子 |
| 种子包导入 | `trees import <包.zip>`，站在别人的肩膀上。导入的种子 `confidence` 初始为 0.5，验证 3 次后升满 |

种子包导入（`trees import`）还在计划里；批量提取已经能用了。

## 框架无关

核心只处理逻辑和文件，不依赖 AI 框架。不同环境通过适配器接入，目前做完的只有 CLI：

| 接入 | 给谁用 | 状态 |
|---|---|---|
| CLI | Codex CLI / Gemini CLI / 任何能跑 shell 的 | 已可用 |
| MCP 服务器 | Claude Code / Cursor / Cline / Windsurf / Zed… | 未实现 |
| Skill 文件 | Claude Code | 未实现 |
| standalone | 自带 LLM、一个框架都不用的人 | 未实现 |

## 现在能跑什么，还欠什么

前面说了不少打算，实际写完的范围也得交代清楚。

核心数据层和整条会话链路都跑通了，194 项自测全部通过：

- `frontmatter.js`：零依赖的 YAML 解析和序列化，正确处理中文、冒号、引号、对象数组和一层嵌套对象
- `seed.js`：种子模型，状态机、浇水、失败记录、入盒/召唤、id 分配；`planter` 身份；证据字段（L0–L5 / 外部 ID / 撤回 / 血缘）
- `tree.js`：大树模型，分支、挂载种子、复用说明；树牌 `plaque` / `labels` / 植树人
- `share.js`：选择性发布 —— 默认私有，只打包选中的树；manifest 记录每个文件的 sha256
- `forest.js`：森林关系，树群之间自动防环
- `leaves.js`：落叶日志
- `events.js`：append-only 事件账本（plant / water / fail / box / summon / tree）；哈希链，`trees events --verify`
- `dedup.js`：查重 —— 归一化 + 精确哈希 + 近重复；`--ai` 判同义；播种时精确重复自动复用
- `scorer.js`：统一向量打分（D1 抽象度 / D2 领域 / D4 风险 / D3 先验），带版本与缓存；不参与真假与投票
- `stats.js`：纯本地统计（状态/植树人/事件/调用），不调模型
- `space.js`：检索空间 —— 文本 n-gram 召回 + 四维过滤；管理 AI 出查询计划
- `recall.js`：任务描述 → top-k 种子 + token 预算 + 发散列表；自己的树权重最高
- `indexer.js`：`forest/index.md`，只显示树牌
- `session.js` / `project.js`：会话链、完成判定、合并成项目大树、首次播种、回拆
- `synthesize.js`：互补判定 + 合成 + 血统 + 回拆
- `dream.js`：黑夜循环 —— 挑该学的种子、守预算、真去学（只补见识，不涨资历）
- `plant.js`：从做完的项目里提取种子；跳过草稿目录、文档优先、截断自动重试
- `hooks/`：SessionStart 注入索引与接续点，SessionEnd 自动记录
- `bin/cli.js`：前面命令表里的全部命令

还欠：

- 查重：归一化 → 精确哈希 → MinHash → AI 语义判定（共享层的前置）
- 共享森林的证据命令：`evidence` / `retract` / `conjecture` / `resolve` / `centrality`
- `health` / `import` / `export`
- MCP、Skill、standalone 适配器
- 第一次真实项目落盘（目前只做过 dry-run）

## 路线图

1. v0.1：核心数据层 + CLI（已完成）
2. v0.2：`plant` / `synthesize` —— 「项目 → 种子 → 合成」全链路（已完成）
3. v0.3：会话链 + recall + 自动回写（已完成）
4. v0.4：植树人身份 / 事件账本 / 证据字段 / 树牌（已完成）
5. v0.5：查重 + 真实播种验证 + MCP 适配器（进行中）
6. v1.0：种子包导入导出、共享森林证据层

## 现阶段不做

P2P 全节点网络 · 代币发行与融资 · 全球实时同步 · 一次覆盖所有行业

机制先于网络，网络先于货币。这几件事不是被否决，而是顺序不能提前：
在知识质量、查重、证据和撤回被真实使用验证之前，联网只会把垃圾同步得更快。

## 铁律

1. 落叶不进库，免得杂事淹没有用的经验。
2. 空库不报错，从零开始也得能正常用。
3. 合成要人审，抽象时丢掉的细节没法凭空还原。
4. 原件不删，合成随时可以拆回去。
5. 导入的种子降权，别人的经验先留个问号。
6. 黑夜循环限预算，不能自动烧钱。
7. 部署要幂等、有备份、可卸载，别给使用的人添麻烦。

## 成长预期

```
0–10 颗种子      几乎没感觉 —— 别急着下结论
10–50 颗        开始偶尔命中
50–200 颗       明显省事，同类项目快一半
200+ 颗         真正的举一反三
```

## 学术背景

把经验固化成可复用的做法，学术上叫 episodic → procedural memory consolidation，也就是情景记忆向程序性记忆的固化。隔离式记忆和本地存储已经有 Mem0、Letta、Cognee 这些成熟工作；从重复经验里整理出结构化的 know-how，还没有稳定方案，仍然是研究前沿。有篇论文直接写道：“没有任何先前工作形式化了程序性记忆的固化。”

我在 Trees 里想验证的是：先保留具体经验，真正用上几次，攒够证据，再试着抽象。这样总结出来的模式，至少有实际复用作依据，能更接近归纳。

这事儿能不能成立，光我自己用还不够，得有更多人来试。所以把它开源了。

---

## 参与

可以通过 `zzx060427@outlook.com` 联系我，也欢迎直接开 [issue](https://github.com/lim-life/Trees/issues)。

项目还早，现在最缺的是有人把它用到自己的活里，碰到问题再告诉我。

发现 bug 或有新想法，都欢迎提。如果已经用了一阵子，我尤其想知道：留下的种子，你后来真的复用过吗？核心假设只能靠这件事来验证。

反馈时方便的话，带上这些：

1. 使用的版本和系统
2. `node tests/run.mjs` 的输出（自测挂了就贴这个）
3. 你期望发生什么，实际发生了什么

## License

MIT © 2026 张子翔
