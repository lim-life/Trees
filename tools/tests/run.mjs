/**
 * Trees 自测 —— 零依赖，跑法：`node tests/run.mjs`
 *
 * 测试自己在系统临时目录建一个数据根，跑完清理，不碰你的 forest/。
 * 覆盖三块：frontmatter 往返、seed 状态机、tree/forest 关系与防环。
 */
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 必须在 import 核心模块之前设好 —— paths.js 启动时读它
const HOME = path.join(tmpdir(), `trees-selftest-${process.pid}`);
process.env.TREES_HOME = HOME;
// 配置也隔离到临时目录，否则测试会读到本机真实的 key（既污染测试也泄漏）
process.env.TREES_CONFIG_HOME = path.join(HOME, 'confhome');
process.env.TREES_RECORDED = path.join(HOME, 'recorded.json');
delete process.env.TREES_CONFIG;
await rm(HOME, { recursive: true, force: true });
await mkdir(HOME, { recursive: true });

const { parse, stringify } = await import('../src/core/frontmatter.js');
const seed = await import('../src/core/seed.js');
const tree = await import('../src/core/tree.js');
const forest = await import('../src/core/forest.js');
const syn = await import('../src/core/synthesize.js');

let failed = 0;
const log = [];
const t = (name, ok) => {
  log.push(`${ok ? 'PASS  ' : 'FAIL  '}${name}`);
  if (!ok) failed++;
};
const throws = async (fn) => {
  try { await fn(); return false; } catch { return true; }
};

// ───────────────────────── frontmatter ─────────────────────────
{
  const BS = String.fromCharCode(92);
  const data = {
    id: 'seed-0001',
    title: 'MSYS 路径要用 Unix 格式',
    labels: ['Windows', 'bash', '路径'],
    empty: [],
    confidence: 1,
    ok: true,
    none: null,
    branches: [
      { branch_id: 'design', model: 'claude-opus-5-5', seeds_planted: ['seed-0012', 'seed-0015'] },
      { branch_id: 'impl', cost: 1.2 },
    ],
    quote: 'he said "hi" and ' + BS + 'path',
  };
  const md = stringify(data, '## 判据\n\nx\n');
  const back = parse(md).data;

  t('fm: 空数组往返为 []', Array.isArray(back.empty) && back.empty.length === 0);
  t('fm: 内联数组', JSON.stringify(back.labels) === JSON.stringify(data.labels));
  t('fm: 数字', back.confidence === 1);
  t('fm: 布尔', back.ok === true);
  t('fm: null', back.none === null);
  t('fm: 对象数组条数', back.branches.length === 2);
  t('fm: 对象数组字段', back.branches[0].branch_id === 'design' && back.branches[1].branch_id === 'impl');
  t('fm: 对象内嵌数组', JSON.stringify(back.branches[0].seeds_planted) === JSON.stringify(['seed-0012', 'seed-0015']));
  t('fm: 对象内嵌数字', back.branches[1].cost === 1.2);
  t('fm: 中文含冒号', back.title === data.title);
  t('fm: 引号与反斜杠还原', back.quote === data.quote);
  t('fm: 正文保留', parse(md).content.includes('## 判据'));

  // 对象里的长数组：写成 "key: - x" 会整棵大树读不回来
  const longList = ['seed-0001', 'seed-0002', 'seed-0003', 'seed-0004', 'seed-0005', 'seed-0006'];
  const big = stringify({ id: 'x', branches: [{ branch_id: 'b', seeds_planted: longList }] }, '');
  const bigBack = parse(big).data.branches[0].seeds_planted;
  t('fm: 对象内长数组往返', Array.isArray(bigBack) && bigBack.length === 6 && bigBack[5] === 'seed-0006');
}

// ───────────────────────── seed 状态机 ─────────────────────────
{
  t('seed: 空库 nextId = seed-0001', (await seed.nextId()) === 'seed-0001');
  t('seed: 空库 listSeeds = []', (await seed.listSeeds()).length === 0);
  t('seed: 空库 readSeed -> null', (await seed.readSeed('seed-9999')) === null);

  let s = await seed.createSeed({
    title: 'MSYS 路径', labels: ['Windows', 'bash'], from_branch: 'claude-opus-5-5',
  });
  t('seed: createSeed id', s.id === 'seed-0001');
  t('seed: 默认 buried', s.state === 'buried');
  t('seed: 默认 origin/confidence', s.origin === 'native' && s.confidence === 1);
  t('seed: 有 last_watered', !!s.last_watered);

  s = await seed.waterSeed(s.id, true);
  t('seed: 浇水1次 -> sprouting', s.state === 'sprouting');
  s = await seed.waterSeed(s.id, false);
  t('seed: 失败不推进', s.state === 'sprouting' && s.failed === 1);
  s = await seed.waterSeed(s.id, true);
  t('seed: 浇水2次 -> growing', s.state === 'growing');
  s = await seed.waterSeed(s.id, true);
  s = await seed.waterSeed(s.id, true);
  t('seed: 浇水4次仍 growing', s.state === 'growing');
  s = await seed.waterSeed(s.id, true);
  t('seed: 浇水5次 -> advanced', s.state === 'advanced');

  s = await seed.boxSeed(s.id);
  t('seed: 入盒记 prev_state', s.state === 'boxed' && s.prev_state === 'advanced');
  t('seed: 盒中仍可读', (await seed.readSeed(s.id)) !== null);
  s = await seed.summonSeed(s.id);
  t('seed: 召唤回 advanced', s.state === 'advanced');

  const a = await seed.createSeed({ title: 'second' });
  t('seed: id 递增为 seed-0002', a.id === 'seed-0002');
}

// ───────────────────────── tree / forest ─────────────────────────
{
  t('tree: 空库 listTrees = []', (await tree.listTrees()).length === 0);
  t('tree: 空库 readTree -> null', (await tree.readTree('nope')) === null);
  t('tree: 无 id 抛错', await throws(() => tree.createTree({ title: 'x' })));

  const tr = await tree.createTree({ id: 'radar', title: '手与剑居家雷达', type: '工业设计' });
  t('tree: 创建成功', tr.id === 'radar' && tr.forest_id === null);
  t('tree: 正文含三段', typeof tr.body === 'string' && tr.body.includes('关键决策'));
  t('tree: listTrees = 1', (await tree.listTrees()).length === 1);

  const b = await tree.addBranch('radar', { model: 'claude-opus-5-5', role: '设计规范' });
  t('tree: 分支 id 自动生成', (b.branches || []).length === 1 && !!b.branches[0].branch_id);

  const sd = await seed.createSeed({ title: '挂到树上的种子' });
  await tree.linkSeed('radar', sd.id);
  await tree.linkSeed('radar', sd.id);
  t('tree: linkSeed 去重', ((await tree.readTree('radar')).seeds || []).length === 1);
  t('tree: 回写 seed.from_tree', (await seed.readSeed(sd.id)).from_tree === 'radar');
  t('tree: getTreeSeeds 返回对象', (await tree.getTreeSeeds('radar')).length === 1);

  t('forest: 孤树返回 [自己]', (await forest.getForestMembers('radar')).length === 1);
  await tree.createTree({ id: 'parent', title: '父项目' });
  await forest.linkForest('radar', 'parent');
  t('forest: 写入 forest_id', (await tree.readTree('radar')).forest_id === 'parent');
  t('forest: 树群 2 棵', (await forest.getForestMembers('radar')).length === 2);
  t('forest: 拒绝成环', await throws(() => forest.linkForest('parent', 'radar')));
  t('forest: 拒绝不存在的树', await throws(() => forest.linkForest('radar', 'ghost')));
}

// ───────────────────────── synthesize（按需蒸馏）─────────────────────────
{
  const mk = (title, labels, body) => seed.createSeed({ title, labels, body });
  const water = async (id, n) => {
    let s;
    for (let i = 0; i < n; i++) s = await seed.waterSeed(id, true);
    return s;
  };

  // 补位型原料：一方不灵的地方正是另一方的主场
  const bMsys = '## 判据\n在 MSYS / Git Bash 里写路径重定向时。\n\n## 做法\n用 /dev/null。\n\n## 不适用\n原生 PowerShell 或 cmd 环境。';
  const bPs = '## 判据\n在原生 PowerShell 或 cmd 里写脚本时。\n\n## 做法\n用 NUL。\n\n## 不适用\nMSYS / Git Bash 环境。';
  // 互斥：同一情境，相反的做法
  const bSayNul = '## 判据\n在 MSYS / Git Bash 里写路径重定向时。\n\n## 做法\n用 NUL。\n\n## 不适用\n无。';
  const bSayNull = '## 判据\n在 MSYS / Git Bash 里写路径重定向时。\n\n## 做法\n用 /dev/null。\n\n## 不适用\n无。';

  const msys = await mk('MSYS 用 /dev/null', ['syn', 'bash'], bMsys);
  const ps = await mk('PowerShell 用 NUL', ['syn', 'cmd'], bPs);
  const dup = await mk('MSYS 重复版', ['syn', 'bash'], bMsys);   // 跟 msys 一模一样
  const x = await mk('MSYS 说用 NUL', ['syn2', '冲突'], bSayNul);
  const y = await mk('MSYS 说用 devnull', ['syn2', '冲突'], bSayNull);

  t('syn: 证据不足时拒绝合成', await throws(() => syn.synthesizeSeed(msys.id, ps.id)));

  for (const s of [msys, ps, dup, x, y]) await water(s.id, 5);

  const rd = (id) => seed.readSeed(id);
  t('syn: 判为强互补（合起来更完整）', syn.judgeComplementarity(await rd(msys.id), await rd(ps.id)).kind === 'strong');
  t('syn: 判为等价（说的是一回事）', syn.judgeComplementarity(await rd(msys.id), await rd(dup.id)).kind === 'redundant');
  t('syn: 判为互斥（同情境相反做法）', syn.judgeComplementarity(await rd(x.id), await rd(y.id)).kind === 'conflict');
  t('syn: 互斥的直接拒绝合成', await throws(() => syn.synthesizeSeed(x.id, y.id)));

  const m = await syn.synthesizeSeed(msys.id, ps.id, { title: '路径重定向' });
  t('syn: 新种子 advanced 且浇水归零', m.state === 'advanced' && m.watered === 0);
  t('syn: bloodline 记两颗原料', m.bloodline.length === 2 && m.bloodline.includes(msys.id));
  t('syn: confidence 取较小值', m.confidence === Math.min(msys.confidence, ps.confidence));

  const m1 = await rd(msys.id);
  const p1 = await rd(ps.id);
  t('syn: 原件保留并标 synthesized_into', m1.synthesized_into === m.id && p1.synthesized_into === m.id);
  t('syn: 原件 watered 未被改动', m1.watered === 5 && p1.watered === 5);
  t('syn: 原件正文未被改动', m1.body.includes('/dev/null') && p1.body.includes('NUL'));
  t('syn: 血统查得到 2 颗', (await syn.lineage(m.id)).ancestors.length === 2);

  const r1 = await syn.unsynthesize(msys.id);
  t('syn: 拆一颗时高级种子保留', r1.removed === null && r1.remainingBloodline.length === 1);
  const r2 = await syn.unsynthesize(ps.id);
  t('syn: 原料拆光后删除高级种子', r2.removed === m.id);
  t('syn: 拆完原件都还在', !!(await rd(msys.id)) && !!(await rd(ps.id)));
}

