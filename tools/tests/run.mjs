/**
 * Trees 自测 —— 零依赖，跑法：`node tests/run.mjs`
 *
 * 测试自己在系统临时目录建一个数据根，跑完清理，不碰你的 forest/。
 * 覆盖三块：frontmatter 往返、seed 状态机、tree/forest 关系与防环。
 */
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

console.log(log.join('\n'));
console.log(`\n${log.length - failed}/${log.length} 通过，${failed} 失败`);
await rm(HOME, { recursive: true, force: true });
if (failed) process.exitCode = 1;
