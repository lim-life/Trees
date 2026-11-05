/**
 * 播种（Plant）—— 把「做过的事」变成种子。
 *
 * 这是种子库的入口：`dream` 负责让已有的种子长大，`plant` 负责让新的进来。
 * 没有它，库只出不进。
 *
 * 要判断两件事，都是语义判断，纯规则做不到：
 *   1. 这段经历里，哪部分是「下次还能用的判断」？
 *   2. 这条算种子，还是算落叶？
 *
 * 判据只有一句（SPEC 规则 1）：
 *   **这次有没有产生「下次还能用的判断」？有 → 种子；没有 → 落叶。**
 *
 * 因为要读整份材料，所以跟 dream 一样用你配置的模型 —— 走 llm 层，core 不直接联网。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getForestRoot } from './paths.js';
import { inspect, quarantine, recordWarnings } from './firewall.js';
import { createSeed, readSeed, listSeeds } from './seed.js';
import { createTree, readTree, linkSeed, addBranch } from './tree.js';
import { reindexTree } from './reindex.js';
import { exactHash } from './dedup.js';

/** 只读这些后缀的文件。 */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.html', '.css', '.yml', '.yaml', '.toml', '.sh', '.bat', '.cmd', '.sql',
]);

/** 这些目录不进去。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  '.venv', 'venv', 'target', 'coverage', '.cache',
  '_pylibs', '_edgeprofile', '_epC', '_v3_browser', '_tmp_shots',
]);

/** 材料优先级：先文档，后代码，最后杂项。 */
const EXT_RANK = Object.freeze({
  '.md': 0, '.markdown': 0, '.txt': 1, '.html': 2, '.css': 3,
  '.js': 4, '.mjs': 4, '.cjs': 4, '.ts': 4, '.jsx': 4, '.tsx': 4,
  '.py': 5, '.json': 6, '.yml': 7, '.yaml': 7, '.toml': 7,
  '.sh': 8, '.bat': 8, '.cmd': 8, '.sql': 8,
});

/** 一次最多读多少文件、多少字节 —— 别把整个仓库塞给模型。 */
export const MAX_FILES = 40;
export const MAX_BYTES = 60000;

/**
 * 把一个文件或目录里的文本收集起来，拼成给模型看的材料。
 *
 * @param {string} target 文件或目录路径
 * @param {{maxFiles?:number, maxBytes?:number}} [opts]
 * @returns {Promise<{text:string, files:string[], skipped:number, truncated:boolean}>}
 */
export async function collectMaterials(target, opts = {}) {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  const files = [];
  const skipped = [];

  async function walk(p) {
    let st;
    try {
      st = await stat(p);
    } catch {
      return;
    }
    const base = path.basename(p);
    if (st.isDirectory()) {
      // 数据区不是材料：播自己的仓库时，forest/ 里全是已有的种子和大树，
      // 读进来等于拿种子提取种子。只跳过真正的那一个 forest 根，不按名字误伤别人的目录。
      if (path.resolve(p) === path.resolve(getForestRoot())) {
        skipped.push(p);
        return;
      }
      // 以 _ / . 开头的是草稿、浏览器 profile、临时目录 —— 不是项目经验
      const isDot = base.startsWith('.') && p !== path.resolve(target);
      if (SKIP_DIRS.has(base) || base.startsWith('_') || isDot) {
        skipped.push(p);
        return;
      }
      for (const name of await readdir(p)) {
        await walk(path.join(p, name));
      }
      return;
    }
    if (p !== path.resolve(target) && base.startsWith('_')) {
      skipped.push(p);
      return;
    }
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) {
      skipped.push(p);
      return;
    }
    files.push(p);
  }

  await walk(target);
  // 先读文档（.md/.txt），再读代码 —— 经验通常写在文档里
  files.sort((a, b) => {
    const ra = EXT_RANK[path.extname(a).toLowerCase()] ?? 9;
    const rb = EXT_RANK[path.extname(b).toLowerCase()] ?? 9;
    return ra - rb || a.localeCompare(b);
  });

  const chunks = [];
  const used = [];
  let bytes = 0;
  let truncated = false;

  for (const f of files) {
    if (used.length >= maxFiles) { truncated = true; break; }
    const size = (await stat(f)).size;
    // 装不下就跳过这一份，继续试后面更小的 —— 别让一个 50KB 的 HTML 挡住全部材料
    if (bytes + size > maxBytes) { truncated = true; continue; }
    try {
      const body = await readFile(f, 'utf8');
      chunks.push(`### ${f}\n\n${body}`);
      used.push(f);
      bytes += size;
    } catch { /* 读不了就跳过 */ }
  }

  return { text: chunks.join('\n\n'), files: used, skipped: skipped.length, truncated };
}

