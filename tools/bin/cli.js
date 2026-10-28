#!/usr/bin/env node
/**
 * Trees CLI —— 「类人脑 AI 经验生态」的命令行入口。
 *
 * 零依赖，只用 Node 标准库。数据是文件系统里的 Markdown + YAML frontmatter，
 * 人可读、git 友好、随便拷走就能用。
 *
 * 用法： trees <命令> [参数]      （trees help 看全部命令）
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getForestRoot } from '../src/core/paths.js';
import {
  createSeed, readSeed, listSeeds, waterSeed, boxSeed, summonSeed, sweepAging,
} from '../src/core/seed.js';
import { listTrees, readTree, writeTree, getTreeSeeds, linkSeed } from '../src/core/tree.js';
import { linkForest, getForestMembers } from '../src/core/forest.js';
import {
  findCandidates, synthesizeSeed, unsynthesize, SYNTH_MIN_WATERED,
  findWaiting, addRequire, findFulfillments,
} from '../src/core/synthesize.js';
import {
  planDream, runDream, FRESH_DAYS, ROTTING_MARGIN_DAYS,
} from '../src/core/dream.js';
import { readConfig, writeConfig, configPath, getPlanter } from '../src/core/config.js';
import { listEvents, verifyEvents } from '../src/core/events.js';
import { plantFrom } from '../src/core/plant.js';
import { shareTree } from '../src/core/share.js';
import { findDuplicates, judgePair } from '../src/core/dedup.js';
import { scoreSeed, scoreMissing, scorerCallModel } from '../src/core/scorer.js';
import { summarize } from '../src/core/stats.js';
import { searchSeeds, planQuery, fallbackPlan } from '../src/core/space.js';
import { recall, renderRecall } from '../src/core/recall.js';
import { renderIndex, writeIndex } from '../src/core/indexer.js';
import { runAuto, readAutoLog, autoLogPath } from '../src/core/session.js';
import {
  finishProject, unfinishProject, plantBranch, recycleBranch, plantProject,
  findLastKey, writeLastKey, resolveChain,
} from '../src/core/project.js';
import {
  buildGrowPlan, install as growInstall, uninstall as growUninstall,
  status as growStatus, DEFAULT_AT, TASK_NAME,
} from '../src/schedule/grow.js';

const SELF = fileURLToPath(import.meta.url);

/** 互补成色的显示名与配色。 */
const KIND_LABEL = {
  chain: ['串联', '一颗是另一颗的前置 —— 必须绑在一起', 'cyan'],
  strong: ['强互补', '合起来更完整，值得合成', 'green'],
  partial: ['部分互补', '有补充，但不是新维度', 'yellow'],
  conflict: ['互斥', '同一情境两种主张 —— 别合成', 'red'],
  redundant: ['等价', '说的是一回事，没必要合成', 'dim'],
  adjacent: ['邻接', '只标记，不合成', 'dim'],
};

const ESC = '\x1b[';
const c = {
  dim: `${ESC}2m`, red: `${ESC}31m`, green: `${ESC}32m`,
  yellow: `${ESC}33m`, cyan: `${ESC}36m`, reset: `${ESC}0m`,
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);
const hasFlag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const plainArgs = args.filter((a) => !a.startsWith('-'));

/** 把种子对象压成一行给人看 */
function seedLine(s) {
  const water = `💧${s.watered}`;
  const fail = s.failed ? ` ✗${s.failed}` : '';
  const state = `${c.cyan}${s.state}${c.reset}`;
  return `  ${c.dim}${s.id}${c.reset}  ${state}  ${water}${fail}  ${s.title}`;
}

/** 打印一个种子详情 */
function printSeed(s) {
  if (!s) return;
  console.log(`${c.green}${s.id}${c.reset}  ${s.title}`);
  console.log(`  状态 ${s.state}${s.prev_state ? ` (入盒前 ${s.prev_state})` : ''}   浇水 ${s.watered}   失败 ${s.failed}`);
  console.log(`  标签 [${(s.labels || []).join(', ')}]   来自 ${s.from_tree || '-'} / ${s.from_branch || '-'}`);
  console.log(`  置信 ${s.confidence}   播种 ${s.born}   末次浇水 ${s.last_watered}`);
  if (s.synthesized_into) console.log(`  ${c.yellow}已被合成进 ${s.synthesized_into}${c.reset}`);
  if (s.body) console.log(`\n${s.body.trim()}`);
}