// ───────────────────────── 前置依赖（串联）─────────────────────────
{
  const NL = String.fromCharCode(10);
  const bDetect = ['## 判据', '怀疑串口被别人占着时。', '', '## 做法', '先列串口,再逐个试着打开。', '', '## 不适用', '机器上没有串口设备。'].join(NL);
  const bBurn = ['## 判据', '要把固件烧进板子时。', '', '## 做法', '用 esptool 擦掉再写。', '', '## 不适用', '板子已经烧过而且没改。'].join(NL);

  const before = await seed.createSeed({ title: '检测串口是否被占用', labels: ['chain', '串口'], body: bDetect });
  const after = await seed.createSeed({
    title: '烧录固件要擦干净', labels: ['chain', '串口'], body: bBurn,
    requires: ['先检测串口'],
  });

  t('chain: 还没出现的前置会挂起', (await syn.findWaiting()).some((x) => x.seed.id === after.id));
  const hits = await syn.findFulfillments(await seed.readSeed(before.id));
  t('chain: 新种子被认出可能是别人在等的', hits.some((h) => h.seed.id === after.id));
  t('chain: 描述形式的前置也算「在等」', (await syn.findWaiting()).find((x) => x.seed.id === after.id).waiting.length === 1);

  await syn.addRequire(after.id, before.id);
  t('chain: 登记前置', (await seed.readSeed(after.id)).requires.includes(before.id));

  for (const id of [before.id, after.id]) {
    for (let i = 0; i < syn.SYNTH_MIN_WATERED; i++) await seed.waterSeed(id, true);
  }
  const a2 = await seed.readSeed(after.id);
  const b2 = await seed.readSeed(before.id);
  t('chain: 前置关系优先判为串联', syn.judgeComplementarity(a2, b2).kind === 'chain');

  const c = await syn.synthesizeSeed(before.id, after.id, { title: '先检测串口再烧录' });
  t('chain: 绑成一条流程', c.complement === 'chain' && c.state === 'advanced');
  t('chain: 先后顺序反映在血统里', c.bloodline[0] === before.id && c.bloodline[1] === after.id);
}

// ───────────────────────── 黑夜循环（挑谁 + 预算）─────────────────────────
{
  const dream = await import('../src/core/dream.js');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const mk = (title, lastWatered, extra = {}) => seed.createSeed({
    title, labels: ['dream'], last_watered: lastWatered,
    body: '## 判据 x 做法 y 不适用 z', ...extra,
  });

  const fresh = await mk('刚浇过的', daysAgo(5));
  const ok1 = await mk('闲置 60 天', daysAgo(60));
  const ok2 = await mk('闲置 120 天', daysAgo(120));
  const rotten = await mk('快腐烂的', daysAgo(160));

  const picks = await dream.pickDreamSeeds({});
  const ids = picks.map((p) => p.seed.id);
  t('dream: 刚浇过的不学', !ids.includes(fresh.id));
  t('dream: 快腐烂的不学', !ids.includes(rotten.id));
  t('dream: 闲置 60/120 天的被选中', ids.includes(ok1.id) && ids.includes(ok2.id));
  t('dream: 闲置越久越靠前', ids.indexOf(ok2.id) < ids.indexOf(ok1.id));
  t('dream: 一晚不超过 5 颗', picks.length <= dream.MAX_PER_NIGHT);
  const idle = picks.find((p) => p.seed.id === ok2.id).idleDays;
  t('dream: 闲置天数算得对（允许跨时区差 1 天）', idle >= 119 && idle <= 121);

  const plan = await dream.planDream({});
  t('dream: 计划里每颗都有 token 配额', plan.picks.every((p) => p.tokens === dream.TOKENS_PER_SEED));
  t('dream: 计划总额 = 颗数 × 每颗', plan.totalTokens === plan.picks.length * dream.TOKENS_PER_SEED);
  t('dream: 计划明确标注没调模型', plan.callsModel === false);

  t('dream: 超一晚 5 颗会被预算拦下', dream.checkBudget(6, 1000).ok === false);
  t('dream: 单颗超 token 会被拦下', dream.checkBudget(1, dream.TOKENS_PER_SEED + 1).ok === false);
  t('dream: 预算内放行', dream.checkBudget(5, dream.TOKENS_PER_SEED).ok === true);

  // 底线：学习不许碰资历
  const before = await seed.readSeed(ok1.id);
  t('dream: 学习不许加浇水', await throws(() => dream.applyLearning(ok1.id, { watered: 99 })));
  t('dream: 学习不许升状态', await throws(() => dream.applyLearning(ok1.id, { state: 'advanced' })));
  const after = await dream.applyLearning(ok1.id, { evidence: '补了一条旁证' });
  t('dream: 学习可以补 evidence', after.evidence === '补了一条旁证');
  t('dream: 学完后 watered/state 纹丝不动',
    after.watered === before.watered && after.state === before.state
    && after.last_watered === before.last_watered);
}

// ───────────────────────── 黑夜循环（真去学习）─────────────────────────
{
  const dream = await import('../src/core/dream.js');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const target = await seed.createSeed({
    title: '夜里要学的那颗', labels: ['dreamrun'],
    last_watered: daysAgo(80), body: '## 判据 a 做法 b 不适用 c',
  });

  const before = await seed.readSeed(target.id);
  let seenPrompt = '';
  const fake = async (messages) => {
    seenPrompt = messages[0].content;
    return {
      text: '{"evidence":"来自 X 规范的旁证","body":"## 判据 新 做法 新 不适用 新"}',
      usage: { total_tokens: 1234 },
    };
  };

  const r = await dream.runDream({ callModel: fake, seedIds: [target.id] });
  const after = await seed.readSeed(target.id);
  t('dreamrun: 跑成功', r.results.length === 1 && r.results[0].ok === true, JSON.stringify(r.results[0]));
  t('dreamrun: 补上了 evidence', after.evidence === '来自 X 规范的旁证');
  t('dreamrun: 正文被更新', after.body.includes('新 做法'));
  t('dreamrun: 记录了 token 用量', r.spentTokens === 1234);
  t('dreamrun: 浇水和状态纹丝不动',
    after.watered === before.watered && after.state === before.state
    && after.last_watered === before.last_watered);
  t('dreamrun: 提示词带了种子正文', seenPrompt.includes('不适用 c'));

  // 模型出错时不能把种子写坏
  const bad = async () => ({ text: '这不是 JSON', usage: null });
  const r2 = await dream.runDream({ callModel: bad, seedIds: [target.id] });
  const after2 = await seed.readSeed(target.id);
  t('dreamrun: 模型乱答时记失败', r2.results[0].ok === false);
  t('dreamrun: 失败时种子没被改坏', after2.body === after.body && after2.evidence === after.evidence);

  // dry-run 绝不调模型
  let called = false;
  await dream.runDream({ dryRun: true, seedIds: [target.id], callModel: async () => { called = true; return { text: '{}' }; } });
  t('dreamrun: dry-run 一次都没调模型', called === false);
}

