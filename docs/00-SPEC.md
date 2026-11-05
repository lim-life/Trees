# Trees — 规格书 v1.0

> 类人脑的 AI 经验生态。项目长成大树,经验结成种子,种子会生长、互补、合成、休眠。
> 目标:让 AI 用完就走 → 变成 **越用越懂你**。

---

## 一、核心概念

| 元素 | 含义 | 存哪 |
|---|---|---|
| 🌳 **大树 Tree** | 一个项目的完整档案(可整体复用) | `forest/trees/<tree-id>.md` |
| 🌰 **种子 Seed** | 项目里产出的**可复用经验**(最小单元) | `forest/seeds/<seed-id>.md` |
| 🍂 **落叶 Leaf** | 无复用价值的杂事(不进系统,只记一行日志) | `forest/leaves.log` |
| 📦 **盒子 Box** | 长期未用的种子(休眠,可召唤) | `forest/box/<seed-id>.md` |
| 🌲 **森林 Forest** | 强关联的项目树群 | tree 文件里的 `forest_id` |
| 🌿 **分支 Branch** | 树上的多 AI 贡献区 | 写在 tree 文件里 |
| 📦 **种子包 SeedPack** | 可分享的种子集合 | 导入导出 zip |

---

## 二、数据结构(精确)

### 2.1 种子 Seed

```yaml
---
id: seed-0001                    # 全局唯一,自动递增
title: MSYS 路径要用 Unix 格式     # 一句话
labels: [Windows, bash, 路径]     # 情境标签,决定和谁关联
state: buried                    # 状态机,见 §4
prev_state: null                 # boxed 之前的状态,召唤时恢复到它(见 §4)
watered: 0                       # 浇水次数(用了+验证通过才 +1)
failed: 0                        # 失败次数
born: 2026-10-16                 # 播种日
last_watered: 2026-10-16         # 最后一次浇水日 —— 入盒判据用它,不用 born
from_tree: hand-sword-radar       # 出自哪个大树
from_branch: claude-opus-5-5      # 出自哪个分支(AI 归属)
planter: zzx                     # 植树人(本地身份);自己种的召回权重最高
origin: native                   # native(自己长的) | external(导入的)
confidence: 1.0                  # native=1.0, external 初始 0.5
bloodline: []                    # 合成来源 seed id 列表
synthesized_into: null           # 被合成进哪个高级种子
evidence: ""                     # 原始证据指针(文件路径/会话 id)
---

## 判据
什么时候该用它(必需)

## 做法
怎么做(必需)

## 不适用
什么时候别用(必需 —— 这是抽象最容易丢的东西)

## 旁证
原始项目里的具体记录(可选)
```

### 2.2 大树 Tree

```yaml
---
id: hand-sword-radar
title: 手与剑居家雷达
type: 工业设计 / 硬件 / 演示
created: 2026-09-20
updated: 2026-10-16
forest_id: null                  # 强关联时填父树 id
planter: zzx                     # 植树人;自己种的树权重最高
curator_note: 从结构分析到 14 页可演示的原型   # 人写备注,不参与任何计算
curator_note_source: migrated-plaque  # human | model | migrated-plaque
index:                            # 坐标牌:确定性,不用模型,可由 reindex 逐字节重建
  domain: design                  # 闭集
  artifact: slides                # 闭集
  size: medium                    # 由种子数推出
index_refs:                       # 指针,不是摘录;渲染时现读种子正文
  - seed: seed-0012
    section: 判据
  - seed: seed-0012
    section: 不适用
labels: [工业设计, 硬件, 演示]      # 标签:别人先按标签判断要不要打开
root_path: F:\项目\双手雷达PPT\
branches:
  - branch_id: design
    model: claude-opus-5-5
    role: 设计规范
    output: 设计规范.md
    cost: 1.2
    outcome: good                # good | mixed | bad
    seeds_planted: [seed-0012, seed-0015]
  - branch_id: impl
    model: gemini-3.8-flash
    role: 14页代码实现
    output: index.html
    cost: 0.8
    outcome: mixed
    seeds_planted: [seed-0018]
seeds: [seed-0012, seed-0015, seed-0018]
---

## 项目做了什么
## 关键决策
## 复用说明(下次同类项目怎么搬这棵树)
```

### 2.3 落叶 Leaf(极简日志)

```
2026-10-16 14:32  换壁纸    无复用价值
2026-10-16 15:10  打开软件  无复用价值
```

---

## 三、规则(严格执行)

### 规则 1 — 落叶不进种子库
**判据:这次有没有产生「下次还能用的判断」?**
- 有 → 种子
- 没有 → 落叶(只记一行)

### 规则 2 — 同项目搬旧大树
- 已有同类项目 → 直接复用旧大树(不重新长)
- 大树不重复播种
- **只有这次的新想法单独播种**

