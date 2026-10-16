---
id: "trees-oss"
title: "Trees 开源项目"
type: "开源 / 工具 / AI"
created: "2026-10-16"
updated: "2026-10-16"
forest_id: null
root_path: "F:/项目/Trees"
branches:
  - branch_id: "design"
    model: "claude-opus-5-5"
    role: "规格与核心数据层"
    output: "tools/src/core/seed.js"
    cost: 1.5
    outcome: "good"
    seeds_planted: ["seed-0001", "seed-0003"]
  - branch_id: "impl"
    model: "gpt-6-astra"
    role: "大树与森林模块"
    output: "tools/src/core/tree.js"
    cost: 1
    outcome: "good"
    seeds_planted: ["seed-0003", "seed-0004"]
  - branch_id: "close"
    model: "deepseek-v4-flash"
    role: "CLI / 验证 / 收口"
    output: "tools/bin/cli.js"
    cost: 0.3
    outcome: "good"
    seeds_planted: ["seed-0002"]
seeds: ["seed-0001", "seed-0002", "seed-0003", "seed-0004"]
---
## 项目做了什么
一套「类人脑的 AI 经验生态」:项目长成大树,经验结成种子。
核心是**按需抽象** —— 种子先保持具体,浇水(复用)攒够证据才合成模式。

## 关键决策
- 数据用 Markdown + YAML frontmatter,人可读、git 友好,不锁进数据库
- core 零依赖,只用 Node 标准库 —— 谁都能 `git clone` 就跑
- 状态机不是装饰,它就是「抽象延迟」的实现

## 复用说明
下次做同类工具:直接搬这棵树。踩过的坑都在挂着的种子里,
尤其 seed-0003(YAML 空数组)—— 那是最容易埋雷的地方。