/** 播种用的提示词。把「什么算种子」的判据写死，免得模型见什么收什么。 */
function plantPrompt(material, sourceName) {
  return [
    '你在给一个经验库「播种」。下面是一个刚做完的项目的材料。',
    '请从中提取**可复用的经验**，每一条变成一颗种子。',
    '',
    '## 什么算种子，什么算落叶',
    '',
    '只问一句：**这次有没有产生「下次还能用的判断」？**',
    '- 有 → 种子（比如「认盘不能凭盘符，要认序列号」「MSYS 里要用 /dev/null 而不是 NUL」）',
    '- 没有 → 落叶（比如「换了个壁纸」「装了个软件」「跑了一次测试」）',
    '',
    '**宁可少提，不要凑数。一条真经验胜过十条废话。** 觉得只有一条值得留，就只提一条。',
    '',
    '## 每颗种子必须三段',
    '- `criteria` 判据：什么情况下该用它。要具体到别人能对上号，别写「需要处理文件时」这种空话。',
    '- `method` 做法：具体怎么做。',
    '- `notApplicable` 不适用：什么时候别用它。**这段最重要，别偷懒** ——',
    '  抽象最容易丢的就是它，丢了它下次换个环境照搬就出事。',
    '',
    '## 大树备注（可选）',
    '- `curator_note`：一句话的人写备注。**它不参与任何计算、不进列表**，'
    + '列表显示的是从种子投影出来的坐标牌；没有值得写的一句就留空。',
    '- `labels`：3–5 个标签，别人靠它判断要不要打开。',
    '',
    '## 输出格式（纯 JSON，不要代码围栏，不要任何解释）',
    '',
    '{"tree":{"id":"小写英文短横线","title":"项目名","type":"分类",'
    + '"curator_note":"一句话的人写备注，没有就空字符串","labels":["标签1","标签2"]},'
    + '"seeds":[{"title":"一句话，要具体","labels":["情境标签"],'
    + '"criteria":"判据正文","method":"做法正文","notApplicable":"不适用正文",'
    + '"evidence":"原始证据指针：哪个文件或哪次对话"}],'
    + '"leaves":["做了什么但没有复用价值的事"],'
    + '"project_status":"ongoing|complete|unknown",'
    + '"status_reason":"一句话依据",'
    + '"open_threads":["还没做完的事"],'
    + '"explicit_complete":false}',
    '',
    '`tree.id` 用能一眼认出的英文小写短横线名（比如 `hand-sword-radar`）。',
    '',
    '## 项目是否完成',
    '- `project_status`: `complete` 仅当用户明确说完成/交付，或所有交付物都完成且没有未完成事项；',
    '  `ongoing` 表示还有没做完的事；拿不准写 `unknown`。',
    '- `open_threads`: 还没做完的具体事项。有一个就不算完成。',
    '- `explicit_complete`: 用户是否明确说了完成/交付（true / false）。',
    '- **会话结束本身不算完成** —— 可能只是没时间了、换任务了。',
    '',
    `## 材料（来源：${sourceName}）`,
    '',
    material,
  ].join('\n');
}

/** 从模型输出里抠 JSON（它偶尔会套代码围栏）。 */
function parsePlantOutput(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('模型没返回 JSON');
  const obj = JSON.parse(raw.slice(s, e + 1));

  const tree = obj.tree && typeof obj.tree === 'object'
    ? {
      id: typeof obj.tree.id === 'string' ? obj.tree.id : '',
      title: typeof obj.tree.title === 'string' ? obj.tree.title : '',
      type: typeof obj.tree.type === 'string' ? obj.tree.type : '',
      curator_note: typeof obj.tree.curator_note === 'string' ? obj.tree.curator_note.trim() : '',
      labels: Array.isArray(obj.tree.labels)
        ? obj.tree.labels.map(String).map((x) => x.trim()).filter(Boolean)
        : [],
    }
    : null;
  const seeds = Array.isArray(obj.seeds) ? obj.seeds : [];
  const leaves = Array.isArray(obj.leaves) ? obj.leaves.filter((x) => typeof x === 'string') : [];

  const clean = seeds
    .filter((x) => x && typeof x.title === 'string' && x.title.trim())
    .map((x) => ({
      title: String(x.title).trim(),
      labels: Array.isArray(x.labels) ? x.labels.map(String).filter(Boolean) : [],
      criteria: String(x.criteria || '').trim(),
      method: String(x.method || '').trim(),
      notApplicable: String(x.notApplicable || '').trim(),
      evidence: String(x.evidence || '').trim(),
    }));

  const projectStatus = ['complete', 'ongoing', 'unknown'].includes(obj.project_status)
    ? obj.project_status
    : 'unknown';
  const openThreads = Array.isArray(obj.open_threads)
    ? obj.open_threads.map(String).map((x) => x.trim()).filter(Boolean)
    : [];

  return {
    tree,
    seeds: clean,
    leaves,
    project_status: projectStatus,
    status_reason: String(obj.status_reason || '').trim(),
    open_threads: openThreads,
    explicit_complete: obj.explicit_complete === true,
  };
}

