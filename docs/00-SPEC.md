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
│   └── 02-用法.md
├── forest\                     ← 数据区
│   ├── trees\
│   ├── seeds\
│   ├── box\
│   ├── leaves.log
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
