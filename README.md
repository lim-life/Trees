> 🌏 [中文版](README.zh-CN.md)

# 🌳 Trees

> A brain-inspired ecosystem for AI experience: plant seeds, water them into trees, and the trees bear fruit on their own.

A project becomes a tree; the useful things you learned become seeds. Those seeds can grow, complement one another, merge, or sit dormant until you need them again.

`zero dependencies` · `local-first` · `plain files` · `framework-agnostic` · `MIT`

---

## Why I built this

I was halfway through a project conversation when a red error appeared: the context limit was 1,048,576 tokens, and I'd sent 1,049,359—just 783 too many. The session was dead, along with everything we'd worked through.

That was a particularly abrupt version of a familiar problem. Every AI session starts over: explain the background again, hit the same pitfalls again, lose the lessons when the conversation closes. I kept stuffing more into the context because I had nowhere else to put it.

I wanted those lessons to survive the conversation. That's what I'm building Trees for.

## The core idea: use it before you abstract it

Research such as SkillEvolBench has found that skills distilled from experience often perform worse than the original trajectories. My reading is that distillation tends to preserve the instructions while losing the reasons behind them and the conditions where they apply. Turn an experience into a general rule too soon, and those details disappear before you've learned which ones matter.

So Trees keeps the experience concrete for a while:

```
Common approach (premature)   project done → distill into a skill right away   ← loses context
Trees (on demand)             project done → plant a seed, keep it concrete
                              → water it (reuse) until evidence piles up
                              → only then merge into an advanced seed = a pattern   ← induction, not guesswork
```

Watering counts evidence from reuse. The `buried → sprouting → growing → advanced` state machine is how Trees makes abstraction wait.

These are the three constraints I need to keep that idea intact:

| Constraint | What it means |
|---|---|
| Delayed abstraction | A seed starts life as a concrete experience and never turns into a pattern on its own. It only levels up after enough reuse or through synthesis |
| Merge on complementarity | Synthesis looks for seeds that complement each other, not seeds that look alike. And complementarity comes in degrees — see below. Weakly related seeds that share just one label get flagged, not merged |
| Never delete originals | After synthesis the source seeds stay put, tagged with `synthesized_into`, so a merge can always be undone |

Judging complementarity takes two views: the **intersection** (how much the two overlap) and the **union** (how much ground they cover together). Heavy overlap means it is the same lesson twice; a wider union means the knowledge really is more complete. Looking at only one of the two always misfires.

| Kind | What it means | What to do |
|---|---|---|
| Chained | One is a prerequisite of the other — you cannot do B without A first | Must be bound together |
| Strong | Each covers a different piece — where one fails is exactly where the other works. Together they are more complete | Worth merging |
| Partial | Adds something, but not a new dimension | Fine to merge, modest gain |
| Redundant | Both say the same thing; merging adds nothing | No point |
| Conflict | Same context, opposite advice | Never merge — settle which is right first |

If only the later one exists and the prerequisite never showed up, it just sits there waiting — `trees waiting` shows who is waiting for what, and when that thing finally gets planted, `trees new` will point out that it may be exactly what someone was waiting for.

`trees candidates` lists each kind separately, and merging is refused outright for conflicts. The logic lives in `synthesize.js`: conflicts and redundancies get filtered out first, then strong complementarity is recognised.

## The loop in practice

```
Project starts
  │
  ├─ Session starts → inject library index + the project's continuation point
  │    └─ Work: recall seeds from COMPLETED projects → use + verify → water
  │
  ├─ Session ends → record only, no planting
  │    ├─ AI summarizes what happened + lists open threads
  │    ├─ AI judges the project: ongoing / complete / unknown
  │    ├─ Create a session node (key s-XXXXXXXX) pointing at the previous session
  │    └─ Write .trees/last-key so the next session continues automatically
  │
  ├─ More sessions for the same project → a chain A → B → C
  │
  └─ Project complete (AI judgment + conditions met)
       ├─ The chosen chain merges into one project tree (TREES)
       ├─ ★ First planting: seeds are extracted from the whole chain
       ├─ Session trees keep their originals, marked merged_into
       └─ Side branches: plant separately (plant-branch) or recycle

Afterwards
  Seeds: water → grow → merge complementary ones (human review) → advanced → box when idle
  Session trees: no continuation → dormant → recycled
```

A long project may span many sessions, but **only a completed project plants seeds**. Session trees from unfinished work are raw material, not lessons: half-formed judgments never enter the library.

