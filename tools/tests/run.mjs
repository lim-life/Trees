/**
 * Trees 自测 —— 零依赖，跑法：`node tests/run.mjs`
 *
 * 测试自己在系统临时目录建一个数据根，跑完清理，不碰你的 forest/。
 * 覆盖三块：frontmatter 往返、seed 状态机、tree/forest 关系与防环。
 */
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 必须在 import 核心模块之前设好 —— paths.js 启动时读它
const HOME = path.join(tmpdir(), `trees-selftest-${process.pid}`);
process.env.TREES_HOME = HOME;
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
  const dry = await plant.plantFrom({ path: dir, callModel: fake, dryRun: true });
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
    seeds: [{ title: '完成项目后的经验', labels: ['auto'], criteria: 'c', method: 'm', notApplicable: 'n', evidence: 'session' }],
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
  const r1 = await auto.runAuto({ material, cwd, config: cfg, minChars: 100, callModel: fakeModel('ongoing', ['还剩两页']), logPath });
  const tree1 = await tree.readTree(r1.key);
  t('session: 结束时只记录会话树', tree1?.kind === 'session' && tree1.project_status === 'ongoing');
  t('session: 未完成项目不播种', (await seed.listSeeds({ from_tree: r1.key })).length === 0);

  // 第二次会话自动接续
  const r2 = await auto.runAuto({ material, cwd, config: cfg, minChars: 100, callModel: fakeModel('ongoing', ['还剩一页']), logPath });
  t('session: 自动接续上一条链', (await tree.readTree(r2.key)).continues_from === r1.key);
  t('session: 未完成不合并', (await project.evaluateChain(r2.key)).ready === false);

  // 第三次会话明确完成 → 合并 + 首次播种
  const r3 = await auto.runAuto({ material, cwd, config: cfg, minChars: 100, callModel: fakeModel('complete', [], true), logPath });
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

console.log(log.join('\n'));
console.log(`\n${log.length - failed}/${log.length} 通过，${failed} 失败`);
await rm(HOME, { recursive: true, force: true });
if (failed) process.exitCode = 1;
