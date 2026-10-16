# 样例库：`demo-forest`

一个开箱可看的样例 —— 里面 4 颗种子**全是这个项目自己踩出来的真坑**，不是编的。

## 30 秒看它长什么样

```bash
cd Trees/tools

# macOS / Linux
TREES_HOME=../examples/demo-forest node bin/cli.js status
TREES_HOME=../examples/demo-forest node bin/cli.js ls
TREES_HOME=../examples/demo-forest node bin/cli.js tree trees-oss
TREES_HOME=../examples/demo-forest node bin/cli.js show seed-0003
```

Windows PowerShell 换成：

```powershell
$env:TREES_HOME="..\examples\demo-forest"; node bin/cli.js status
```

## 里面有什么

| 文件 | 一句话 |
|---|---|
| `seeds/seed-0001.md` | MSYS 里要用 `/dev/null`，不是 `NUL` |
| `seeds/seed-0002.md` | 认盘只认序列号，绝不凭盘符 |
| `seeds/seed-0003.md` | YAML 空数组不能写成 `key:` 换行 `[]` |
| `seeds/seed-0004.md` | 长输出必须开流式，否则会被中转站掐断 |
| `trees/trees-oss.md` | Trees 项目本身这棵树（带 3 个 AI 分支） |
| `leaves.log` | 落叶 —— 没有复用价值的杂事，只记一行 |

## 重点看这两个地方

**① 每颗种子正文都是三段**：`判据` / `做法` / **`不适用`**

「不适用」才是种子里最值钱的部分 —— 它回答"什么时候**别**用它"。
抽象最容易丢的就是这块，而丢了它，下次换个环境照搬就会出事。
比如 `seed-0001`：`/dev/null` 在 MSYS 里是对的，**换到原生 PowerShell 就必须用 `NUL`**。

**② 大树上有 3 个分支，每支是一个 AI 干的活**

```yaml
branches:
  - branch_id: "design"
    model: "claude-opus-5-5"
    role: "规格与核心数据层"
    outcome: "good"
    seeds_planted: ["seed-0001", "seed-0003"]
```

攒够几棵树之后，`trees status` 就能算出"哪个模型产出的种子成活率高" ——
**这就是派单决策的数据来源**，而不是拍脑袋。

## 想拿它玩

直接把整个 `demo-forest` 拷到别处当你的数据根，或者：

```bash
TREES_HOME=../examples/demo-forest node bin/cli.js water seed-0003   # 给它浇一次水
TREES_HOME=../examples/demo-forest node bin/cli.js box seed-0001     # 入盒休眠
```

改坏了不要紧 —— `git checkout examples/` 就回来了。