/** 把三段拼成种子正文。 */
export function buildPlantBody(seed) {
  return [
    '## 判据',
    seed.criteria || '（待补）',
    '',
    '## 做法',
    seed.method || '（待补）',
    '',
    '## 不适用',
    seed.notApplicable || '（待补 —— 这段最容易被偷懒省掉，但也是最值钱的）',
    '',
    '## 旁证',
    seed.evidence || '',
    '',
  ].join('\n');
}

/**
 * 从材料里提取 —— 只出结果，不落盘。
 *
 * @param {{material:string, source:string, callModel?:Function, maxTokens?:number,
 *          maxSeeds?:number}} opts
 * @returns {Promise<{tree:object|null, seeds:Array, leaves:string[]}>}
 */
export async function extractSeeds(opts) {
  const callModel = opts.callModel ?? (async (messages, maxTokens) => {
    const { chat } = await import('../llm/chat.js');
    return chat({ messages, maxTokens });
  });

  const maxSeeds = opts.maxSeeds ?? 8;
  const prompt = plantPrompt(opts.material, opts.source)
    + `\n\n（最多提取 ${maxSeeds} 条，宁少勿多。）`;

  // 推理模型的 reasoning_tokens 也算在 max_tokens 里：8000 经常不够。
  // 被截断时自动翻倍重试一次，而不是把「截断」直接甩给用户。
  let maxTokens = opts.maxTokens ?? 8000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await callModel([{ role: 'user', content: prompt }], maxTokens);
      const parsed = parsePlantOutput(res.text);
      return { ...parsed, seeds: parsed.seeds.slice(0, maxSeeds), usage: res.usage ?? null };
    } catch (error) {
      const truncated = /finish_reason=length|截断/.test(String(error?.message || ''));
      if (!truncated || attempt === 1) throw error;
      maxTokens = Math.min(maxTokens * 2, 32000);
    }
  }
  // 理论不可达：循环里要么返回，要么抛出
  throw new Error('提取失败');
}