const HELP = `
${c.green}Trees${c.reset} —— 类人脑的 AI 经验生态
项目长成大树，经验结成种子。种子会生长、互补、合成、休眠。

${c.cyan}种子${c.reset}
  trees new "<标题>" [--labels a,b] [--from <文件.md>] [--needs "<前置>"] [--tree <大树id>] [--branch <模型名>]
                                   手动播种一颗种子（没给 --from 就带三段空壳）
  trees ls [--state <状态>]        列出种子
  trees show <seed-id>             看种子详情
  trees water <seed-id> [--fail]   浇水（成功 +1 并推进状态；--fail 记失败且不推进）
  trees score <seed-id> [--force]  给种子打静态向量（D1/D2/D4）+ D3 先验
  trees score --missing [--limit N] 给还没有向量的种子补分
  trees find <关键词>              按标题/标签/正文检索
  trees search "<任务>" [--limit N] [--no-ai] [--json]
                                   文本召回 + 四维过滤（管理 AI 出检索计划）
  trees dedup [--threshold 0.7] [--ai] [--json]
                                   查重：精确重复 + 近重复；--ai 判 same/subset/overlap/different
  trees recall "<任务描述>" [--limit N] [--budget N] [--all] [--json]
                                   召回该带进上下文的种子（默认 5 颗 / 4000 token）
  trees box <seed-id>              入盒（休眠）
  trees summon <seed-id>           召唤出盒
  trees sweep                      把 180 天没浇水的种子送进盒子

${c.cyan}大树 / 森林${c.reset}
  trees trees [--all]              列出所有大树（默认不看会话节点）
  trees tree <tree-id>             看一棵树（含挂在它下面的种子）
  trees plaque <tree-id> ["一句话"] [--labels a,b]
                                   看/改树牌（列表只显示树牌）
  trees share <tree-id>            把这棵树和它的种子打成可 git 发布的包（默认全部私有）
  trees forest <子树> --under <父树>   建强关联（自动防环）

${c.cyan}蒸馏${c.reset} ${c.dim}（按需蒸馏 —— 这个项目的核心）${c.reset}
  trees candidates                 扫全库，找出互补的种子对
  trees synthesize <a> <b>         把两颗互补的种子蒸馏成一颗高级种子
  trees unsynthesize <id>          拆回原件（原件一直都在，合成从不删东西）
  trees waiting                    列出正在等前置的种子
  trees need <id> --for "<前置>"    登记前置（可以是种子 id，也可以是还没出现的描述）

${c.cyan}黑夜循环${c.reset} ${c.dim}（系统自跑 —— 默认只出计划，--run 才调模型）${c.reset}
  trees dream [seed-id...]         今晚该学哪几颗（只出计划）
  trees dream --run                真去学（要配模型，会花钱）
  trees dream --config             看现在配的是哪个模型

${c.cyan}播种${c.reset} ${c.dim}（把做过的事变成种子）${c.reset}
  trees plant <项目路径>           从项目里提取种子，同时长出一棵大树
  trees plant <路径> --dry-run     只看看会提出什么，不落盘

${c.cyan}自然生长${c.reset} ${c.dim}（让它在你不用的时段自己长一会儿）${c.reset}
  trees grow                       看装没装
  trees grow --show                只打印它会往你电脑上写什么，不动系统
  trees grow --install [--at HH:MM] 装上（默认 03:17）
  trees grow --uninstall           卸掉
  trees config [--from-env]        配模型（定时任务读的是这份，不是你的 export）

${c.cyan}项目链${c.reset} ${c.dim}（会话树 → 项目大树 → 首次播种）${c.reset}
  trees tip                        看当前接续点、上次会话和未完成事项
  trees use <s-XXXXXXXX>           回档 / 切换接续点
  trees finish <s-XXXXXXXX>        合并会话链并首次播种（--force 跳过完成判断）
  trees unfinish <proj-id>         拆回项目树
  trees plant-branch <s-XXXXXXXX>  把旁支单独播种
  trees recycle <s-XXXXXXXX>       旁支回收（休眠）
  trees plant-project <proj-id>    重新播种一个项目

${c.cyan}会话回写${c.reset} ${c.dim}（会话结束只记录，不播种；默认关闭）${c.reset}
  trees auto --enable / --disable  开关自动回写
  trees auto --finish / --no-finish 开关项目完成时自动合并
  trees auto --status              看开关、模型和最近日志
  trees auto --transcript <会话.jsonl> [--dry-run]   手动跑一次

${c.cyan}索引 / 环境${c.reset}
  trees index                      生成 forest/index.md（几 KB 的目录，给新会话注入）
  trees index --print [--if-any]   只打印不落盘；--if-any 空库时什么都不输出
  trees events [--limit N] [--seed <id>] [--type <类型>] [--verify]
                                   看事件账本；--verify 校验哈希链是否被改过
  trees init [--dry-run]           初始化数据目录（幂等）
  trees status                     总览
  trees stats [--json]             统计：状态/植树人/事件/调用（不花模型钱）

${c.cyan}尚未实现${c.reset} ${c.dim}（需要接 LLM，见 docs/00-SPEC.md §5）${c.reset}
  health  import  export  profile  uninstall

${c.dim}数据目录：${getForestRoot()}${c.reset}
`;

/** 空库时的友好提示 —— 新用户不能被报错吓跑 */
function emptyHint() {
  console.log('🌱 还没有种子 —— 直接开始做项目吧，做完会自动播种。');
  console.log(`${c.dim}   也可以：trees init  先建好目录结构。${c.reset}`);
}

async function cmdInit() {
  const dry = hasFlag('--dry-run');
  console.log(`数据根：${getForestRoot()}`);
  if (dry) {
    console.log(`${c.dim}(--dry-run) 未写入任何文件。${c.reset}`);
    return;
  }
  const existed = await ensureDirs();
  console.log(existed ? '✅ 目录结构已就绪' : '✅ 目录结构已创建');
}

async function cmdNew() {
  const title = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!title) {
    return err('用法：trees new "<标题>" [--labels a,b] [--from <文件.md>] [--needs "<前置>"] [--tree <大树id>] [--branch <模型名>]');
  }
  const labels = (valueOf('--labels') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const treeId = valueOf('--tree');
  const branch = valueOf('--branch');
  const from = valueOf('--from');
  const needs = valueOf('--needs');

  let body = '';
  if (from) {
    try {
      body = await readFile(from, 'utf8');
    } catch {
      return err(`读不到文件：${from}`);
    }
  }

  const seed = await createSeed({
    title,
    labels,
    body,
    from_tree: treeId || '',
    from_branch: branch || '',
    requires: needs ? [needs] : [],
  });
  if (treeId) await linkSeed(treeId, seed.id);

  console.log(`🌰 已播种 ${c.green}${seed.id}${c.reset}  ${seed.title}`);
  console.log(`   ${c.dim}状态 ${seed.state}   标签 [${labels.join(', ')}]${treeId ? `   挂到 ${treeId}` : ''}${c.reset}`);
  if (!body) {
    console.log(`   ${c.dim}正文三段是空的 —— 填完「判据 / 做法 / 不适用」这颗种子才算数${c.reset}`);
    console.log(`   ${c.dim}可以直接编辑：${getForestRoot()}/seeds/${seed.id}.md${c.reset}`);
  }

  // 「等 a 出现」的兑现时刻：这颗是不是正好补上了别人在等的前置？
  const hits = await findFulfillments(seed);
  if (hits.length) {
    console.log(`${c.cyan}💡 这颗可能正是别人在等的：${c.reset}`);
    for (const h of hits) {
      console.log(`   ${h.seed.id} ${h.seed.title}  在等「${h.wanted}」  ${c.dim}匹配 ${h.score.toFixed(2)}${c.reset}`);
    }
    console.log(`   ${c.dim}确认的话：trees need ${hits[0].seed.id} --for ${seed.id} 再 trees synthesize 绑成串联${c.reset}`);
  }
}

async function cmdLs() {
  const state = valueOf('--state');
  const all = await listSeeds(state ? { state } : {});
  if (!all.length) return emptyHint();
  console.log(`${all.length} 颗种子${state ? `（state=${state}）` : ''}：`);
  for (const s of all) console.log(seedLine(s));
}

async function cmdShow() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees show <seed-id>');
  const s = await readSeed(id);
  if (!s) return err(`找不到种子：${id}`);
  printSeed(s);
}

async function cmdWater() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees water <seed-id> [--fail]');
  const before = await readSeed(id);
  if (!before) return err(`找不到种子：${id}`);
  const ok = !hasFlag('--fail');
  const after = await waterSeed(id, ok);
  if (ok) {
    const moved = after.state !== before.state;
    console.log(`💧 ${after.id} 浇水成功（第 ${after.watered} 次）`);
    if (moved) console.log(`   ${before.state} → ${c.green}${after.state}${c.reset}`);
    else console.log(`   状态仍是 ${after.state}`);
  } else {
    console.log(`${c.yellow}✗ ${after.id} 记了一次失败（第 ${after.failed} 次）—— 状态不降级${c.reset}`);
  }
}

async function cmdFind() {
  const kw = plainArgs.join(' ').trim();
  if (!kw) return err('用法：trees find <关键词>');
  const all = await listSeeds({});
  const hit = all.filter((s) => {
    const hay = [s.id, s.title, (s.labels || []).join(' '), s.body || ''].join(' ').toLowerCase();
    return hay.includes(kw.toLowerCase());
  });
  if (!hit.length) {
    console.log(`没有匹配「${kw}」的种子。`);
    if (!all.length) emptyHint();
    return;
  }
  console.log(`命中 ${hit.length} 颗：`);
  for (const s of hit) console.log(seedLine(s));
}