// ───────────────────────── 自然生长（安装方案 + 配置）─────────────────────────
{
  const grow = await import('../src/schedule/grow.js');
  const base = { cliPath: '/x/cli.js', treesHome: '/x/forest', dir: '/tmp/growdir' };

  const win = grow.buildGrowPlan({ ...base, platform: 'win32', nodePath: 'C:/node.exe' });
  t('grow: Windows 走计划任务', win.kind === 'schtasks');
  t('grow: 包装脚本写死了 TREES_HOME', win.wrapper.includes('TREES_HOME='));
  t('grow: 默认时间 03:17', win.at === grow.DEFAULT_AT);
  t('grow: 任务名带「自然生长」', grow.TASK_NAME.includes('自然生长') && win.register.args.includes(grow.TASK_NAME));
  t('grow: 注册成每天一次', win.register.args.includes('/SC') && win.register.args.includes('DAILY'));
  // 踩过：UTF-8 批处理里的中文路径被 cmd.exe 按 GBK 读成乱码，node 找不到 cli.js
  t('grow: Windows 包装脚本先切 UTF-8，中文路径才不会变乱码',
    win.wrapper.includes('chcp 65001') && win.wrapper.indexOf('chcp 65001') < win.wrapper.indexOf('TREES_HOME='));
  const def = grow.buildGrowPlan({ cliPath: '/x/cli.js', treesHome: '/x/forest', platform: 'linux' });
  t('grow: 默认包装脚本落在 ~/.trees 下', def.wrapperPath.includes('.trees'));

  const nix = grow.buildGrowPlan({ ...base, platform: 'linux', nodePath: '/usr/bin/node' });
  t('grow: Unix 走 crontab', nix.kind === 'crontab');
  t('grow: cron 表达式正确', nix.cronLine.startsWith('17 3 * * *'), nix.cronLine);
  t('grow: 时间可自定义', grow.buildGrowPlan({ ...base, platform: 'linux', at: '22:05' }).cronLine.startsWith('5 22 * * *'));
  t('grow: 非法时间报错', await throws(async () => grow.buildGrowPlan({ ...base, at: '99:99' })));
  t('grow: 缺 cliPath 报错', await throws(async () => grow.buildGrowPlan({ treesHome: '/x' })));

  const cfg = await import('../src/core/config.js');
  const { loadLlmConfig } = await import('../src/llm/chat.js');
  await cfg.writeConfig({ baseUrl: 'https://example.test/v1', model: 'cheap-model' });
  const c1 = await cfg.readConfig();
  t('config: 写进去能读回来', c1.baseUrl === 'https://example.test/v1' && c1.model === 'cheap-model');
  await cfg.writeConfig({ model: 'cheap-model-2' });
  t('config: 合并写不丢旧键', (await cfg.readConfig()).baseUrl === 'https://example.test/v1');
  t('config: 缺 key 时判定为没配', (await loadLlmConfig({})) === null);
  await cfg.writeConfig({ apiKey: 'test-key' });
  const ll = await loadLlmConfig({});
  t('config: 配全了就能用', Boolean(ll) && ll.model === 'cheap-model-2');
  t('config: 环境变量优先于文件', (await loadLlmConfig({ TREES_LLM_MODEL: 'env-wins' })).model === 'env-wins');
  await cfg.unsetConfig(['baseUrl', 'model', 'apiKey']);
}

// ───────────────────────── 播种（plant）─────────────────────────
{
  const plant = await import('../src/core/plant.js');
  const { mkdtemp, writeFile: wf } = await import('node:fs/promises');
  const os = await import('node:os');

  const NL = String.fromCharCode(10);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trees-plant-'));
  await wf(path.join(dir, 'README.md'), '# 手与剑居家雷达' + NL + NL + '做了个磁吸开关。', 'utf8');
  await wf(path.join(dir, 'notes.txt'), '换了个壁纸。装了 OpenSCAD。', 'utf8');
  await wf(path.join(dir, 'skip.bin'), 'x', 'utf8');

  const got = await plant.collectMaterials(dir);
  t('plant: 收集到文本文件', got.files.length === 2, JSON.stringify(got.files.map((f) => path.basename(f))));
  t('plant: 非文本后缀被跳过', !got.files.some((f) => f.endsWith('.bin')));

  const fakeReply = JSON.stringify({
    tree: { id: 'hand-sword-radar', title: '手与剑居家雷达', type: '工业设计' },
    seeds: [{
      title: '磁吸开关钢件必须无磁',
      labels: ['工业设计', '材料'],
      criteria: '设计磁感应触发的结构时',
      method: '用 304 无磁不锈钢',
      notApplicable: '纯机械触发、不靠磁场的场合',
      evidence: 'README.md',
    }],
    leaves: ['换壁纸', '装 OpenSCAD'],
  });
  const fake = async () => ({ text: fakeReply, usage: { total_tokens: 3000 } });

  // dry-run：一个字都不写
  const beforeCount = (await seed.listSeeds({})).length;
  const dry = await plant.plantFrom({ path: dir, callModel: fake, fromBranch: 'test-model', dryRun: true });
  t('plant: dry-run 提取到 1 颗种子', dry.seeds.length === 1 && dry.written === false);
  t('plant: dry-run 识别出 2 条落叶', dry.leaves.length === 2);
  t('plant: dry-run 没落盘', (await seed.listSeeds({})).length === beforeCount);

  // 真落盘
  const real = await plant.plantFrom({ path: dir, callModel: fake, fromBranch: 'test-model' });
  const made = real.created[0];
  t('plant: 长出了一棵大树', (await tree.readTree('hand-sword-radar')) !== null);
  t('plant: 种子落盘了', (await seed.readSeed(made.id)) !== null);
  t('plant: 种子是 buried 且没浇过水', made.state === 'buried' && made.watered === 0);
  t('plant: 种子挂到了树下', (await tree.getTreeSeeds('hand-sword-radar')).some((s) => s.id === made.id));
  t('plant: 正文三段齐全', made.body.includes('## 判据') && made.body.includes('## 不适用'));
  t('plant: 记下了来源模型', made.from_branch === 'test-model');
  t('plant: 记下了证据指针', made.evidence === 'README.md');

  t('plant: 重复播种同一棵树会被拦', await throws(() => plant.plantFrom({ path: dir, callModel: fake })));
  t('plant: 空目录会报错', await throws(() => plant.plantFrom({ path: path.join(dir, 'nope'), callModel: fake })));
}