### 规则 3 — 低关联只邻接,互补才合成
- 低关联(仅共享 1 个标签)→ **只做邻接标记,不合成**
- 互补 → 合成

### 规则 4 — 强关联由人指定
- 用户指定新项目与某旧项目强关联 → 新树的种子挂到旧树下
- `forest_id` 指向旧树,形成森林

### 规则 5 — 互补判据(两种)
| 类型 | 判据 | 例 |
|---|---|---|
| **补位型** | A 的「不适用条件」正好是 B 的「适用场景」 | A=MSYS用`/dev/null` ✗原生PS<br>B=原生PS用`NUL` ✗MSYS |
| **串联型** | 完成一个任务需要 A **然后** B | A=检测串口 → B=烧录固件 |

### 规则 6 — 合成不删原件
- 合成后原种子保留,只标 `synthesized_into: <新id>`
- 可回拆

### 规则 7 — 人人都是植树人,自己的树权重最高
- 每颗种子、每棵大树都记 `planter`(本地身份,来自 `forest/config.json`)
- 召回排序:**自己种的 > 本机导入的 > 陌生人共享的**
  - 自己的树:权重 1.0
  - 他人/导入的树:按 `confidence` 降权(external 初始 0.5,验证 3 次升满)
- 权重只影响**召回排序与可见度**,不改 `watered` / `state` / `last_watered`
- 权重是「信任的先后」,不是「谁更对」——别人的树被浇水够多,一样能反超

### 规则 8 — 树牌先行,详情按需
- 每棵大树必须有一块**树牌**,分两层:**坐标牌 `index`** 与**估值牌 `estimate`**
- **坐标牌**(确定性,不用模型,播种即有):领域(闭集)+ 产出物 + 规模 + 触发(逐字摘自种子「判据」)+ 边界(逐字摘自种子「不适用」)
- **估值牌**(模型生成,必须带 `basis` / `at` / `model` / `version`,可 `reindex` 重算):D1 抽象度 / D3 先验 / D4 风险
- 列表、索引、`forest/index.md` **只显示坐标牌**,不展示正文
- 完整内容(`项目做了什么` / `关键决策` / `复用说明`)只在 `trees tree <id>` 时打开
- 树牌是**视图**不是**结论**:删掉后必须能从原件(tree + seeds + events)完整重建
- 估值牌**只做同分打破平局**,永不参与过滤、合并、降权
- `provisional: true`(该树还没有任何种子被 water 过)的树牌不参与排序,只显示「尚未验证」
- 树牌里不允许出现替代性概括;需要人写推荐语用 `curator_note`,标明作者手写、不参与计算
- 树牌**不是抽象**,只是入口;正文里具体经验原样保留,不因树牌丢掉上下文

> 证据阶梯、结构分层与两类先知的完整规则见 [03-共享森林框架.md](03-共享森林框架.md)。

---

## 四、状态机

```
buried(埋土)
   │ 浇水 1 次
   ▼
sprouting(发芽)
   │ 浇水 ≥2 次
   ▼
growing(成长)
   │ 合成 或 浇水 ≥5 次
   ▼
advanced(高级)
   
任意状态 ── 6 个月未浇水 ──→ boxed(入盒)
boxed ── 被召唤使用 ──→ 回到原状态
```

---

## 五、白天 / 黑夜

### ☀️ 白天(人主导)
| 时机 | 动作 |
|---|---|
| 会话开始 | 检索种子(标签精确 + 语义模糊双层) + **发散列表**(列 3-5 颗低相关) |
| 会话结束 | 提取新种子 + 写入 |

### 🌙 黑夜(系统自跑,**受预算约束**)
| 周期 | 动作 |
|---|---|
| 每次播种后 | 关联扫描(新种子 vs 全库,生成候选关联) |
| 每晚 | **做梦循环**:抽 3-5 颗种子 → 试组合 → 写「灵感池」 |
| 每周 | 翻盒子(休眠种子重新评估) |
| 每月 | 健康检查(淘汰/合并/标签生长) |

**预算控制(硬性):**
- 每次做梦最多抽 5 颗、最多跑 10 分钟
- 全部可开关
- 月度预算上限,超了自动停

---

## 六、多 AI 分支

**每个 AI 的贡献 = 树上一个分支。**

用途:积累后自动生成 **AI 能力画像**
```
模型               出种数   成活率   擅长
claude-opus-5-5    8       100%     设计/规范
gemini-3.8-flash   12      60%      快,粗
deepseek-v4-pro    6       100%     排查/收口
```
→ 直接喂给派单决策(谁适合干什么)

---

## 七、三种起步方式

| 方式 | 命令 | 适用 |
|---|---|---|
| **空手开局** | 直接做项目 | 新用户(推荐) |
| **批量提取** | `trees plant --dir <路径>` | 已有笔记/旧项目 |
| **种子包导入** | `trees import <包.zip>` | 想快速起步 |