Once a seed has been reused enough times in the same kind of context, and it has a complementary partner, it becomes eligible to merge into something more advanced. Seeds nothing reaches for go into the box for a while, and can be summoned back when they are needed again.

## Concepts

I use a few names throughout the project. Here's what each one means and where to find it:

| Element | What it is | Where it lives |
|---|---|---|
| Tree | The full record of one project, reusable as a whole | `forest/trees/<id>.md` |
| Seed | A reusable lesson produced by a project; the smallest unit | `forest/seeds/<id>.md` |
| Leaf | Busywork with no reuse value; gets one log line and stays out of the library | `forest/leaves.log` |
| Box | Seeds that haven't been used in a long time (dormant, can be summoned back) | `forest/box/<id>.md` |
| Forest | A cluster of closely related project trees (`forest_id` points to the parent tree) | Stored in the tree |
| Branch | Where multiple AIs contribute to a tree; used to build an AI capability profile | Stored in the tree |

To keep the library useful, I ask one question before saving something: did this leave me with a judgment I could use next time? If it did, it's a seed. Otherwise, it gets a line in the leaf log.

## Quick start

You'll need Node.js ≥ 20. There are no dependencies to install.

```bash
git clone https://github.com/lim-life/Trees.git
cd Trees/tools

node bin/cli.js help        # list the commands
node tests/run.mjs          # run the self-tests (120 of them)
```


If you want something to browse first, there's a sample forest in the repo. Its 4 seeds all came from pitfalls encountered while building Trees itself:

```bash
TREES_HOME=../examples/demo-forest node bin/cli.js status
TREES_HOME=../examples/demo-forest node bin/cli.js tree trees-oss
TREES_HOME=../examples/demo-forest node bin/cli.js show seed-0003
```

In Windows PowerShell, use `$env:TREES_HOME="..\examples\demo-forest"; node bin/cli.js status` instead.

Or start with a seed of your own:

```bash
node bin/cli.js new "Use /dev/null instead of NUL in MSYS" --labels Windows,bash
node bin/cli.js ls
node bin/cli.js water seed-0001
node bin/cli.js status
```

For a global `trees` command:

```bash
cd Trees/tools && npm link
trees status
```

Data lives in `./forest` by default. Set an environment variable to keep it somewhere else:

```bash
TREES_HOME=/path/to/my-forest trees status
```

## What the files look like

Everything is readable Markdown. You can track it in git, copy it elsewhere, and keep using it. There's no database to move or unlock.

Here's a seed:

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

The body says when to use it (判据), what to do (做法), and when to leave it alone (不适用). That last section matters most to me. It's easy to drop when summarizing an experience, and then someone follows perfectly reasonable advice in the wrong environment.

A tree looks like this:

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

Its body records what the project did, the decisions that mattered, and what you'd need to reuse it.

## Command line

```
Seeds
  trees new "<title>" [--labels a,b] [--from <file.md>] [--needs "<req>"]   plant a seed by hand
  trees plant <path>               extract seeds out of a finished project (needs a model)
  trees plant <path> --dry-run     show what it would extract, write nothing
  trees ls [--state <state>]       list seeds
  trees show <seed-id>             show seed details
  trees water <seed-id> [--fail]   water a seed (success: +1 and advance state; --fail: record a failure, don't advance)
  trees find <keyword>             search titles / labels / body
  trees recall "<task>"            pull the seeds this task needs (5 seeds / 4000 tokens by default)
  trees box <seed-id>              put a seed in the box (dormant)
  trees summon <seed-id>           summon a seed back out of the box
  trees sweep                      box seeds that haven't been watered in 180 days

Trees / forests
  trees trees                      list all trees
  trees tree <tree-id>             show one tree (including the seeds attached to it)
  trees forest <child> --under <parent>   link trees together (cycles are prevented automatically)

Project chains (long projects across sessions)
  trees tip                        current continuation point, last session, open threads
  trees use <s-XXXXXXXX>           roll back / switch the continuation point
  trees finish <s-XXXXXXXX>        merge the session chain and plant
  trees unfinish <proj-id>         split the project tree back apart
  trees plant-branch <s-XXXXXXXX>  plant an abandoned branch separately
  trees recycle <s-XXXXXXXX>       recycle an abandoned branch (dormant)
  trees plant-project <proj-id>    re-plant a project

Distillation (distill on demand — the core of this project)
  trees candidates                 scan the library for complementary pairs
  trees synthesize <a> <b>         distill two complementary seeds into a higher-level one
  trees unsynthesize <id>          split it back apart
  trees waiting                    list seeds that are waiting on a prerequisite
  trees need <id> --for "<req>"    declare a prerequisite (a seed id, or a description)

Nightly loop (runs on its own)
  trees dream [seed-id...]         which seeds it would study tonight (plan only)
  trees dream --run                actually study them (needs a model)
  trees dream --config             show which model is configured
  trees grow                       check whether natural growth is installed
  trees grow --show                print exactly what it would write, touching nothing
  trees grow --install [--at HH:MM] install it (defaults to 03:17)
  trees grow --uninstall           remove it
  trees config [--from-env]        save the model settings (the scheduled run reads these)

Environment
  trees index                      write forest/index.md (a few KB, injected into new sessions)
  trees index --print [--if-any]   print only; --if-any stays silent on an empty library
  trees init [--dry-run]           initialize the data directory (idempotent)
  trees status                     overview + AI capability profile
```