// ───────────────────────── 老化巡检 / 学习守门 / 流式 / 分支 ─────────────────────────
{
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const NL = String.fromCharCode(10);
  const body = (j, m, n) => ['## 判据', j, '', '## 做法', m, '', '## 不适用', n].join(NL);

  // ① 180 天没浇水 → 自动入盒
  const stale = await seed.createSeed({
    title: '很久没浇水', born: daysAgo(200), last_watered: daysAgo(200), body: body('a', 'b', 'c'),
  });
  const boxedNow = await seed.sweepAging();
  const staleAfter = await seed.readSeed(stale.id);
  t('sweep: 180 天没浇水自动入盒', staleAfter.state === 'boxed' && boxedNow.some((s) => s.id === stale.id));
  t('sweep: 记下入盒前状态', staleAfter.prev_state === 'buried');

  // ② 学习不许无证据改主张
  const dream2 = await import('../src/core/dream.js');
  const claim = await seed.createSeed({ title: '主张不许乱改', body: body('旧判据', '旧做法', '旧边界') });
  t('learn: 无证据改判据被拒', await throws(() => dream2.applyLearning(claim.id, { body: body('新判据', '旧做法', '旧边界') })));
  const withProof = await dream2.applyLearning(claim.id, { evidence: '依据 X', body: body('新判据', '新做法', '旧边界') });
  t('learn: 带证据可以改主张', withProof.evidence === '依据 X' && withProof.body.includes('新判据'));
  t('learn: 只改边界不需要证据', (await dream2.applyLearning(claim.id, { body: body('新判据', '新做法', '新边界') })).body.includes('新边界'));

  // ③ 流式：能拼回完整输出、能识别截断
  const { chat } = await import('../src/llm/chat.js');
  const cfg = { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', timeoutMs: 1000 };
  const sse = (chunks) => new Response(new ReadableStream({
    start(ctrl) { const enc = new TextEncoder(); for (const x of chunks) ctrl.enqueue(enc.encode(x)); ctrl.close(); },
  }), { status: 200 });
  const good = async () => sse([
    'data: {"model":"m","choices":[{"delta":{"content":"{\\"a\\":"}}]}' + NL + NL,
    'data: {"choices":[{"delta":{"content":"1}"},"finish_reason":"stop"}],"usage":{"total_tokens":12}}' + NL + NL,
    'data: [DONE]' + NL + NL,
  ]);
  const got = await chat({ messages: [{ role: 'user', content: 'x' }], config: cfg, fetchImpl: good });
  t('llm: 流式拼回完整输出并记 usage', got.text === '{"a":1}' && got.usage.total_tokens === 12);
  const cut = async () => sse(['data: {"choices":[{"delta":{"content":"半截"},"finish_reason":"length"}]}' + NL + NL]);
  t('llm: finish_reason=length 报错', await throws(() => chat({ messages: [], config: cfg, fetchImpl: cut })));
  const noEnd = async () => sse(['data: {"choices":[{"delta":{"content":"半截"}}]}' + NL + NL]);
  t('llm: 没有结束标记也报错', await throws(() => chat({ messages: [], config: cfg, fetchImpl: noEnd })));

  // ④ plant 把分支记到树上（复用上面 plant 块播过的树）
  const radar = await tree.readTree('hand-sword-radar');
  t('plant: 分支记到树上', (radar.branches || []).some((b) => b.model === 'test-model' && b.seeds_planted.length > 0));
}

// ───────────────────────── init --dry-run 不碰文件系统 ─────────────────────────
{
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
  const target = path.join(HOME, 'initdry');
  spawnSync(process.execPath, [cli, 'init', '--dry-run'], {
    env: { ...process.env, TREES_HOME: target }, encoding: 'utf8',
  });
  t('init: --dry-run 不建目录', !existsSync(path.join(target, 'seeds')));
}

// ───────────────────────── 召回层 ─────────────────────────
{
  const rec = await import('../src/core/recall.js');
  const NL = String.fromCharCode(10);
  const B = (j, m, n) => ['## 判据', j, '', '## 做法', m, '', '## 不适用', n].join(NL);

  const serial = await seed.createSeed({
    title: 'ZephyrRTOS 固件烧录前枚举串口',
    labels: ['召回测试', '串口', '烧录'],
    body: B('在 ZephyrRTOS 板子上烧录固件时', '先枚举串口再传端口号', '产线端口已绑死时'),
  });
  await seed.createSeed({
    title: 'ZephyrRTOS 编译缓存清理',
    labels: ['召回测试', '编译'],
    body: B('ZephyrRTOS 构建报缓存错误', '删 build 目录重编', '增量构建正常时'),
  });
  const dormant = await seed.createSeed({
    title: 'ZephyrRTOS 旧烧录经验',
    labels: ['召回测试', '串口', '烧录'],
    body: B('ZephyrRTOS 烧录', '旧做法', '现在不用'),
  });
  await seed.boxSeed(dormant.id);

  const r = await rec.recall('ZephyrRTOS 串口烧录');
  t('recall: 最相关的排第一', r.picks[0]?.seed.id === serial.id, r.picks.map((p) => p.seed.title).join(' | '));
  t('recall: 命中标签', Boolean(r.picks[0]?.matchedLabels.includes('串口')));
  t('recall: 默认不召回盒子', !r.picks.some((p) => p.seed.id === dormant.id));
  t('recall: --all 能召回盒子', (await rec.recall('ZephyrRTOS 串口烧录', { includeBoxed: true })).picks.some((p) => p.seed.id === dormant.id));
  t('recall: 预算生效', (await rec.recall('ZephyrRTOS', { budget: 150, limit: 10 })).tokens <= 150);

  const one = await rec.recall('ZephyrRTOS 串口烧录', { limit: 1, divergent: 2 });
  t('recall: 发散列表与命中不重复', one.divergent.length > 0 && one.divergent.every((d) => d.id !== one.picks[0].seed.id));
  t('recall: 空查询返回空', (await rec.recall('')).picks.length === 0);
  const text = rec.renderRecall(one);
  t('recall: 渲染成可注入文本', text.startsWith('## Trees 相关经验') && text.includes(serial.title));

  // Windows 检出的文件是 CRLF —— 段落切分不能把下一个标题的 # 留在上一段
  const ps = syn.parseSections('## 判据\r\nA\r\n\r\n## 做法\r\nB\r\n\r\n## 不适用\r\nC');
  t('recall: CRLF 正文不串段', ps.判据 === 'A' && ps.做法 === 'B' && ps.不适用 === 'C');
}

// ───────────────────────── 索引 ─────────────────────────
{
  const idx = await import('../src/core/indexer.js');
  const { stat } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');

  const r = await idx.renderIndex();
  const active = (await seed.listSeeds({})).find((s) => s.state !== 'boxed');
  const dormant = (await seed.listSeeds({})).find((s) => s.state === 'boxed');
  t('index: 收录活跃种子', Boolean(active) && r.text.includes(active.title));
  t('index: 休眠单独列在盒子', !dormant || (r.text.includes('## 盒子') && r.text.includes(dormant.id)));
  t('index: 带上召回提示', r.text.includes('trees recall'));

  const written = await idx.writeIndex();
  t('index: 落盘', await stat(written.path).then(() => true).catch(() => false));

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
  const empty = path.join(HOME, 'indexempty');
  const out = spawnSync(process.execPath, [cli, 'index', '--print', '--if-any'], {
    env: { ...process.env, TREES_HOME: empty }, encoding: 'utf8',
  });
  t('index: 空库静默（hook 不制造噪音）', out.stdout.trim() === '');
}

// ───────────────────────── 会话链 / 项目完成 / 首次播种 ─────────────────────────
{
  const auto = await import('../src/core/session.js');
  const project = await import('../src/core/project.js');
  const { readFile, mkdir } = await import('node:fs/promises');
  const NL = String.fromCharCode(10);

  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: '帮我做一个雷达 PPT' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '先定共享样式再分页。' }, { type: 'tool_use', name: 'x', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '工具噪音' }] } }),
    JSON.stringify({ type: 'user', message: { content: '<system-reminder>注入噪声</system-reminder>真正的需求' } }),
  ].join(NL);
  const text = auto.extractTranscript(jsonl);
  t('auto: 只留对话文本', text.includes('帮我做一个雷达 PPT') && text.includes('先定共享样式')
    && !text.includes('工具噪音') && !text.includes('注入噪声'));
  const secretText = auto.extractTranscript(JSON.stringify({
    type: 'user', message: { content: 'key 是 sk-abcdefghijklmnop1234 别泄露' },
  }));
  t('auto: 发送前遮掉密钥', !secretText.includes('sk-abcdefghijklmnop1234') && secretText.includes('sk-***'));

  const logPath = path.join(HOME, 'auto.log');
  const cwd = path.join(HOME, 'proj-home');
  await mkdir(cwd, { recursive: true });

  const summaryReply = (status, threads = [], explicit = false) => JSON.stringify({
    title: '测试会话', summary: '这次做了一部分工作。', project_status: status,
    status_reason: '依据', open_threads: threads, explicit_complete: explicit,
  });
  const seedReply = JSON.stringify({
    tree: { id: 'auto-proj', title: '自动项目', type: '测试' },
    // 闸门要求三段都写实：占位符（c / m / n）会被当成空泛边界拦下
    seeds: [{
      title: '会话结束时只记录不播种',
      labels: ['auto'],
      criteria: '长项目跨多次会话，且上一次会话还没做完时',
      method: '结束时只建会话树，项目完成才合并并提取种子',
      notApplicable: '一次性短任务不适用，直接做完即可；单一交付物也不需要跨会话',
      evidence: 'session',
    }],
    leaves: [],
  });
  // 会话归档和项目播种走同一个模型，用提示词区分
  const fakeModel = (status, threads, explicit) => async (messages, maxTokens) => ({ // eslint-disable-line no-unused-vars
    text: String(messages[0].content).includes('「播种」') ? seedReply : summaryReply(status, threads, explicit),
    usage: { total_tokens: 60 },
  });

  const cfg = { autoPlant: true, autoFinish: false, model: 'fake' };
  const material = '项目材料'.repeat(400);

  t('auto: 默认关闭时跳过', (await auto.runAuto({ material, config: {}, cwd, minChars: 100, logPath })).skipped.includes('未开启'));
  t('auto: 太短跳过', (await auto.runAuto({ material: '短', config: cfg, cwd, minChars: 100, logPath })).skipped.includes('太短'));

  // 第一次会话：只记录，不播种
  const r1 = await auto.runAuto({ material: `${material}A`, cwd, config: cfg, minChars: 100, callModel: fakeModel('ongoing', ['还剩两页']), logPath });
  const tree1 = await tree.readTree(r1.key);
  t('session: 结束时只记录会话树', tree1?.kind === 'session' && tree1.project_status === 'ongoing');
  t('session: 未完成项目不播种', (await seed.listSeeds({ from_tree: r1.key })).length === 0);

  // 第二次会话自动接续
  const r2 = await auto.runAuto({ material: `${material}B`, cwd, config: cfg, minChars: 100, callModel: fakeModel('ongoing', ['还剩一页']), logPath });
  t('session: 自动接续上一条链', (await tree.readTree(r2.key)).continues_from === r1.key);
  t('session: 未完成不合并', (await project.evaluateChain(r2.key)).ready === false);

  // 第三次会话明确完成 → 合并 + 首次播种
  const r3 = await auto.runAuto({ material: `${material}C`, cwd, config: cfg, minChars: 100, callModel: fakeModel('complete', [], true), logPath });
  t('project: 明确完成即可合并', (await project.evaluateChain(r3.key)).ready === true);
  const fin = await project.finishProject(r3.key, {
    id: 'proj-auto-test', fromBranch: 'fake', callModel: fakeModel('complete', [], true),
  });
  const seedsAfter = await seed.listSeeds({ from_tree: 'proj-auto-test' });
  t('project: 合并整条链并首次播种', fin.chain.length === 3 && seedsAfter.length > 0);
  t('project: 会话树标 merged_into', (await tree.readTree(r1.key)).merged_into === 'proj-auto-test');

  await project.unfinishProject('proj-auto-test');
  t('project: 拆回后会话恢复、种子保留',
    (await tree.readTree(r3.key)).merged_into === null
    && (await seed.readSeed(seedsAfter[0].id)).from_tree === r3.key);

  // 旁支：单独播种 / 回收
  const branch = await tree.createTree({
    id: 's-BRANCH001', title: '旁支会话', kind: 'session', root_path: cwd,
    body: '## 本次做了什么\n做了一半\n\n## 关键决策\n\n\n## 下一步\n- 继续\n',
  });
  const pb = await project.plantBranch(branch.id, {
    id: 'branch-test', fromBranch: 'fake', callModel: fakeModel('ongoing'),
  });
  t('project: 旁支单独播种', pb.seeds > 0 && (await tree.readTree('branch-test')) !== null);

  const dormant = await tree.createTree({ id: 's-DORMANT1', title: '枯树', kind: 'session', root_path: cwd });
  await project.recycleBranch(dormant.id);
  t('project: 旁支可回收休眠', (await tree.readTree(dormant.id)).dormant === true);

  // 自动合并
  const cwd2 = path.join(HOME, 'proj-home-2');
  await mkdir(cwd2, { recursive: true });
  const r4 = await auto.runAuto({
    material, cwd: cwd2, config: { autoPlant: true, autoFinish: true, model: 'fake' },
    minChars: 100, callModel: fakeModel('complete', [], true), logPath,
  });
  t('auto: 满足条件自动合并并播种', Boolean(r4.mergedInto) && (await tree.readTree(r4.mergedInto)) !== null);
  t('auto: 合并后清掉接续点', (await project.findLastKey(cwd2)) === null);

  t('auto: 写了回写日志', (await readFile(logPath, 'utf8').catch(() => '')).includes('session'));
}