async function cmdRecall() {
  const query = (() => {
    const words = [];
    for (const a of args) {
      if (a.startsWith('-')) break;
      words.push(a);
    }
    return words.join(' ').trim();
  })();
  if (!query) {
    return err('用法：trees recall "<任务描述>" [--limit N] [--budget N] [--all] [--json]');
  }

  const limit = Number(valueOf('--limit')) || undefined;
  const budget = Number(valueOf('--budget')) || undefined;
  const result = await recall(query, {
    limit,
    budget,
    includeBoxed: hasFlag('--all'),
  });

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      query: result.query,
      tokens: result.tokens,
      budget: result.budget,
      picks: result.picks.map((p) => ({
        id: p.seed.id,
        title: p.seed.title,
        score: Number(p.score.toFixed(3)),
        labels: p.seed.labels,
        state: p.seed.state,
        watered: p.seed.watered,
        tokens: p.tokens,
        text: p.text,
      })),
      divergent: result.divergent,
    }, null, 2));
    return;
  }

  console.log(renderRecall(result));
}

async function cmdBox() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees box <seed-id>');
  const s = await boxSeed(id);
  if (!s) return err(`找不到种子：${id}`);
  console.log(`📦 ${s.id} 已入盒（入盒前状态 ${s.prev_state}）`);
}

async function cmdSummon() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees summon <seed-id>');
  const s = await summonSeed(id);
  if (!s) return err(`找不到种子：${id}`);
  console.log(`✨ ${s.id} 已召唤出盒，恢复为 ${c.green}${s.state}${c.reset}`);
}

/** 一次性把 stdin 读完（hook 会把 JSON 从标准输入递进来）。 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdAuto() {
  if (hasFlag('--finish') || hasFlag('--no-finish')) {
    await writeConfig({ autoFinish: hasFlag('--finish') });
    console.log(hasFlag('--finish') ? '✅ 项目完成时自动合并并播种已开启' : '🍂 自动合并已关闭（只记录会话节点）');
    return;
  }
  if (hasFlag('--enable')) {
    await writeConfig({ autoPlant: true });
    console.log('✅ 会话结束自动回写已开启');
    console.log(`${c.dim}   只记录会话节点，不播种；项目完成时才合并并提取种子。${c.reset}`);
    return;
  }
  if (hasFlag('--disable')) {
    await writeConfig({ autoPlant: false });
    console.log('🍂 会话结束自动回写已关闭');
    return;
  }
  if (hasFlag('--status')) {
    const cfg = await readConfig();
    const { describeConfig } = await import('../src/llm/chat.js');
    const llm = await describeConfig();
    console.log(`会话回写  ${cfg.autoPlant === true ? c.green + '已开启' + c.reset : c.dim + '关闭' + c.reset}`);
    console.log(`自动合并  ${cfg.autoFinish === true ? c.green + '已开启' + c.reset : c.dim + '关闭' + c.reset}`);
    console.log(`   模型    ${llm.configured ? llm.model : c.red + '未配置（回写会跳过）' + c.reset}`);
    const tail = await readAutoLog(5);
    if (tail) {
      console.log(`${c.dim}   最近日志（${autoLogPath()}）：${c.reset}`);
      for (const line of tail.split('\n')) console.log(`     ${c.dim}${line}${c.reset}`);
    }
    return;
  }

  let transcript = valueOf('--transcript');
  let cwd = valueOf('--cwd');

  if (hasFlag('--hook')) {
    // Claude Code 的 SessionEnd hook 从 stdin 递 JSON
    try {
      const payload = JSON.parse(await readStdin());
      transcript = payload.transcript_path || transcript;
      cwd = payload.cwd || cwd;
    } catch { /* stdin 不是 JSON 就按参数来 */ }
  }

  if (!transcript && !hasFlag('--hook')) {
    return err('用法：trees auto --transcript <会话.jsonl> [--dry-run] | trees auto --enable | --status');
  }

  const result = await runAuto({
    transcript,
    cwd,
    fromKey: valueOf('--from'),
    dryRun: hasFlag('--dry-run'),
    force: hasFlag('--force'),
  });

  if (result.skipped) {
    console.log(`${c.dim}跳过：${result.skipped}${c.reset}`);
    return;
  }
  if (result.dryRun) {
    console.log(`📝 [dry-run] 会记录会话 ${result.key}（${result.projectStatus}），不落盘`);
    return;
  }
  console.log(`📝 会话节点 ${result.key} · ${result.projectStatus}${result.openThreads?.length ? ` · 未完成 ${result.openThreads.length} 项` : ''}`);
  if (result.mergedInto) {
    console.log(`🌳 项目完成，已合并为 ${result.mergedInto} 并首次播种`);
  } else if (result.finish?.ready) {
    console.log(`${c.yellow}🪵 项目看起来完成了 —— trees finish ${result.key}${c.reset}`);
  }
  console.log(`${c.dim}   会话树只记录原料；项目完成后才播种。${c.reset}`);
}

async function cmdTip() {
  const key = valueOf('--key') || await findLastKey(process.cwd());
  if (!key) {
    if (hasFlag('--verbose')) console.log('没有找到接续点（.trees/last-key）。');
    return;
  }
  try {
    const chain = await resolveChain(key);
    const tip = chain[chain.length - 1];
    console.log('## Trees 当前项目');
    console.log(`上次会话：${tip.id}（${tip.title}）`);
    console.log(`状态：${tip.project_status}${tip.status_reason ? ` — ${tip.status_reason}` : ''}`);
    if ((tip.open_threads || []).length) console.log(`未完成：${tip.open_threads.join('；')}`);
    console.log(`链长：${chain.length}（${chain.map((t) => t.id).join(' → ')}）`);
    console.log('接续：默认自动；回档：trees use <更早的钥匙>');
  } catch (e) {
    if (hasFlag('--verbose')) err(e.message);
  }
}

async function cmdUse() {
  const key = plainArgs[0];
  if (!key) return err('用法：trees use <s-XXXXXXXX>');
  const tree = await readTree(key);
  if (!tree || tree.kind !== 'session') return err(`找不到会话：${key}`);
  await writeLastKey(process.cwd(), key);
  console.log(`🔑 接续点已切到 ${key}（${tree.title}）`);
}

async function cmdFinish() {
  const key = plainArgs[0];
  if (!key) return err('用法：trees finish <s-XXXXXXXX> [--id <项目id>] [--title <标题>] [--force]');
  const cfg = await readConfig();
  try {
    const project = await finishProject(key, {
      id: valueOf('--id'),
      title: valueOf('--title'),
      fromBranch: cfg.model || '',
      allowIncomplete: hasFlag('--force'),
    });
    console.log(`🌳 项目大树 ${c.green}${project.id}${c.reset}  ${project.title}`);
    console.log(`   合并 ${project.chain.length} 个会话：${project.chain.join(' → ')}`);
    if (project.plantError) {
      console.log(`${c.yellow}   播种失败：${project.plantError}${c.reset}`);
      console.log(`${c.dim}   重试：trees plant-project ${project.id}${c.reset}`);
    } else {
      console.log(`   🌰 首次播种 ${project.seeds} 颗，${project.leaves} 条落叶`);
    }
  } catch (e) {
    err(e.message);
  }
}