`trees status` also works out an AI capability profile from the data:

```
AI 能力画像 (越用越准 → 直接喂给派单决策)
   claude-opus-5-5        出种   8   成活率 100%
   gemini-3.8-flash       出种  12   成活率  60%
```

It shows how many seeds each model produced (出种) and the fraction that survived (成活率). Each seed's `from_branch` field records which AI produced it. With enough history, you have some numbers to consult when choosing a model for a job. The profile should become more useful as you use it.

## State machine

```
buried ──1 watering──▶ sprouting ──≥2 waterings──▶ growing ──≥5 waterings or synthesized──▶ advanced
  ▲                                                                                          │
  └──────────── any state ──180 days without watering──▶ boxed ──summoned──▶ back to prev_state ──┘
```

State changes depend on the `watered` count and the time since `last_watered`. The clock starts at the last use, regardless of `born`.

`failed` stays out of that calculation. A failure gets recorded as evidence about the seed's quality, but it won't demote the seed. Boxing also uses `last_watered`: an old seed that's still getting used belongs in the library.

## Session chains and project completion

A long project spans sessions, so a session is not a project: **a session tree is raw material**.

- **Session tree** `s-XXXXXXXX`: one session's summary, open threads, and continuation pointer.
- **Project tree**: a chain of session trees merged together, representing one **completed** project.
- **Seeds only come from project trees.** An unfinished project plants nothing.

```bash
trees tip                       # continuation point, last session, open threads
trees use s-7F3KQ2M1            # roll back: branch from an earlier node
trees finish s-7F3KQ2M1         # merge the chain and plant for the first time
trees unfinish proj-7F3KQ2M1    # split it back apart
trees plant-branch s-XXXX       # plant an abandoned branch separately
trees recycle s-XXXX            # recycle an abandoned branch
```

Automatic mode:

```bash
trees auto --enable             # record sessions automatically (off by default)
trees auto --finish             # merge + plant when the project completes
trees auto --status             # flags, model, and the last run
```

Completion is judged by the local AI: `complete` + no open threads + no later sessions, and either the user explicitly said it was done or two consecutive sessions agree. **A session ending is not completion.**

Abandoned branches stay dormant and are never planted automatically — half-finished judgments would only pollute recall. Plant one with `plant-branch` if it has value, or let it be recycled.

Session text is sent to your configured model, with key-like strings redacted first.

## Letting it study on its own

The system picks what to study: seeds idle for 30 to 150 days, the least recently used first,
at most 5 a night, at most 4000 tokens each.

The model is yours to configure, so everyone brings their own key:

```bash
export TREES_LLM_BASE_URL=https://api.deepseek.com/v1
export TREES_LLM_API_KEY=sk-...
export TREES_LLM_MODEL=deepseek-chat

trees dream          # see what it plans to study tonight
trees dream --run    # actually study
```

Anything with an OpenAI-compatible endpoint works. Studying is not a job that needs an
expensive model; the cheapest one you have is fine.

Studying is not watering. What comes back at night is added understanding: `evidence` and
the body get filled in, but `watered`, `state` and `last_watered` are left untouched.
Seniority can only come from real use.

## Natural growth

If running it by hand gets tedious, let it grow on its own — a short study session each day
while you are not using the machine:

```bash
trees config --from-env    # save the model settings (the scheduled run reads these)
trees grow --show          # print exactly what it would write, touching nothing
trees grow --install       # install it (defaults to 03:17, change with --at)
trees grow                 # check whether it is installed and what it did last
trees grow --uninstall     # remove it
```

It adds exactly two things: a wrapper script under `~/.trees/`, and a daily scheduled entry
(Windows Task Scheduler, or crontab on macOS and Linux). Logs go to `~/.trees/grow.log`.