// ───────────────────────── Phase 1: 身份 / 事件账本 / 证据 / 材料 ─────────────────────────
{
  const { writeConfig } = await import('../src/core/config.js');
  const events = await import('../src/core/events.js');
  const plant = await import('../src/core/plant.js');
  const { scoreSeed } = await import('../src/core/recall.js');
  const { mkdir: mk, writeFile: wf, readFile: rf } = await import('node:fs/promises');

  await writeConfig({ planter: 'tester' });

  const s = await seed.createSeed({
    title: 'planter 与证据字段', labels: ['x'], criteria: 'c', method: 'm', notApplicable: 'n',
    evidence_level: 'L2', external_ids: { doi: '10.1/x' }, derived_from: ['seed-0001'],
  });
  t('phase1: planter 从配置注入', s.planter === 'tester');
  t('phase1: 证据字段落盘', s.evidence_level === 'L2'
    && s.external_ids.doi === '10.1/x' && s.derived_from.length === 1);

  const back = await seed.readSeed(s.id);
  t('phase1: 证据字段磁盘往返', back.external_ids.doi === '10.1/x' && back.planter === 'tester');
  const objRt = parse(stringify({ external_ids: { doi: '10.1/x' }, empty: {} }, '')).data;
  t('phase1: 嵌套对象往返', objRt.external_ids.doi === '10.1/x'
    && Object.keys(objRt.empty).length === 0);
  t('phase1: 非法证据等级回落 L0',
    (await seed.createSeed({ title: 'bad level', evidence_level: 'L9' })).evidence_level === 'L0');

  const ev1 = await events.listEvents({});
  t('phase1: 播种写事件',
    ev1.some((e) => e.type === 'plant' && e.seed === s.id && e.actor === 'tester'));

  await seed.waterSeed(s.id, true);
  await seed.waterSeed(s.id, false);
  const ev2 = await events.listEvents({ seed: s.id });
  t('phase1: 浇水/失败写事件',
    ev2.some((e) => e.type === 'water') && ev2.some((e) => e.type === 'fail'));

  const chainOk = await events.verifyEvents();
  t('phase1: 账本哈希链完整',
    chainOk.ok && chainOk.chained > 0 && /^[a-f0-9]{64}$/.test(chainOk.head));

  const tr = await tree.createTree({
    id: 'phase1-tree', title: '树牌测试', plaque: '一句话树牌', labels: ['a', 'b'],
  });
  t('phase1: 旧树牌搬进备注且与植树人共存',
    tr.curator_note === '一句话树牌' && tr.curator_note_source === 'migrated-plaque'
    && tr.planter === 'tester' && tr.labels.length === 2);

  // 近重复的材料优先读文档、跳过草稿
  const dir = path.join(HOME, 'material-test');
  await mk(path.join(dir, '_junk'), { recursive: true });
  await wf(path.join(dir, '_junk', 'x.md'), 'JUNK');
  await wf(path.join(dir, '_scratch.md'), 'SCRATCH');
  await wf(path.join(dir, '需求.md'), '# 需求\n正文');
  await wf(path.join(dir, 'code.html'), '<h1>x</h1>');
  const got = await plant.collectMaterials(dir);
  t('phase1: 跳过 _ 目录和 _ 文件',
    !got.text.includes('JUNK') && !got.text.includes('SCRATCH'));
  t('phase1: 文档优先于代码', got.files[0].endsWith('需求.md'));

  // 截断自动翻倍重试
  let calls = 0;
  let retryTokens = 0;
  const fakeCall = async (_messages, maxTokens) => {
    calls++;
    retryTokens = maxTokens;
    if (calls === 1) throw new Error('模型输出被截断（finish_reason=length）');
    return {
      text: '{"tree":{"id":"retry","title":"t"},"seeds":[],"leaves":[]}',
      usage: {}, model: 'fake',
    };
  };
  const retried = await plant.extractSeeds({
    material: 'x', source: 'x', callModel: fakeCall, maxSeeds: 1,
  });
  t('phase1: 截断自动翻倍重试', calls === 2 && retryTokens === 16000 && retried.tree.id === 'retry');

  const plaqueModel = async () => ({
    text: JSON.stringify({
      tree: { id: 'plaque-test', title: 't', curator_note: '一句话树牌', labels: ['a', 'b'] },
      seeds: [], leaves: [],
    }),
    usage: {}, model: 'fake',
  });
  const withPlaque = await plant.extractSeeds({
    material: 'x', source: 'x', callModel: plaqueModel, maxSeeds: 1,
  });
  t('phase1: 播种提取备注', withPlaque.tree.curator_note === '一句话树牌'
    && withPlaque.tree.labels.join(',') === 'a,b');

  // 选择性发布：只打包选中的树 + 它挂着的种子
  const share = await import('../src/core/share.js');
  const shareTree = await tree.createTree({
    id: 'share-test', title: '共享测试', plaque: '只发这一棵', labels: ['share'],
  });
  const s1 = await seed.createSeed({ title: '共享种子一', criteria: 'c', method: 'm', notApplicable: 'n' });
  const s2 = await seed.createSeed({ title: '共享种子二', criteria: 'c', method: 'm', notApplicable: 'n' });
  const outsider = await seed.createSeed({ title: '不该发布', criteria: 'c', method: 'm', notApplicable: 'n' });
  await tree.linkSeed(shareTree.id, s1.id);
  await tree.linkSeed(shareTree.id, s2.id);

  const bundle = await share.shareTree(shareTree.id);
  const manifest = JSON.parse(await rf(path.join(bundle.dir, 'manifest.json'), 'utf8'));
  t('phase1: 发布包只含这棵树的种子', manifest.seeds.length === 2
    && manifest.seeds.every((s) => s.id !== outsider.id));
  t('phase1: 每个文件都有 sha256', /^[a-f0-9]{64}$/.test(manifest.tree.sha256)
    && manifest.seeds.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  t('phase1: 树与种子标为 shared',
    (await tree.readTree(shareTree.id)).visibility === 'shared'
    && (await seed.readSeed(s1.id)).visibility === 'shared');
  t('phase1: 未选中的种子仍是 private',
    (await seed.readSeed(outsider.id)).visibility === 'private');

  // 规则 7：自己的种子权重更高，但只是排序，不改状态
  const own = {
    id: 'seed-9001', title: '同名', labels: [], body: '同一段话 同一段话',
    watered: 0, planter: 'tester', confidence: 1,
  };
  const other = { ...own, id: 'seed-9002', planter: 'stranger', confidence: 0.5 };
  const a = scoreSeed(own, '同一段话', 'tester');
  const b = scoreSeed(other, '同一段话', 'tester');
  t('phase1: 自己的种子召回权重更高',
    a.score > b.score && a.weight === 1 && b.weight === 0.5);

  // 查重：归一化 / 精确 / 近重复 / AI 判定 / 播种时跳过
  const dedup = await import('../src/core/dedup.js');
  const dupBase = {
    title: 'Windows 路径',
    body: '## 判据\n在 MSYS 里\n\n## 做法\n用 /dev/null\n\n## 不适用\n原生 PowerShell',
  };
  const dupVariant = {
    title: 'Windows 路径',
    body: '## 判据\n在​ MSYS　里  \n\n## 做法\n用 /dev/null\n\n## 不适用\n原生 PowerShell',
  };
  t('phase1: 归一化忽略零宽与空白', dedup.exactHash(dupBase) === dedup.exactHash(dupVariant));

  const nearA = {
    id: 'seed-8001', title: '截图验收',
    body: '## 判据\n需要逐页检查页面\n\n## 做法\n用无头浏览器逐页截图\n\n## 不适用\n依赖真实交互时',
  };
  const nearB = {
    id: 'seed-8002', title: '截图验收方法',
    body: '## 判据\n需要逐页检查页面效果\n\n## 做法\n用无头浏览器逐页截图并检查\n\n## 不适用\n依赖真实交互状态时',
  };
  const found = dedup.findDuplicates([nearA, nearB], { near: 0.5 });
  t('phase1: 近重复能被找到', found.nearPairs.length === 1 && found.nearPairs[0].score > 0.5);

  const groups = dedup.findDuplicates([dupBase, dupVariant, nearA]);
  t('phase1: 精确重复分组', groups.exactGroups.length === 1
    && groups.exactGroups[0].seeds.length === 2);

  const judged = await dedup.judgePair(
    { a: nearA, b: nearB },
    async () => ({ text: '{"verdict":"same","reason":"只是换了词"}' }),
  );
  t('phase1: AI 判重解析', judged.verdict === 'same' && judged.reason.length > 0);

  await seed.createSeed({
    title: '重复播种测试',
    sections: { criteria: '同一判据', method: '同一做法', not_applicable: '同一不适用' },
  });
  const dupModel = async () => ({
    text: JSON.stringify({
      tree: { id: 'dup-tree', title: 't' },
      seeds: [{
        title: '重复播种测试', labels: [], criteria: '同一判据',
        method: '同一做法', notApplicable: '同一不适用',
      }],
      leaves: [],
    }),
    usage: {}, model: 'fake',
  });
  const plantedDup = await plant.plantFromMaterial({
    material: 'x', source: 'x', callModel: dupModel, treeId: 'dup-tree', maxSeeds: 1,
  });
  t('phase1: 播种时跳过精确重复',
    plantedDup.created.length === 0 && plantedDup.duplicatesSkipped.length === 1);

  // 向量 / 内容哈希 / scorer / 统计
  const content = await import('../src/core/content.js');
  t('phase1: 内容哈希忽略标点与零宽',
    content.contentHash('a', 'x，y z') === content.contentHash('a', 'x y z​'));

  const vecSeed = await seed.createSeed({
    title: '向量测试',
    sections: { criteria: 'c', method: 'm', not_applicable: 'n' },
    vector: { d1: 0.1, d2: 0.2, d4: 0.8, scorer: 'v1', scored_at: '2026-10-28' },
    call_value: 0.42,
  });
  const vecBack = await seed.readSeed(vecSeed.id);
  t('phase1: 向量与 D3 落盘',
    vecBack.vector.d1 === 0.1 && vecBack.vector.d4 === 0.8
    && vecBack.call_value === 0.42 && /^[a-f0-9]{64}$/.test(vecBack.content_hash));

  const scorer = await import('../src/core/scorer.js');
  let scoreCalls = 0;
  const fakeScore = async () => {
    scoreCalls++;
    return { text: '{"d1":0.1,"d2":0.2,"d3":0.6,"d4":0.9}', model: 'fake-scorer' };
  };
  const score1 = await scorer.scoreText('唯一内容 A', { callModel: fakeScore });
  const score2 = await scorer.scoreText('唯一内容 A', { callModel: fakeScore });
  t('phase1: scorer 解析与缓存',
    score1.d1 === 0.1 && score1.d4 === 0.9 && scoreCalls === 1 && score2.d3 === 0.6);

  const scored = await scorer.scoreSeed(vecSeed.id, {
    force: true,
    callModel: async () => ({ text: '{"d1":0.2,"d2":0.3,"d3":0.4,"d4":0.5}', model: 'fake' }),
  });
  t('phase1: scoreSeed 写回向量',
    scored.seed.vector.d1 === 0.2 && scored.seed.call_value === 0.4);

  const stats = await import('../src/core/stats.js');
  const report = stats.summarize({
    seeds: [{ id: 's1', state: 'buried', watered: 2, failed: 1, planter: 'p', title: 't' }],
    trees: [{}],
    events: [{ type: 'plant', seed: 's1' }, { type: 'water', seed: 's1' }],
  });
  t('phase1: 统计由本地数据算出',
    report.seeds.total === 1 && report.events.byType.water === 1 && report.perSeed.s1.used === 1);

  // 检索空间：查询计划 + 四维过滤 + 文本召回
  const space = await import('../src/core/space.js');
  const plan = space.parsePlan('{"keywords":["geth","私链"],"d2_max":0.3,"d4_max":0.2}');
  t('phase1: 查询计划解析', plan.keywords.includes('geth') && plan.d2_max === 0.3 && plan.source === 'model');

  const geth = {
    id: 'seed-7001', title: 'Geth 私链初始化', body: '## 判据\n搭私链\n\n## 做法\ngeth init genesis.json\n\n## 不适用\n无',
    vector: { d1: 0.1, d2: 0, d4: 0.1 }, call_value: 0.5, watered: 2,
  };
  const art = {
    id: 'seed-7002', title: '水彩上色', body: '## 判据\n画画\n\n## 做法\n先浅后深\n\n## 不适用\n无',
    vector: { d1: 0.8, d2: 0.9, d4: 0 }, call_value: 0.5, watered: 2,
  };
  const hit = space.searchSeeds('搭一条 geth 私链', [geth, art], { plan, limit: 5 });
  t('phase1: 四维过滤 + 文本召回', hit.results.length === 1 && hit.results[0].id === 'seed-7001');

  const planned = await space.planQuery('画画', {
    callModel: async () => ({ text: '{"keywords":["水彩"],"d2_min":0.8,"d2_max":1,"d4_max":0.1}' }),
  });
  t('phase1: planQuery 调用管理模型', planned.source === 'model' && planned.keywords[0] === '水彩');

  // 篡改检测：改一条字段但不重算 hash，必须被发现
  const evFile = events.eventsPath();
  const evLines = (await rf(evFile, 'utf8')).trimEnd().split('\n');
  const firstEvent = JSON.parse(evLines[0]);
  firstEvent.title = 'tampered';
  evLines[0] = JSON.stringify(firstEvent);
  await wf(evFile, `${evLines.join('\n')}\n`);
  const broken = await events.verifyEvents();
  t('phase1: 篡改可被发现', broken.ok === false && broken.brokenAt === 1);
}

// ───────────────────────── 坐标牌 ─────────────────────────
{
  const { mkdir: mk, writeFile: wf, readFile: rf, readdir } = await import('node:fs/promises');
  const plaque = await import('../src/core/plaque.js');
  const reindex = await import('../src/core/reindex.js');
  const recallMod = await import('../src/core/recall.js');

  const treesDir = path.join(HOME, 'trees');
  await mk(treesDir, { recursive: true });

  // 1. 落盘往返：扁平两键 + refs 全列
  await tree.createTree({ id: 'index-tree', title: '坐标牌测试', type: '前端 / 网页' });
  const a1 = await seed.createSeed({
    title: '多页演示先定共享样式',
    labels: ['CSS', '网页'],
    body: '## 判据\n多页演示分人做\n\n## 做法\n先定共享变量\n\n## 不适用\n单页面',
  });
  const a2 = await seed.createSeed({
    title: '验收要无头截图',
    labels: ['验收'],
    body: '## 判据\n要看渲染结果\n\n## 做法\n用无头浏览器截图\n\n## 不适用\n纯后端',
  });
  await tree.linkSeed('index-tree', a1.id);
  await tree.linkSeed('index-tree', a2.id);
  await reindex.reindexTree('index-tree');

  const rawTree = await rf(path.join(treesDir, 'index-tree.md'), 'utf8');
  const back = await tree.readTree('index-tree');
  t('plaque: 落盘是扁平两键，refs 按种子顺序全列',
    rawTree.includes('\nindex_refs:')
    && back.index.refs.length === 4
    && back.index.refs[0].seed === a1.id && back.index.refs[0].section === '判据'
    && back.index.refs[1].section === '不适用'
    && back.index.refs[2].seed === a2.id);

  const provisionalBefore = plaque.isProvisional(await tree.getTreeSeeds('index-tree'));
  await seed.waterSeed(a1.id, true);
  const provisionalAfter = plaque.isProvisional(await tree.getTreeSeeds('index-tree'));
  t('plaque: 浇水前算未验证，浇过就不是', provisionalBefore === true && provisionalAfter === false);

  // 2. 逐字节重建
  const snapshot = async () => {
    const names = (await readdir(treesDir)).filter((n) => n.endsWith('.md')).sort();
    const out = {};
    for (const name of names) out[name] = await rf(path.join(treesDir, name), 'utf8');
    return out;
  };
  await reindex.reindexAll();
  const first = await snapshot();
  const second = await reindex.reindexAll();
  const again = await snapshot();
  const identical = Object.keys(first).length === Object.keys(again).length
    && Object.keys(first).every((name) => first[name] === again[name]);
  t('plaque: 连跑两次逐字节一致，第二次不写盘', identical && second.updated === 0);

  // 3. 引用失效
  await tree.createTree({ id: 'orphan-tree', title: '孤儿引用' });
  const doomed = await seed.createSeed({
    title: '会被删掉',
    body: '## 判据\nx\n\n## 做法\ny\n\n## 不适用\nz',
  });
  await tree.linkSeed('orphan-tree', doomed.id);
  await reindex.reindexTree('orphan-tree');
  await seed.deleteSeed(doomed.id);

  const orphanTree = await tree.readTree('orphan-tree');
  const orphanSummary = plaque.summarizeIndex(orphanTree.index, await tree.getTreeSeeds('orphan-tree'));
  t('plaque: 种子没了只报引用失效，树仍可读',
    orphanTree !== null && orphanSummary.includes('引用失效 2 条'));

  await reindex.reindexTree('orphan-tree');
  t('plaque: 重建后孤儿引用被剔除',
    (await tree.readTree('orphan-tree')).index.refs.length === 0);

  // 4. 畸形 index：修，不抛
  const NL = String.fromCharCode(10);
  await wf(path.join(treesDir, 'bad-index.md'), [
    '---', 'id: "bad-index"', 'title: "畸形牌"',
    'index:', '  domain: 123', '  artifact: "prototype"', '  size: "huge"',
    'index_refs:', '  - seed: "not-a-seed"', '    section: "判据"',
    '  - seed: "seed-0001"', '    section: "不存在"',
    '---', '',
  ].join(NL));
  const bad = await tree.readTree('bad-index');
  t('plaque: 畸形字段被修而不是让树读不出来',
    bad !== null && bad.index.domain === 'other' && bad.index.size === 'unknown'
    && bad.index.refs.length === 0);
  t('plaque: 修完还能原样写回去',
    bad !== null && (await tree.writeTree(bad)) !== null);

  // 5. 旧 plaque 迁移
  await wf(path.join(treesDir, 'legacy-plaque.md'),
    ['---', 'id: "legacy-plaque"', 'title: "旧牌"', 'plaque: "旧树牌"', '---', ''].join(NL));
  const legacy = await tree.readTree('legacy-plaque');
  t('plaque: 旧 plaque 搬进备注并标来源',
    legacy !== null && legacy.curator_note === '旧树牌'
    && legacy.curator_note_source === 'migrated-plaque');
  await tree.writeTree(legacy);
  const rewritten = await rf(path.join(treesDir, 'legacy-plaque.md'), 'utf8');
  t('plaque: 写回后文件里不再有 plaque 键',
    !/^plaque:/m.test(rewritten) && rewritten.includes('旧树牌'));

  // 6. 坐标牌不参与召回
  const query = '多页演示 分人做 无头截图';
  const beforeIds = (await recallMod.recall(query)).picks.map((p) => p.seed.id).join(',');
  await reindex.reindexAll();
  const afterIds = (await recallMod.recall(query)).picks.map((p) => p.seed.id).join(',');
  t('plaque: 重建坐标牌不改变召回结果', beforeIds === afterIds);
}

// ───────────────────────── 夜间维护 ─────────────────────────
{
  const { readFile: rf, readdir } = await import('node:fs/promises');
  const nightly = await import('../src/core/nightly.js');
  const grow = await import('../src/schedule/grow.js');

  const plan = grow.buildGrowPlan({
    platform: 'win32', nodePath: 'n.exe', cliPath: '/x/cli.js', treesHome: '/x/forest', dir: '/tmp/gd',
  });
  t('nightly: 定时任务跑的是整条维护链，不是只跑 dream',
    plan.wrapper.includes(' nightly ') && !plan.wrapper.includes(' dream --run'));

  const r = await nightly.runNightly({ free: true });
  t('nightly: 六个步骤都执行，一步失败不连累其他',
    r.steps.length === 6
    && r.steps.find((s) => s.name === '重建坐标牌').ok === true
    && r.steps.find((s) => s.name === '刷新目录').ok === true);

  // 上一条测试故意改坏了账本，这里正好验证「坏了会被报出来」而不是静默通过
  t('nightly: 账本坏了会报错而不是静默通过',
    r.steps.find((s) => s.name === '账本校验').ok === false && r.ok === false);

  const treesDir = path.join(HOME, 'trees');
  const files = (await readdir(treesDir)).filter((n) => n.endsWith('.md')).sort();
  const before = {};
  for (const name of files) before[name] = await rf(path.join(treesDir, name), 'utf8');
  await nightly.runNightly({ dryRun: true });
  let unchanged = true;
  for (const name of files) {
    if ((await rf(path.join(treesDir, name), 'utf8')) !== before[name]) unchanged = false;
  }
  t('nightly: dry-run 不改任何树文件', unchanged);
}

// ───────────────────────── 闸门 ─────────────────────────
{
  const { readFile: rf, writeFile: wf, mkdir: mk, stat } = await import('node:fs/promises');
  const firewall = await import('../src/core/firewall.js');

  const good = {
    title: 'Windows .cmd 首行加 chcp 65001',
    criteria: '在 cmd.exe 下执行含中文路径的 .cmd 时',
    method: '首行写 chcp 65001 > nul',
    notApplicable: '纯 PowerShell 脚本不适用；全 ASCII 路径也不需要',
    branch: 'deepseek-flash',
  };
  t('gate: 合格种子放行', firewall.inspect(good).ok === true);

  const vague = { ...good, notApplicable: '无' };
  t('gate: 「不适用：无」被拦下',
    firewall.inspect(vague).ok === false
    && firewall.inspect(vague).errors.some((e) => e.code === 'vague-boundary'));

  const missing = { ...good, notApplicable: '' };
  t('gate: 缺一段被拦下',
    firewall.inspect(missing).errors.some((e) => e.code === 'missing-section'));

  const anonymous = { ...good, branch: '' };
  t('gate: 没有署名被拦下 —— 匿名的经验不可审计',
    firewall.inspect(anonymous).errors.some((e) => e.code === 'anonymous'));

  const bloated = { ...good, method: 'x'.repeat(firewall.LIMITS.maxSectionChars + 1) };
  t('gate: 单段过长被拦下（这是文档不是经验）',
    firewall.inspect(bloated).errors.some((e) => e.code === 'too-long'));

  // 拦下 ≠ 删除：进隔离区，可列出、可放行
  const bad = { ...good, notApplicable: '看情况', title: '空泛的一条' };
  const verdict = firewall.inspect(bad);
  await firewall.quarantine([{ candidate: bad, verdict }], { tree: 'gate-tree', branch: 'deepseek-flash' });
  const files = await firewall.listQuarantine();
  const target = files.find((f) => f.title === '空泛的一条');
  t('gate: 被拦的进隔离区而不是消失', Boolean(target) && target.reasons.includes('vague-boundary'));

  const released = await firewall.acceptQuarantine(target.file);
  t('gate: 复核后能读回来放行',
    released.title === '空泛的一条' && released.branch === 'deepseek-flash'
    && released.criteria === good.criteria);
  t('gate: 放行后离开待审队列',
    !(await firewall.listQuarantine()).some((f) => f.title === '空泛的一条'));

  // ── 配置：三级查找 ──
  const cfgMod = await import('../src/core/config.js');
  await mk(path.join(HOME, 'confhome'), { recursive: true });
  await wf(path.join(HOME, 'config.json'), JSON.stringify({ model: 'legacy-model', planter: 'old' }), 'utf8');
  await wf(path.join(HOME, 'confhome', 'config.json'), JSON.stringify({ model: 'machine-model' }), 'utf8');

  const merged = await cfgMod.readConfig();
  t('config: 机器级覆盖森林里的旧配置', merged.model === 'machine-model' && merged.planter === 'old');

  const migrated = await cfgMod.migrateConfig();
  const machineRaw = JSON.parse(await rf(migrated.to, 'utf8'));
  t('config: 迁移把旧键搬进机器级且不丢已有的',
    machineRaw.planter === 'old' && machineRaw.model === 'machine-model');
  t('config: 迁移保留旧文件，不删',
    await stat(path.join(HOME, 'config.json')).then(() => true).catch(() => false));

  // 收尾：把这份测试配置清掉，免得影响后面的读取
  await wf(path.join(HOME, 'config.json'), '{}', 'utf8');
  await wf(path.join(HOME, 'confhome', 'config.json'), '{}', 'utf8');
}

// ───────────────────────── MCP 适配器 ─────────────────────────
{
  const mcp = await import('../src/adapters/mcp.js');
  const install = await import('../src/adapters/install.js');

  const init = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  t('mcp: 回显客户端要的协议版本，不硬编码',
    init.result.protocolVersion === '2099-01-01' && init.result.serverInfo.name === 'trees');
  t('mcp: initialize 带 instructions —— 模型才知道要先 recall',
    init.result.instructions.includes('recall') && init.result.instructions.includes('water'));

  const list = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  t('mcp: 只暴露两个工具（工具越少越容易被用对）',
    list.result.tools.length === 2
    && list.result.tools.map((x) => x.name).join(',') === 'recall,water');

  const notified = await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  t('mcp: 通知不回复', notified === null);

  const called = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'recall', arguments: { task: 'Windows 批处理脚本', limit: 2 } },
  });
  t('mcp: recall 返回可读文本',
    Array.isArray(called.result.content) && called.result.content[0].text.length > 20);

  const badWater = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'water', arguments: { seed_id: 'seed-9999' } },
  });
  t('mcp: 浇不存在的种子返回错误而不是崩溃', badWater.result.isError === true);

  const unknown = await mcp.handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope/nope' });
  t('mcp: 未知方法回 -32601', unknown.error.code === -32601);

  const plan = install.buildPlan('cursor', { cliPath: '/x/cli.js', nodePath: '/x/node' });
  t('mcp: 宿主方案只写自己那一项',
    plan.kind === 'json' && JSON.parse(plan.snippet).mcpServers.trees.args[1] === 'mcp');
  const tomlPlan = install.buildPlan('codex', { cliPath: '/x/cli.js', nodePath: '/x/node' });
  t('mcp: Codex 用 TOML 段', tomlPlan.snippet.includes('[mcp_servers.trees]'));
  t('mcp: 五个宿主都有方案',
    ['cursor', 'cline', 'gemini', 'codex', 'claude'].every((h) => Boolean(install.buildPlan(h, { cliPath: '/x/cli.js' }))));
}