**空库时必须静默工作,不报错**,提示友好:
```
🌱 还没有种子 —— 直接开始做项目吧,做完会自动播种。
```

**导入的种子区别对待:**
```yaml
origin: external
confidence: 0.5        # 初始半权重
```
连续验证成功 3 次 → `confidence` 升到 1.0

---

## 八、技术架构

```
        core(框架无关,零依赖)
        ├── seed/tree/forest  数据模型
        ├── plant/water/synthesize/dream/box/health
        └── store(文件读写)
                 ↓
        adapters(接入各种环境)
        ├── mcp.js          通用 MCP 服务器
        ├── claude-code.js  ~/.claude.json + skills
        ├── cursor.js       ~/.cursor/mcp.json
        ├── codex.js        AGENTS.md
        ├── gemini.js
        └── standalone.js   自带 LLM(无框架也能用)
                 ↓
        llm(仅独立模式用)
        ├── openai.js  anthropic.js  ollama.js
```

**依赖策略:**
- core: 零依赖(Node 标准库)
- MCP: `@modelcontextprotocol/sdk`(唯一外部依赖)
- 独立模式: 原生 fetch

---

## 九、CLI 命令表

```
初始化
  trees init [--dry-run]          检测环境 + 配置 + 建目录
  trees uninstall                 干净卸载

种子操作
  trees plant <项目路径>           从项目播种
  trees plant --dir <目录>         批量提取
  trees water <seed-id> [--ok|--fail]   浇水
  trees find <关键词>              检索(含发散列表)
  trees show <seed-id>             看种子详情
  trees edit <seed-id>             编辑

生态操作
  trees synthesize <id1> <id2>     合成(自动判定互补)
  trees box <seed-id>              入盒
  trees summon <seed-id>           召唤出盒
  trees forest <child-tree> --under <parent-tree>   建森林
  trees dream [--limit N]          手动做梦
  trees health                     健康检查
 
种子包
  trees import <包.zip>
  trees export <tree-id> -o <包.zip>

状态
  trees status                     总览(种子数/树数/推荐)
  trees profile                     ★ AI 能力画像
```

---

## 十、文件组织

```
Trees\
├── README.md
├── docs\
│   ├── 00-SPEC.md              本文件
│   ├── 01-种子法.md
│   ├── 02-用法.md
│   ├── 03-共享森林框架.md       证据阶梯 / 分层 / 先知
│   ├── 04-联邦与防护.md         Git 联邦、选择性发布、防护顺序
│   ├── 05-代码优先架构.md        哪些由程序做，哪些才交给 AI
│   └── 06-进展记录.md            2026-10-25 → 10-29 做了什么、缺什么
├── forest\                     ← 数据区
│   ├── trees\
│   ├── seeds\
│   ├── box\
│   ├── leaves.log
│   ├── events.jsonl             ← 事件账本（append-only：谁在何时做了什么）
│   └── index.md
├── tools\                      ← 程序区
│   ├── package.json
│   ├── bin/cli.js
│   └── src\
│       ├── core\
│       ├── adapters\
│       └── llm\
└── examples\                   ← 示例
```

**三层不混:数据在 forest,程序在 tools,说明在 docs。**

---

## 十一、成长预期(写进 README)

```
0-10 颗种子      几乎没感觉 —— 别急着下结论
10-50 颗        开始偶尔命中
50-200 颗       明显省事,同类项目快一半
200+ 颗         真正的举一反三
```

---

## 十二、铁律

1. **落叶不进库** — 防垃圾塞满
2. **空库不报错** — 新用户不被劝退
3. **合成要人审** — 抽象不可逆
4. **原件不删** — 可回拆
5. **导入降权** — 别人的经验先存疑
6. **黑夜限预算** — 不能自动烧钱
7. **幂等 + 备份 + 可卸载** — 部署体验
8. **入库要有闸门,且必须署名** — 「算不算经验」交给模型判断,但「能不能进库」由代码否决:
   三段齐全 / 边界不是空话 / 单段不过长 / 能追到是哪个 AI 写的。
   被拒的进 `forest/quarantine/`,**不删除**,复核后可放行。
   规矩不能靠自觉 —— 接进来的任何 AI 都可能往库里灌垃圾。
9. **配置跟着机器走,不跟着森林走** — 模型与 key 属于这台机器(`~/.trees/config.json`),
   森林是纯数据,拷到哪都还是数据。缺配置必须报错,不能静默降级。
10. **先验不是判决,系统里没有「永远」** — 分类、标签、初始置信度只决定**起点**;
   每个派生出来的权重/排序/状态,都必须有一条由证据驱动的通道能把它翻回来。
   标注会错、会缺;静态惩罚一旦错就是终身错,系统就失去自愈能力,而这套系统的全部赌注就是自愈。