/** 把 `id` 收拾成能用的样子。 */
function safeId(id, fallback) {
  const cleaned = String(id || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * 播种：提取 + 真的落盘。
 *
 * 落成的东西：
 *   - 一棵大树（项目档案）
 *   - 每颗种子（`state: buried`、`watered: 0` —— 刚从项目里长出来，还没被复用过）
 *   - 种子挂到树下
 *
 * @param {{path:string, callModel?:Function, dryRun?:boolean, treeId?:string,
 *          fromBranch?:string, maxSeeds?:number}} opts
 * @returns {Promise<object>}
 */
export async function plantFromMaterial(opts) {
  const material = String(opts.material || '');
  if (!material.trim()) {
    throw new Error('材料是空的，没有可提取的内容');
  }

  const source = opts.source || '(材料)';
  const extracted = await extractSeeds({
    material,
    source,
    callModel: opts.callModel,
    maxSeeds: opts.maxSeeds,
  });

  const plan = {
    source,
    tree: extracted.tree,
    seeds: extracted.seeds,
    leaves: extracted.leaves,
    usage: extracted.usage,
    project_status: extracted.project_status,
    status_reason: extracted.status_reason,
    open_threads: extracted.open_threads,
    explicit_complete: extracted.explicit_complete,
    written: false,
  };

  // 精确重复不进库（改标点/改格式/塞零宽字符在归一化阶段已经失效）。
  // 近重复只提示，交给 `trees dedup --ai` 判。
  const seen = new Map();
  for (const existingSeed of await listSeeds({})) {
    seen.set(exactHash(existingSeed), existingSeed.id);
  }
  const kept = [];
  const duplicatesSkipped = [];
  const reuseIds = [];
  for (const s of extracted.seeds) {
    const hash = exactHash({ title: s.title, body: buildPlantBody(s) });
    if (seen.has(hash)) {
      const owner = seen.get(hash);
      // 库里已有同一颗：不新建，直接挂到当前树（复用，不是重复）
      if (owner !== '本批' && !reuseIds.includes(owner)) reuseIds.push(owner);
      duplicatesSkipped.push({ title: s.title, duplicateOf: owner, reused: owner !== '本批' });
      continue;
    }
    seen.set(hash, '本批');
    kept.push(s);
  }
  // 闸门：判断这条算不算经验是模型做的，但**能不能进库是由代码说了算**。
  // 被拦下的不丢，进隔离区等人复核。
  const branch = opts.fromBranch || '';
  const approved = [];
  const rejected = [];
  const warnings = [];
  for (const s of kept) {
    const verdict = inspect({
      title: s.title,
      criteria: s.criteria,
      method: s.method,
      notApplicable: s.notApplicable,
      branch,
    });
    if (verdict.ok) {
      approved.push(s);
      if (verdict.warnings.length) warnings.push({ title: s.title, warnings: verdict.warnings });
    } else {
      rejected.push({ candidate: s, verdict });
    }
  }

  plan.seeds = approved;
  plan.duplicatesSkipped = duplicatesSkipped;
  plan.reuseIds = reuseIds;
  plan.rejected = rejected.map((r) => ({
    title: r.candidate.title,
    errors: r.verdict.errors,
  }));
  plan.warnings = warnings;

  if (opts.dryRun) return plan;

  // ── 落盘 ──
  const fallbackId = `planted-${Date.now().toString(36)}`;
  const treeId = opts.treeId || safeId(extracted.tree?.id, fallbackId);

  const existing = await readTree(treeId);
  if (existing && !opts.allowExisting) {
    throw new Error(`大树 ${treeId} 已经存在了 —— 换个 id，或者用 --tree 指定另一棵`);
  }

  const treeFields = {
    id: treeId,
    title: opts.title || extracted.tree?.title || path.basename(source),
    type: opts.treeType || extracted.tree?.type || '',
    // 人写备注，不参与计算；列表显示的是下面 reindex 出来的坐标牌
    curator_note: opts.curatorNote || extracted.tree?.curator_note || '',
    curator_note_source: (opts.curatorNote || extracted.tree?.curator_note) ? 'model' : '',
    labels: opts.treeLabels || extracted.tree?.labels || [],
    root_path: opts.rootPath || opts.path || source,
    ...(opts.session === true ? {
      kind: 'session',
      continues_from: opts.continuesFrom ?? null,
      project_status: extracted.project_status,
      status_reason: extracted.status_reason,
      open_threads: extracted.open_threads,
      explicit_complete: extracted.explicit_complete,
    } : {}),
    ...(opts.treeFields || {}),
  };
  if (!existing) await createTree(treeFields);

  const created = [];
  for (const s of plan.seeds) {
    const seed = await createSeed({
      title: s.title,
      labels: s.labels,
      body: buildPlantBody(s),
      state: 'buried',
      watered: 0,
      from_tree: treeId,
      from_branch: opts.fromBranch || '',
      origin: 'native',
      evidence: s.evidence,
    });
    await linkSeed(treeId, seed.id);
    created.push(seed);
  }

  // 复用的种子也挂到当前树；同一颗种子可以属于多棵树
  const reused = [];
  for (const id of plan.reuseIds) {
    const existingSeed = await readSeed(id);
    if (!existingSeed) continue;
    await linkSeed(treeId, id);
    reused.push(existingSeed);
  }

  // 分支是 AI 能力画像的数据来源 —— 只知道是哪个模型播的种，也得记在树上。
  // 不写 outcome：这时还没有任何验证，写 good 等于伪造画像数据；
  // 留空表示「未定」，由之后的浇水/失败来填。
  const plantedIds = [...created, ...reused].map((s) => s.id);
  if (opts.fromBranch && plantedIds.length) {
    await addBranch(treeId, {
      model: opts.fromBranch,
      role: '播种提取',
      seeds_planted: plantedIds,
    });
  }

  // 被闸门拦下的进隔离区（不删），人可复核后放行
  if (rejected.length) await quarantine(rejected, { tree: treeId, branch });

  // 软提醒只记日志，不再逐条刷屏（见 firewall.recordWarnings）
  await recordWarnings(plan.warnings, { tree: treeId, branch });

  // 播完立刻建坐标牌（规则 8 的「播种即有」），免得目录里出现无牌大树
  await reindexTree(treeId);

  return { ...plan, written: true, treeId, created, reused };
}

/**
 * 从目录/文件播种（收集材料后交给 plantFromMaterial）。
 *
 * @param {{path:string, callModel?:Function, dryRun?:boolean, treeId?:string,
 *          fromBranch?:string, maxSeeds?:number}} opts
 * @returns {Promise<object>}
 */
export async function plantFrom(opts) {
  const collected = await collectMaterials(opts.path, {
    maxFiles: opts.maxFiles,
    maxBytes: opts.maxBytes,
  });
  if (!collected.text.trim()) {
    throw new Error(`这个路径里没找到可读的文本文件：${opts.path}`);
  }
  const result = await plantFromMaterial({ ...opts, material: collected.text, source: opts.path });
  return { ...result, filesRead: collected.files.length, truncated: collected.truncated };
}