// ───────────────────────── 领域 / 分片 / 漂移 ─────────────────────────
{
  const shard = await import('../src/core/shard.js');
  const drift = await import('../src/core/drift.js');
  const recallMod = await import('../src/core/recall.js');
  const eventsMod = await import('../src/core/events.js');

  const full = (t) => `## 判据\n${t}时\n\n## 做法\n照做\n\n## 不适用\n别的时候`;

  // 领域由标签确定性推导
  const d1 = await seed.createSeed({ title: '代码相关的种子', labels: ['代码'], body: full('写代码') });
  t('domain: 由标签推导，不靠模型', d1.domain === 'software');

  // 显式写过的领域不能被重新推导覆盖 —— 否则人改的分类下次读盘就丢了
  const d2 = await seed.createSeed({ title: '被人工改过分类的种子', labels: ['代码'], domain: 'ops', body: full('运维') });
  t('domain: 显式写的优先，不会被标签覆盖', d2.domain === 'ops');
  t('domain: 读回来还是 ops', (await seed.readSeed(d2.id)).domain === 'ops');

  // 浇水时记下用在哪
  await seed.waterSeed(d1.id, true, { domain: 'hardware', tree: 'proj-A' });
  await seed.waterSeed(d1.id, true, { domain: 'hardware', tree: 'proj-A' });
  await seed.waterSeed(d1.id, true, { domain: 'hardware', tree: 'proj-B' });
  const waterEvents = await eventsMod.listEvents({ seed: d1.id, type: 'water' });
  t('water: 事件带上领域与项目',
    waterEvents.length === 3 && waterEvents[0].domain === 'hardware' && waterEvents[0].tree === 'proj-A');

  await seed.waterSeed(d2.id, true, { domain: 'web', tree: 'proj-C' });
  await seed.waterSeed(d2.id, true, { domain: 'web', tree: 'proj-C' });
  await seed.waterSeed(d2.id, true, { domain: 'web', tree: 'proj-C' });

  const r = await drift.analyzeDrift();
  t('drift: 跨域成功 ≥3 次且 ≥2 个项目 → 新方向',
    r.newDirections.some((x) => x.id === d1.id && x.to === 'hardware'));
  t('drift: 跨域成功但只有一个项目 → 分类可能要改',
    r.reclassify.some((x) => x.id === d2.id) && !r.newDirections.some((x) => x.id === d2.id));

  // 分片索引
  const built = await shard.buildShards();
  const fresh = await shard.readShards();
  t('shard: 建出来带领域分布', built.count > 0 && fresh.count === built.count && Object.keys(fresh.domains).length > 0);
  t('shard: 数量对得上就算新鲜', (await shard.freshShards()) !== null);

  // 新增一颗但不重建 → 索引过期，必须作废（否则新种子永远召回不到）
  const d3 = await seed.createSeed({ title: '还没进索引的种子', labels: ['数据'], body: full('做表') });
  t('shard: 数量对不上就作废，不拿旧索引骗人', (await shard.freshShards()) === null);
  t('shard: 索引没了召回仍然能跑（回退全库）',
    (await recallMod.recall(d3.title, { limit: 3 })).indexed === false);

  await shard.buildShards();
  const indexed = await recallMod.recall('写一段代码', { limit: 3 });
  t('recall: 有新鲜索引时走索引', indexed.indexed === true && indexed.scanned > 0);
  t('recall: 命中项带同域/跨域标记',
    indexed.picks.every((p) => typeof p.sameDomain === 'boolean') && Boolean(indexed.domain));

  // 领域标签是先验不是判决：标错/标缺的种子，靠实证在本领域翻身
  const misfiled = {
    id: 'seed-8801', title: '同样的任务描述', labels: ['代码'], domain: 'other',
    body: full('写代码'), watered: 0, failed: 0, planter: '', confidence: 1,
  };
  const native = { ...misfiled, id: 'seed-8802', domain: 'software' };
  const statsFor = { software: { w: 3, f: 0 } };
  const a = recallMod.scoreSeed({ ...misfiled }, '写代码', '', { domain: 'software', domainStats: statsFor });
  const b = recallMod.scoreSeed({ ...native }, '写代码', '', { domain: 'software' });
  t('domain: 标成 other 但在本域验证过 3 次 → 反超标对的（不允许永久惩罚）',
    a.score > b.score && a.domainWeight > 1);
  t('domain: 没被验证过时仍然按先验降权', b.domainWeight === 1
    && recallMod.scoreSeed({ ...misfiled }, '写代码', '', { domain: 'software' }).domainWeight === 0.75);

  const failedOnce = { software: { w: 0, f: 2 } };
  t('domain: 在本域失败过要往下压',
    recallMod.scoreSeed({ ...misfiled }, '写代码', '', { domain: 'software', domainStats: failedOnce }).domainWeight < 0.75);
}