**Run `--show` first.** It prints the file and the command verbatim before anything is touched.

## Three ways to get started

You can build a library as you work, extract one from old material, or bring in someone else's seeds:

| Starting point | How |
|---|---|
| From nothing | Just work on your projects and plant seeds as they finish. An empty library doesn't throw errors; you just get a friendly hint |
| Bulk extraction | `trees plant --dir <dir>` pulls seeds out of existing notes or old projects in bulk |
| Seed pack import | `trees import <pack.zip>` lets you stand on someone else's shoulders. Imported seeds start with `confidence` at 0.5 and reach full confidence after 3 verifications |

Bulk extraction and seed pack import are planned; the implementation status and roadmap below cover what's available now.

## Framework-agnostic

The core is plain logic working with files. It doesn't depend on an AI framework; adapters are meant to handle the different environments. Only the CLI is ready so far:

| Adapter | Who it's for | Status |
|---|---|---|
| CLI | Codex CLI / Gemini CLI / anything that can run a shell | Available |
| MCP server | Claude Code / Cursor / Cline / Windsurf / Zed… | Not yet implemented |
| Skill file | Claude Code | Not yet implemented |
| standalone | People who bring their own LLM and use no framework at all | Not yet implemented |

## What runs today

There's still plenty here that I haven't built. Here's the boundary between working code and plans.

The core data layer is done, and all 120 self-tests pass:

- `frontmatter.js`: dependency-free YAML parsing and serialization, including Chinese text, colons, quotes, and arrays of objects
- `seed.js`: seed model, state machine, watering, failure tracking, boxing and summoning, ID allocation, and handling an empty library without errors
- `tree.js`: tree model, branches, attached seeds, and reuse notes
- `forest.js`: forest relationships, including cycle prevention across tree clusters
- `leaves.js`: leaf log
- `synthesize.js`: complementarity check, synthesis, lineage, and rollback
- `dream.js`: the nightly loop — picks what to study, stays inside a budget, and actually studies (adds understanding, never seniority)
- `plant.js`: extracts seeds out of a finished project, separating real lessons from busywork
- `bin/cli.js`: every command in the command reference above

Still ahead:

- `health`: health checks
- MCP, Skill, and standalone adapters

## Roadmap

1. v0.1: core data layer + CLI (done)
2. v0.2: `plant` / `synthesize` — the full project to seed to synthesis pipeline now runs (done)
3. v0.3: MCP adapter for direct connections from Claude Code and Cursor
4. v0.4: the nightly loop (done — selection, budgeting, and model calls all work)
5. v1.0: seed pack import/export, with the AI capability profile wired into task assignment

## Ground rules

1. Leaves stay out of the library. Routine noise shouldn't bury useful experience.
2. An empty library never errors. Starting from nothing should work.
3. Synthesis needs human review. An abstraction can't be reversed to recover everything it left out.
4. Originals are never deleted. A merge must be undoable.
5. Imports start with reduced weight. Someone else's experience needs checking in your own work.
6. The night loop has a budget. It can't spend money unchecked.
7. Deployment must be idempotent, backed up, and uninstallable.

## What to expect as it grows

```
0–10 seeds       barely noticeable — don't judge it yet
10–50 seeds      occasional hits start showing up
50–200 seeds     clearly saves effort; similar projects go about twice as fast
200+ seeds       real transfer: applying lessons from one area to another
```

## Research background

The research term for turning experience into reusable know-how is episodic → procedural memory consolidation. Mature projects such as Mem0, Letta, and Cognee cover isolated memory and local storage. How to consolidate repeated experiences into structured know-how is still an open question, without a settled approach. One paper describes the gap this way: "no prior work has formalized the consolidation of procedural memory."

My bet with Trees is that timing matters: keep the concrete experience, use it repeatedly, collect evidence, and then try to generalize. That gives the abstraction something to stand on.

I need more people to try it before I can know whether that bet holds up. That's why I'm sharing it as open source.

---

## Contributing

You can reach me at `zzx060427@outlook.com`, or open an [issue](https://github.com/lim-life/Trees/issues).

It's early. The most useful contribution right now is to use Trees on your own work and tell me where it breaks.

Bugs and ideas are welcome. If you've used it for a while, though, I especially want to know whether you actually reused any seeds. That's the only way to test the central idea.

If you can, include:

1. Your version and OS
2. The output of `node tests/run.mjs` if the self-tests fail
3. What you expected and what happened instead

## License

MIT © 2026 张子翔