async function cmdUnfinish() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees unfinish <proj-id>');
  try {
    const r = await unfinishProject(id);
    console.log(`↩️  ${id} 已拆回，恢复 ${r.restored.length} 个会话`);
    if (r.seeds) console.log(`   ${r.seeds} 颗种子保留，已挂回最后一个会话`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdPlantBranch() {
  const key = plainArgs[0];
  if (!key) return err('用法：trees plant-branch <s-XXXXXXXX>');
  const cfg = await readConfig();
  try {
    const r = await plantBranch(key, { fromBranch: cfg.model || '' });
    console.log(`🌿 旁支树 ${c.green}${r.id}${c.reset}  ${r.title}`);
    if (r.plantError) console.log(`${c.yellow}   播种失败：${r.plantError}${c.reset}`);
    else console.log(`   🌰 播种 ${r.seeds} 颗`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdRecycle() {
  const key = plainArgs[0];
  if (!key) return err('用法：trees recycle <s-XXXXXXXX>');
  try {
    const s = await recycleBranch(key);
    console.log(`📦 ${s.id} 已当枯树回收（休眠，原件保留）`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdPlantProject() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees plant-project <proj-id>');
  const cfg = await readConfig();
  try {
    const r = await plantProject(id, { fromBranch: cfg.model || '' });
    console.log(`🌰 ${id} 播种 ${r.seeds} 颗，${r.leaves} 条落叶`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdIndex() {
  if (hasFlag('--print')) {
    const result = await renderIndex({ maxSeeds: Number(valueOf('--max')) || undefined });
    if (hasFlag('--if-any') && result.totalSeeds === 0) return;
    console.log(result.text);
    return;
  }
  const result = await writeIndex({ maxSeeds: Number(valueOf('--max')) || undefined });
  console.log(`🗂  ${result.path}`);
  console.log(`   ${result.active} 颗活跃 / ${result.boxed} 颗休眠 / ${result.trees} 棵大树`);
}

async function cmdSweep() {
  const boxed = await sweepAging();
  if (!boxed.length) {
    console.log('没有需要入盒的种子。');
    return;
  }
  console.log(`📦 ${boxed.length} 颗种子长期没浇水，已入盒：`);
  for (const s of boxed) {
    console.log(`  ${s.id}  ${s.title}  ${c.dim}入盒前 ${s.prev_state} / 末次浇水 ${s.last_watered}${c.reset}`);
  }
}

async function cmdCandidates() {
  const list = await findCandidates({});
  if (!list.length) {
    console.log('没有发现值得一看的种子对。');
    console.log(`${c.dim}（参与判定的种子至少要浇过 ${SYNTH_MIN_WATERED} 次水）${c.reset}`);
    return;
  }

  for (const kind of ['chain', 'strong', 'partial', 'conflict', 'redundant', 'adjacent']) {
    const group = list.filter((x) => x.kind === kind);
    if (!group.length) continue;
    const [name, note, color] = KIND_LABEL[kind];
    console.log(`\n${c[color]}${name}${c.reset} ${c.dim}— ${note}（${group.length} 对）${c.reset}`);
    for (const x of group) {
      console.log(`  ${x.a} × ${x.b}   ${c.dim}${x.score.toFixed(2)}${c.reset}`);
      console.log(`     ${x.aTitle}  ×  ${x.bTitle}`);
      console.log(`     ${c.dim}${x.reason}${c.reset}`);
    }
  }

  const ok = list.filter((x) => ['chain', 'strong', 'partial'].includes(x.kind));
  if (ok.length) console.log(`\n蒸馏：trees synthesize <idA> <idB> [--title "标题"]`);
  const bad = list.filter((x) => x.kind === 'conflict' || x.kind === 'redundant');
  if (bad.length) console.log(`${c.dim}互斥和等价的不要合成 —— 前者会自相矛盾，后者白费力气。${c.reset}`);
}

async function cmdSynthesize() {
  const a = args[0] && !args[0].startsWith('-') ? args[0] : '';
  const b = args[1] && !args[1].startsWith('-') ? args[1] : '';
  if (!a || !b) return err('用法：trees synthesize <idA> <idB> [--title "标题"]');
  try {
    const seed = await synthesizeSeed(a, b, { title: valueOf('--title'), force: hasFlag('--force') });
    const tag = KIND_LABEL[seed.complement] || ['', '', 'dim'];
    console.log(`🧬 蒸馏出 ${c.green}${seed.id}${c.reset}  ${seed.title}   ${c[tag[2]]}${tag[0]}${c.reset}`);
    console.log(`   血统 [${seed.bloodline.join(', ')}]   置信 ${seed.confidence}（取两者的较小值）`);
    console.log(`   ${c.dim}原件保留、状态已更新；拆回：trees unsynthesize ${a}${c.reset}`);
    console.log(`   ${c.dim}正文只是草稿，审一遍再算数：${getForestRoot()}/seeds/${seed.id}.md${c.reset}`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdUnsynthesize() {
  const id = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!id) return err('用法：trees unsynthesize <原件seed-id>');
  try {
    const r = await unsynthesize(id);
    console.log(`↩️  ${id} 已拆回`);
    if (r.removed) console.log(`   高级种子 ${r.removed} 的原料拆光了，一并删除`);
    else if (r.remainingBloodline) console.log(`   高级种子还在，血统剩 [${r.remainingBloodline.join(', ')}]`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdWaiting() {
  const list = await findWaiting();
  if (!list.length) {
    console.log('没有种子在等前置 —— 库里没有悬空的依赖。');
    return;
  }
  console.log(`⏳ ${list.length} 颗种子在等前置：`);
  for (const { seed: s, waiting, satisfied } of list) {
    console.log(`  ${s.id}  ${s.title}`);
    for (const w of waiting) console.log(`     ${c.yellow}在等：${w}${c.reset}`);
    if (satisfied.length) console.log(`     ${c.dim}已满足：${satisfied.join(', ')}${c.reset}`);
  }
  console.log(`
${c.dim}前置出现后，trees candidates 会把它们判为串联，绑成一条流程。${c.reset}`);
}

async function cmdNeed() {
  const id = args[0] && !args[0].startsWith('-') ? args[0] : '';
  const before = valueOf('--for') || valueOf('--needs');
  if (!id || !before) return err('用法：trees need <seed-id> --for "<前置：种子id 或 一段描述>"');
  try {
    await addRequire(id, before);
    console.log(`🔗 已登记：${id} 依赖 ${before}`);
    console.log(`   ${c.dim}如果 ${before} 还不是种子，它会出现在 trees waiting 里等着。${c.reset}`);
  } catch (e) {
    err(e.message);
  }
}

async function cmdDream() {
  if (hasFlag('--config')) {
    const { describeConfig } = await import('../src/llm/chat.js');
    const cfg = await describeConfig();
    console.log('🌙 黑夜循环用的模型：');
    if (!cfg.configured) {
      console.log(`   ${c.yellow}还没配${c.reset}`);
      console.log(`   ${c.dim}${cfg.hint}${c.reset}`);
      console.log(`   ${c.dim}学习这活不需要贵模型，用你手头最便宜的那个就行。${c.reset}`);
      return;
    }
    console.log(`   地址  ${cfg.baseUrl}`);
    console.log(`   模型  ${cfg.model}`);
    console.log(`   Key   ${cfg.apiKey}`);
    return;
  }

  const ids = plainArgs.filter((a) => a.startsWith('seed-'));

  if (hasFlag('--run')) {
    const r = await runDream(ids.length ? { seedIds: ids } : {});
    if (!r.results.length) {
      console.log(`🌙 什么都没学：${r.stopped || '没有该学的种子'}`);
      return;
    }
    console.log(`🌙 今晚学了 ${r.results.length} 颗：`);
    for (const x of r.results) {
      if (x.ok) {
        console.log(`   ${c.green}✓${c.reset} ${x.id}  补了 ${x.applied.join(' / ')}   ${c.dim}${x.tokens} tokens${c.reset}`);
        if (x.evidence) console.log(`      ${c.dim}旁证：${x.evidence}${c.reset}`);
      } else {
        console.log(`   ${c.red}✗${c.reset} ${x.id}  ${x.error}`);
      }
    }
    console.log(`
   共花 ${r.spentTokens} tokens`);
    if (r.stopped) console.log(`   ${c.dim}${r.stopped}${c.reset}`);
    console.log(`${c.dim}   浇水和状态一个都没动 —— 学到的只是见识，不是资历。${c.reset}`);
    return;
  }

  const plan = await planDream(ids.length ? { seedIds: ids } : {});
  console.log(`🌙 今晚的学习计划   ${c.dim}${plan.reason}${c.reset}`);
  if (!plan.picks.length) {
    console.log('   没有该学的种子。');
    console.log(`${c.dim}   要么 ${FRESH_DAYS} 天内刚浇过（还新鲜），要么距入盒不足 ${ROTTING_MARGIN_DAYS} 天（快腐烂了，让它自然淘汰）。${c.reset}`);
    return;
  }
  for (const p of plan.picks) {
    console.log(`   ${c.dim}${p.id}${c.reset}  ${p.title}`);
    console.log(`      ${c.dim}闲置 ${p.idleDays} 天 / 浇过 ${p.watered} 次${c.reset}`);
  }
  console.log(`
   预算：${plan.picks.length} 颗 × ${plan.perSeed} token = 最多 ${plan.totalTokens} tokens`);
  console.log(`${c.dim}   这是纯本地计划，没调模型也没花钱。真要跑加 --run。${c.reset}`);
  console.log(`${c.dim}   学习只能补 evidence 和正文 —— 不能加浇水、不能升状态。${c.reset}`);
}

async function cmdPlant() {
  const target = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!target) {
    return err('用法：trees plant <项目路径> [--dry-run] [--tree <大树id>] [--branch <模型名>]');
  }

  const dry = hasFlag('--dry-run');
  console.log(`🌱 正在读 ${target} ...`);

  try {
    const r = await plantFrom({
      path: target,
      dryRun: dry,
      treeId: valueOf('--tree'),
      fromBranch: valueOf('--branch') || '',
    });

    console.log(`   读了 ${r.filesRead} 个文件${r.truncated ? '（还有更多，先读到这）' : ''}`);
    console.log('');

    const t = r.tree || {};
    console.log(`🌳 大树：${c.green}${r.treeId || t.id || '(待定)'}${c.reset}  ${t.title || ''}`);
    if (t.type) console.log(`   ${c.dim}${t.type}${c.reset}`);

    if (!r.seeds.length) {
      console.log(`${c.dim}
   没提取到种子 —— 这份材料里可能都是落叶。${c.reset}`);
    } else {
      console.log(`
🌰 ${r.seeds.length} 颗种子：`);
      r.seeds.forEach((s, i) => {
        const id = r.created?.[i]?.id;
        console.log(`   ${id ? c.dim + id + c.reset + '  ' : ''}${s.title}`);
        if (s.labels?.length) console.log(`      ${c.dim}[${s.labels.join(', ')}]${c.reset}`);
        if (s.notApplicable) console.log(`      ${c.dim}不适用：${s.notApplicable.slice(0, 60)}${c.reset}`);
      });
    }

    if (r.reused?.length) {
      console.log(`
♻️ 复用 ${r.reused.length} 颗已有种子：`);
      for (const s of r.reused) console.log(`   ${s.id}  ${s.title}`);
    }

    if (r.duplicatesSkipped?.length) {
      console.log(`
♻️ 重复处理 ${r.duplicatesSkipped.length} 条：`);
      for (const d of r.duplicatesSkipped) {
        const how = d.reused ? `复用 ${d.duplicateOf}` : '本批重复，已跳过';
        console.log(`   ${d.title}  ${c.dim}← ${how}${c.reset}`);
      }
    }

    if (r.leaves.length) {
      console.log(`
🍂 ${r.leaves.length} 条落叶：${c.dim}${r.leaves.join(' / ')}${c.reset}`);
    }

    if (dry) {
      console.log(`
${c.dim}（--dry-run，什么都没写）${c.reset}`);
    } else {
      console.log(`
${c.green}✓ 已落盘${c.reset} ${c.dim}—— 种子是 buried、watered 0，还没被复用过。${c.reset}`);
    }
  } catch (e) {
    err(e.message);
  }
}

async function cmdConfig() {
  const patch = {};
  if (valueOf('--base-url')) patch.baseUrl = valueOf('--base-url');
  if (valueOf('--model')) patch.model = valueOf('--model');
  if (valueOf('--api-key')) patch.apiKey = valueOf('--api-key');
  if (valueOf('--api-key-env')) patch.apiKeyEnv = valueOf('--api-key-env');
  if (valueOf('--planter')) patch.planter = valueOf('--planter');

  const scorerPatch = {};
  if (valueOf('--scorer-base-url')) scorerPatch.baseUrl = valueOf('--scorer-base-url');
  if (valueOf('--scorer-model')) scorerPatch.model = valueOf('--scorer-model');
  if (valueOf('--scorer-api-key')) scorerPatch.apiKey = valueOf('--scorer-api-key');
  if (Object.keys(scorerPatch).length) {
    const current = await readConfig();
    patch.scorer = { ...(current.scorer || {}), ...scorerPatch };
  }
  if (hasFlag('--from-env')) {
    if (process.env.TREES_LLM_BASE_URL) patch.baseUrl = process.env.TREES_LLM_BASE_URL;
    if (process.env.TREES_LLM_MODEL) patch.model = process.env.TREES_LLM_MODEL;
    if (process.env.TREES_LLM_API_KEY) patch.apiKey = process.env.TREES_LLM_API_KEY;
  }

  if (Object.keys(patch).length) {
    const file = await writeConfig(patch);
    console.log(`✅ 已写入 ${file}`);
    console.log(`   ${c.dim}定时任务读的就是这份 —— 终端里的 export 它看不见。${c.reset}`);
  }

  const cfg = await readConfig();
  console.log(`
配置文件：${configPath()}`);
  if (!Object.keys(cfg).length) {
    console.log(`${c.dim}   还是空的。可以：${c.reset}`);
    console.log(`${c.dim}   trees config --from-env              （把当前环境变量存进去）${c.reset}`);
    console.log(`${c.dim}   trees config --base-url <地址> --model <模型> --api-key <key>${c.reset}`);
    return;
  }
  console.log(`   地址  ${cfg.baseUrl || c.dim + '（没设）' + c.reset}`);
  console.log(`   模型  ${cfg.model || c.dim + '（没设）' + c.reset}`);
  console.log(`   Key   ${cfg.apiKey ? '已存（明文，别提交）' : (cfg.apiKeyEnv ? `从环境变量 ${cfg.apiKeyEnv} 读` : c.dim + '（没设）' + c.reset)}`);
  console.log(`   植树人 ${cfg.planter || c.dim + `（未设置，当前用 ${await getPlanter()}）` + c.reset}`);
  console.log(`   打分器 ${cfg.scorer?.model ? `${cfg.scorer.model}${cfg.scorer.baseUrl ? `（${cfg.scorer.baseUrl}）` : ''}` : c.dim + '未单独配置，回退到上面的模型' + c.reset}`);
}

/** 向量打分：只打 D1/D2/D4 + D3 先验，不做真假/投票。 */
async function cmdScore() {
  if (hasFlag('--missing')) {
    const done = await scoreMissing({
      limit: Number(valueOf('--limit')) || 20,
      force: hasFlag('--force'),
    });
    if (!done.length) return console.log(`${c.dim}没有需要打分的种子。${c.reset}`);
    for (const item of done) {
      const { seed, score } = item;
      console.log(`${seed.id}  D1 ${score.d1} / D2 ${score.d2} / D4 ${score.d4}  ${seed.title}`);
    }
    console.log(`${c.dim}共 ${done.length} 颗。${c.reset}`);
    return;
  }

  const id = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!id) return err('用法：trees score <seed-id> [--force] | trees score --missing [--limit N]');
  const result = await scoreSeed(id, { force: hasFlag('--force') });
  if (!result) return err(`没有这颗种子：${id}`);
  const { seed, score } = result;
  console.log(`${seed.id}  ${seed.title}`);
  console.log(`   D1 抽象度 ${score.d1}  ·  D2 领域 ${score.d2}  ·  D4 风险 ${score.d4}`);
  console.log(`   D3 先验调用价值 ${score.d3}  ${c.dim}（之后只由事件更新）${c.reset}`);
  console.log(`   ${c.dim}${score.scorer} / ${score.model} / ${score.scored_at}${c.reset}`);
}

/** 统计：全部由本地数据算，不调模型。 */
async function cmdStats() {
  const report = summarize({
    seeds: await listSeeds({}),
    trees: await listTrees(),
    events: await listEvents({ limit: Number.MAX_SAFE_INTEGER }),
  });
  if (hasFlag('--json')) return console.log(JSON.stringify(report, null, 2));

  const states = Object.entries(report.seeds.byState).map(([k, v]) => `${k} ${v}`).join('  ');
  const types = Object.entries(report.events.byType).map(([k, v]) => `${k} ${v}`).join('  ');
  console.log(`种子 ${report.seeds.total}  ·  大树 ${report.trees.total}  ·  事件 ${report.events.total}`);
  console.log(`状态 ${states || '(空)'}`);
  console.log(`浇水 ${report.seeds.watered}  ·  失败 ${report.seeds.failed}`);
  console.log(`事件 ${types || '(空)'}`);
  const planters = Object.entries(report.planters);
  if (planters.length) console.log(`植树人 ${planters.map(([k, v]) => `${k} ${v}`).join('  ')}`);
}

/** 检索：管理 AI 出计划 → 文本召回 → 四维过滤。 */
async function cmdSearch() {
  const query = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!query) return err('用法：trees search "<任务>" [--limit N] [--no-ai] [--json]');

  const seeds = (await listSeeds({})).filter((s) => s.state !== 'boxed');
  let plan;
  if (hasFlag('--no-ai')) {
    plan = fallbackPlan(query);
  } else {
    try {
      plan = await planQuery(query, { callModel: await scorerCallModel() });
    } catch {
      plan = fallbackPlan(query);
    }
  }

  const result = searchSeeds(query, seeds, {
    plan,
    limit: Number(valueOf('--limit')) || 8,
  });

  if (hasFlag('--json')) return console.log(JSON.stringify(result, null, 2));

  console.log(`计划 ${plan.source}  keywords [${plan.keywords.join(', ')}]`);
  console.log(`     D1 ${plan.d1_min}~${plan.d1_max} · D2 ${plan.d2_min}~${plan.d2_max} · D4 ≤ ${plan.d4_max}`);
  if (!result.results.length) {
    console.log(`${c.dim}没有命中。${c.reset}`);
    return;
  }
  for (const item of result.results) {
    const v = item.vector
      ? `D1 ${item.vector.d1} / D2 ${item.vector.d2} / D4 ${item.vector.d4}`
      : '未打分';
    console.log(`  ${item.score}  ${item.id}  ${item.title}  ${c.dim}${v}${c.reset}`);
  }
}

/** 查重：只报告，不删除、不改种子。近重复是否同义交给模型判。 */
async function cmdDedup() {
  const near = Number(valueOf('--threshold')) || 0.7;
  const seeds = await listSeeds({});
  const { exactGroups, nearPairs } = findDuplicates(seeds, { near });

  let judged = nearPairs;
  if (hasFlag('--ai') && nearPairs.length) {
    const limit = Number(valueOf('--limit')) || 10;
    const { chat } = await import('../src/llm/chat.js');
    const callModel = (messages, maxTokens) => chat({ messages, maxTokens });
    judged = [];
    for (const pair of nearPairs.slice(0, limit)) {
      try {
        judged.push({ ...pair, ai: await judgePair(pair, callModel) });
      } catch (error) {
        judged.push({ ...pair, aiError: error.message });
      }
    }
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      total: seeds.length,
      exactGroups: exactGroups.map((g) => g.seeds.map((s) => ({ id: s.id, title: s.title }))),
      nearPairs: judged.map((p) => ({
        a: { id: p.a.id, title: p.a.title },
        b: { id: p.b.id, title: p.b.title },
        score: p.score,
        verdict: p.verdict,
        ai: p.ai || null,
        aiError: p.aiError || null,
      })),
    }, null, 2));
    return;
  }

  if (!exactGroups.length && !nearPairs.length) {
    console.log(`✓ 没有发现重复（扫了 ${seeds.length} 颗）`);
    return;
  }

  if (exactGroups.length) {
    console.log(`\n${c.red}精确重复 ${exactGroups.length} 组${c.reset}（归一化后完全相同）`);
    for (const group of exactGroups) {
      console.log(`  ${group.seeds.map((s) => `${s.id} ${s.title}`).join('  ＝  ')}`);
    }
  }

  if (judged.length) {
    console.log(`\n${c.yellow}近重复 ${judged.length} 对${c.reset}（阈值 ${near}）`);
    for (const pair of judged) {
      const ai = pair.ai ? `  → ${pair.ai.verdict}：${pair.ai.reason}` : '';
      const err = pair.aiError ? `  → AI 失败：${pair.aiError}` : '';
      console.log(`  ${pair.score}  ${pair.a.id} ${pair.a.title}  ↔  ${pair.b.id} ${pair.b.title}${ai}${err}`);
    }
    if (!hasFlag('--ai')) console.log(`${c.dim}   加 --ai 让模型判断是不是同一条（same / subset / overlap / different）${c.reset}`);
  }
}

/** 树牌：一句话 + 标签；列表/索引只显示它，正文按需展开。 */
async function cmdPlaque() {
  const id = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!id) return err('用法：trees plaque <tree-id> ["一句话"] [--labels a,b]');

  const tree = await readTree(id);
  if (!tree) return err(`没有这棵大树：${id}`);

  const text = args[1] && !args[1].startsWith('-') ? args[1] : '';
  const labelsRaw = valueOf('--labels');
  const patch = {};
  if (text) patch.plaque = text;
  if (labelsRaw) patch.labels = labelsRaw.split(',').map((x) => x.trim()).filter(Boolean);

  const next = Object.keys(patch).length ? await writeTree({ ...tree, ...patch }) : tree;
  console.log(`${c.cyan}${next.id}${c.reset}  ${next.plaque || c.dim + '(无树牌)' + c.reset}`);
  console.log(`   标签：${(next.labels || []).join(', ') || '(无)'}`);
  console.log(`   植树人：${next.planter || '(未知)'}  ·  ${(next.branches || []).length} 分支 / ${(next.seeds || []).length} 种子`);
}

/** 选择性发布：只把这棵树和它挂着的种子放进 git 发布包。 */
async function cmdShare() {
  const id = args[0] && !args[0].startsWith('-') ? args[0] : '';
  if (!id) return err('用法：trees share <tree-id>');

  const { dir, manifest } = await shareTree(id);
  console.log(`📦 发布包：${dir}`);
  console.log(`   ${manifest.seeds.length} 颗种子 · 树牌：${manifest.tree.plaque || '(无)'}`);
  console.log(`${c.dim}只复制这棵树挂着的种子；没有联网，也没有删除任何东西。${c.reset}`);
  console.log(`${c.dim}下一步：把整个目录提交到公开 git 仓库；订阅方先核对 manifest.json 里的 sha256。${c.reset}`);
}

/** 事件账本：谁在什么时候对哪颗种子做了什么。 */
async function cmdEvents() {
  if (hasFlag('--verify')) {
    const result = await verifyEvents();
    if (result.ok) {
      console.log(`✓ 账本完整：${result.count} 条（链式 ${result.chained} / 旧格式 ${result.legacy}）`);
      console.log(`  head ${result.head || '(空)'}`);
    } else {
      console.log(`✗ 账本在第 ${result.brokenAt} 条断裂：${result.reason}`);
      process.exitCode = 1;
    }
    return;
  }

  const events = await listEvents({
    limit: Number(valueOf('--limit')) || 30,
    type: valueOf('--type') || '',
    seed: valueOf('--seed') || '',
    tree: valueOf('--tree') || '',
    actor: valueOf('--actor') || '',
  });
  if (!events.length) {
    console.log(`${c.dim}账本还是空的 —— 播种或浇水之后再来。${c.reset}`);
    return;
  }
  for (const e of events) {
    const who = e.actor ? ` ${e.actor}` : '';
    const target = e.seed || e.tree || '';
    const title = e.title ? `  ${e.title}` : '';
    console.log(`${c.dim}${e.ts}${c.reset}  ${e.type.padEnd(6)}${who}  ${target}${title}`);
  }
}

async function cmdGrow() {
  const plan = buildGrowPlan({
    cliPath: SELF,
    treesHome: getForestRoot(),
    at: valueOf('--at') || DEFAULT_AT,
  });

  if (hasFlag('--show')) {
    console.log(`🌱 自然生长：${plan.kind === 'schtasks' ? 'Windows 计划任务' : 'crontab'} · 每天 ${plan.at}`);
    console.log(`
它会往你电脑上写这一个文件：`);
    console.log(`${c.dim}${plan.wrapperPath}${c.reset}`);
    console.log(`${c.dim}${'-'.repeat(50)}${c.reset}`);
    console.log(plan.wrapper.trimEnd());
    console.log(`${c.dim}${'-'.repeat(50)}${c.reset}`);
    console.log(`
它注册的命令：`);
    if (plan.kind === 'schtasks') console.log(`  ${plan.register.cmd} ${plan.register.args.join(' ')}`);
    else console.log(`  ${plan.cronLine}`);
    console.log(`
日志会落在：${plan.logPath}`);
    console.log(`${c.dim}没动任何东西 —— 真要装加 --install。${c.reset}`);
    return;
  }

  if (hasFlag('--install')) {
    const cfg = await readConfig();
    const llm = await (await import('../src/llm/chat.js')).describeConfig();
    if (!llm.configured && !cfg.baseUrl) {
      console.log(`${c.yellow}⚠️  还没配模型。定时任务跑的时候会失败（而且你看不见）。${c.reset}`);
      console.log(`${c.dim}   先跑：trees config --from-env   或  trees config --base-url ... ${c.reset}`);
    }
    const r = await growInstall(plan);
    console.log(r.ok ? `🌱 ${r.message}` : `${c.red}✗ ${r.message}${c.reset}`);
    if (r.ok) {
      console.log(`${c.dim}   任务名：${TASK_NAME}${c.reset}`);
      console.log(`${c.dim}   它只做学习：补旁证和正文，不加浇水、不升状态。${c.reset}`);
      console.log(`${c.dim}   想关掉：trees grow --uninstall${c.reset}`);
    }
    return;
  }

  if (hasFlag('--uninstall')) {
    const r = await growUninstall(plan);
    console.log(r.ok ? `🍂 ${r.message}` : `${c.red}✗ ${r.message}${c.reset}`);
    return;
  }

  const st = growStatus(plan);
  console.log(`🌱 自然生长   ${st.installed ? c.green + '已装' + c.reset : c.dim + '没装' + c.reset}`);
  console.log(`   ${c.dim}${st.detail || '-'}${c.reset}`);
  if (st.logTail) {
    console.log('');
    console.log('   最近一次日志：');
    for (const l of st.logTail.split(String.fromCharCode(10))) {
      console.log('     ' + c.dim + l + c.reset);
    }
  }
  if (!st.installed) {
    console.log('');
    console.log('   装上：trees grow --install [--at 03:17]');
    console.log(`${c.dim}   先看看它会写什么：trees grow --show${c.reset}`);
  }
}

async function cmdTrees() {
  const every = await listTrees();
  // 会话节点是原料，默认不混在项目列表里；--all 才显示
  const all = hasFlag('--all') ? every : every.filter((t) => t.kind !== 'session');
  if (!all.length) {
    console.log('🌳 还没有大树 —— 做完一个项目就会长出一棵。');
    if (every.length) console.log(`${c.dim}   （另有 ${every.length} 个未完成的会话节点，trees trees --all 查看）${c.reset}`);
    return;
  }
  console.log(`${all.length} 棵大树：`);
  for (const t of all) {
    const n = (t.seeds || []).length;
    const b = (t.branches || []).length;
    console.log(`  ${c.dim}${t.id}${c.reset}  ${t.title}  ${c.dim}(${b} 分支 / ${n} 种子)${c.reset}`);
  }
}

async function cmdTree() {
  const id = plainArgs[0];
  if (!id) return err('用法：trees tree <tree-id>');
  const t = await readTree(id);
  if (!t) return err(`找不到大树：${id}`);
  console.log(`${c.green}${t.id}${c.reset}  ${t.title}`);
  console.log(`  分类 ${t.type || '-'}   建 ${t.created}   改 ${t.updated}   父树 ${t.forest_id || '-'}`);
  if ((t.branches || []).length) {
    console.log('  分支：');
    for (const b of t.branches) {
      console.log(`    ${b.branch_id}  ${b.model || '-'}  ${b.role || '-'}  ${b.outcome || ''}`);
    }
  }
  const seeds = await getTreeSeeds(id);
  if (seeds.length) {
    console.log('  种子：');
    for (const s of seeds) console.log(seedLine(s));
  }
  if (t.body) console.log(`\n${t.body.trim()}`);
}

async function cmdForest() {
  const child = plainArgs[0];
  const parent = valueOf('--under');
  if (!child || !parent) return err('用法：trees forest <子树> --under <父树>');
  try {
    const t = await linkForest(child, parent);
    console.log(`🌲 ${t.id} 已挂到 ${parent} 之下`);
    const members = await getForestMembers(child);
    console.log(`   树群共 ${members.length} 棵：${members.map((m) => m.id).join(' → ')}`);
  } catch (e) {
    return err(e.message);
  }
}

async function cmdStatus() {
  const seeds = await listSeeds({});
  const trees = (await listTrees()).filter((t) => t.kind !== 'session');
  console.log(`🌳 大树 ${trees.length} 棵     🌰 种子 ${seeds.length} 颗`);
  if (!seeds.length) {
    if (!trees.length) return emptyHint();
    console.log(`${c.dim}   还没有种子 —— 下次做完项目就会播种。${c.reset}`);
    return;
  }
  const byState = {};
  for (const s of seeds) byState[s.state] = (byState[s.state] || 0) + 1;
  const order = ['buried', 'sprouting', 'growing', 'advanced', 'boxed'];
  console.log('   ' + order.filter((k) => byState[k]).map((k) => `${k} ${byState[k]}`).join(c.dim + '  |  ' + c.reset));
  const totalWater = seeds.reduce((n, s) => n + s.watered, 0);
  const totalFail = seeds.reduce((n, s) => n + s.failed, 0);
  console.log(`   浇水合计 ${totalWater} 次，失败 ${totalFail} 次`);

  const byBranch = {};
  for (const s of seeds) {
    if (!s.from_branch) continue;
    byBranch[s.from_branch] = byBranch[s.from_branch] || { n: 0, w: 0, f: 0 };
    byBranch[s.from_branch].n++;
    byBranch[s.from_branch].w += s.watered;
    byBranch[s.from_branch].f += s.failed;
  }
  const rows = Object.entries(byBranch);
  if (rows.length) {
    console.log(`\n${c.cyan}AI 能力画像${c.reset} ${c.dim}(越用越准 → 直接喂给派单决策)${c.reset}`);
    for (const [model, v] of rows.sort((a, b) => b[1].n - a[1].n)) {
      const rate = v.w + v.f ? Math.round((v.w / (v.w + v.f)) * 100) : 100;
      console.log(`   ${model.padEnd(22)} 出种 ${String(v.n).padStart(3)}   成活率 ${rate}%`);
    }
  }
  const top = seeds.slice().sort((a, b) => b.watered - a.watered)[0];
  if (top && top.watered > 0) console.log(`\n   最常用：${top.id} ${top.title}（浇水 ${top.watered} 次）`);
}

function err(msg) {
  console.error(`${c.red}✗ ${msg}${c.reset}`);
  process.exitCode = 1;
}

const NOT_YET = new Set(['health', 'import', 'export', 'profile', 'uninstall']);

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);

  if (NOT_YET.has(cmd)) {
    console.log(`${c.yellow}「${cmd}」还没实现。${c.reset}`);
    console.log(`${c.dim}核心数据层（seed / tree / forest）已完成；它需要接 LLM，见 docs/00-SPEC.md §5「白天 / 黑夜」。${c.reset}`);
    return;
  }

  // 除 init 自己处理 --dry-run 外，都先把目录准备好（幂等）—— 空库也不能报错
  if (cmd !== 'init') await ensureDirs();

  const table = {
    init: cmdInit, new: cmdNew, ls: cmdLs, list: cmdLs, show: cmdShow, water: cmdWater,
    find: cmdFind, search: cmdSearch, dedup: cmdDedup, recall: cmdRecall, box: cmdBox, summon: cmdSummon, sweep: cmdSweep,
    score: cmdScore, stats: cmdStats,
    trees: cmdTrees, tree: cmdTree, plaque: cmdPlaque, share: cmdShare, forest: cmdForest, status: cmdStatus,
    candidates: cmdCandidates, synthesize: cmdSynthesize, unsynthesize: cmdUnsynthesize,
    waiting: cmdWaiting, need: cmdNeed, dream: cmdDream,
    config: cmdConfig, grow: cmdGrow, plant: cmdPlant, index: cmdIndex, auto: cmdAuto,
    events: cmdEvents,
    tip: cmdTip, use: cmdUse, finish: cmdFinish, unfinish: cmdUnfinish,
    'plant-branch': cmdPlantBranch, recycle: cmdRecycle, 'plant-project': cmdPlantProject,
  };
  const fn = table[cmd];
  if (!fn) {
    console.log(`${c.red}未知命令：${cmd}${c.reset}`);
    return console.log(HELP);
  }
  await fn();
}

main().catch((e) => err(e.message || String(e)));