// ───────────────────────── import ─────────────────────────
{
  const imp = await import('../src/core/import.js');
  const dir = path.join(HOME, 'bundle');
  await mkdir(dir, { recursive: true });
  const body = '## 判据\n\n当需要验证导入链路时\n\n## 做法\n\n先校验 sha256 再写盘\n\n## 不适用\n\n没有分享包时不需要导入\n';
  const seedText = stringify({ id: 'seed-0001', title: '外来经验：先校验再导入', labels: ['代码'], planter: 'alice', state: 'buried' }, body);
  const treeText = stringify({ id: 'import-tree', title: '外来项目', kind: 'project', planter: 'alice' }, '## 概览\n\n外来项目\n');
  const h = (x) => createHash('sha256').update(x, 'utf8').digest('hex');
  const manifest = {
    format: 'trees-share/1',
    planter: 'alice',
    tree: { id: 'import-tree', title: '外来项目', sha256: h(treeText) },
    seeds: [{ id: 'seed-0001', title: '外来经验：先校验再导入', planter: 'alice', sha256: h(seedText) }],
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(dir, 'seed-0001.md'), seedText, 'utf8');
  await writeFile(path.join(dir, 'import-tree.md'), treeText, 'utf8');

  const first = await imp.importBundle(dir);
  const seeded = await seed.readSeed(first.imported[0].id);
  t('import: 重新分配 seed id（不沿用对方 0001）', first.imported[0].id !== 'seed-0001');
  t('import: 标 external 并按 0.5 降权', seeded.origin === 'external' && seeded.confidence === 0.5);
  t('import: 署名跟原植树人，不沿用本机', seeded.planter === 'alice');
  t('import: 本地使用痕迹清零', seeded.watered === 0 && seeded.failed === 0);
  const importedTree = await tree.readTree(first.treeId);
  t('import: 大树也换 id 并挂上种子',
    Boolean(importedTree) && importedTree.seeds.includes(first.imported[0].id));

  const again = await imp.importBundle(dir);
  t('import: 重复导入按 content_hash 去重', again.skipped.length === 1 && again.imported.length === 0);

  const bad = path.join(HOME, 'bundle-bad');
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(bad, 'seed-0001.md'), seedText + '\n手改过\n', 'utf8');
  await writeFile(path.join(bad, 'import-tree.md'), treeText, 'utf8');
  t('import: 校验不过整包拒绝', await throws(() => imp.importBundle(bad)));
}

// ───────────────────────── gate 软提醒留痕 ─────────────────────────
{
  const fw = await import('../src/core/firewall.js');
  const glog = path.join(HOME, 'gate.log');
  process.env.TREES_GATE_LOG = glog;
  await fw.recordWarnings(
    [{ title: '有提醒的种子', warnings: [{ code: 'no-anchor', message: '判据没有具体线索' }] }],
    { tree: 't-demo', branch: 'b-demo' },
  );
  const text = await readFile(glog, 'utf8');
  delete process.env.TREES_GATE_LOG;
  t('gate: 软提醒只写日志不拦', text.includes('no-anchor') && text.includes('有提醒的种子'));
}

// ───────────────────────── 会话回写：dry-run 与幂等 ─────────────────────────
{
  const ses = await import('../src/core/session.js');
  const fakeModel = async () => ({
    text: JSON.stringify({
      title: '自测会话', summary: '跑了一遍回写', project_status: 'ongoing',
      status_reason: '自测', open_threads: [], explicit_complete: false,
    }),
  });
  const material = '用户：测试会话回写链路。'.repeat(60);
  const cfg = { autoPlant: true, autoFinish: false, model: 'test' };
  const logPath = path.join(HOME, 'auto.log');

  const dry = await ses.runAuto({ material, cwd: HOME, dryRun: true, config: cfg, callModel: fakeModel, logPath });
  t('auto: dry-run 不落盘（以前会偷偷写树）', dry.dryRun === true && (await tree.readTree(dry.key)) === null);

  const real = await ses.runAuto({ material, cwd: HOME, config: cfg, callModel: fakeModel, logPath });
  t('auto: 真跑写入会话树', Boolean(await tree.readTree(real.key)));

  const again = await ses.runAuto({ material, cwd: HOME, config: cfg, callModel: fakeModel, logPath });
  t('auto: 同一份对话只记一次', Boolean(again.skipped));
}

// ───────────────────────── DSH 适配器（Cordis 插件） ─────────────────────────
{
  const dsh = await import('../adapters/dsh-plugin/index.js');
  t('dsh: 插件名与依赖声明', dsh.name === 'trees' && Array.isArray(dsh.inject) && dsh.inject.includes('agents'));

  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看 Windows 批处理' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '这是插件注入' }], source: { kind: 'plugin', plugin: 'x' } } },
  ];
  const agent = { session: { events } };
  t('dsh: 取最近的人类消息（跳过插件注入）', dsh.latestUserText(agent) === '帮我看看 Windows 批处理');

  const transcript = dsh.toTranscript(events);
  t('dsh: 会话转 JSONL 只留人/AI 文本',
    transcript.includes('"type":"user"') && transcript.includes('"type":"assistant"')
    && !transcript.includes('插件注入'));

  // 用假 CLI 跑通 pre-step 注入，不依赖真实 DSH
  const fakeCli = path.join(HOME, 'fake-trees-cli.js');
  await writeFile(fakeCli, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('## Trees 测试召回');});", 'utf8');
  let handler = null;
  const ctx = { on: (ev, fn) => { if (ev === 'agent/pre-step') handler = fn; }, logger: { info() {} } };
  dsh.apply(ctx, { cli: fakeCli, recall: true, record: false });
  const out1 = await handler({ agent, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }));
  t('dsh: pre-step 注入召回结果', out1.messages.length === 1
    && JSON.stringify(out1.messages[0].content).includes('Trees 测试召回'));
  const out2 = await handler({ agent, turn: 1, step: 2, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }));
  t('dsh: 同一轮只在第一步注入', out2.messages.length === 0);
}

console.log(log.join('\n'));
console.log(`\n${log.length - failed}/${log.length} 通过，${failed} 失败`);
await rm(HOME, { recursive: true, force: true });
if (failed) process.exitCode = 1;
