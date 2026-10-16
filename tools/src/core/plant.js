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
import { createSeed, listSeeds } from './seed.js';
import { createTree, readTree, linkSeed } from './tree.js';

/** 只读这些后缀的文件。 */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.html', '.css', '.yml', '.yaml', '.toml', '.sh', '.bat', '.cmd', '.sql',
]);

/** 这些目录不进去。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  '.venv', 'venv', 'target', 'coverage', '.cache',
]);

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
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) {
        skipped.push(p);
        return;
      }
      for (const name of await readdir(p)) {
        await walk(path.join(p, name));
      }
      return;
    }
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) {
      skipped.push(p);
      return;
    }
    files.push(p);
  }

  await walk(target);
  files.sort();

  const chunks = [];
  const used = [];
  let bytes = 0;
  let truncated = false;

  for (const f of files) {
    if (used.length >= maxFiles) { truncated = true; break; }
    const size = (await stat(f)).size;
    if (bytes + size > maxBytes) { truncated = true; break; }
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
    '## 输出格式（纯 JSON，不要代码围栏，不要任何解释）',
    '',
    '{"tree":{"id":"小写英文短横线","title":"项目名","type":"分类"},'
    + '"seeds":[{"title":"一句话，要具体","labels":["情境标签"],'
    + '"criteria":"判据正文","method":"做法正文","notApplicable":"不适用正文",'
    + '"evidence":"原始证据指针：哪个文件或哪次对话"}],'
    + '"leaves":["做了什么但没有复用价值的事"]}',
    '',
    '`tree.id` 用能一眼认出的英文小写短横线名（比如 `hand-sword-radar`）。',
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

  const tree = obj.tree && typeof obj.tree === 'object' ? obj.tree : null;
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

  return { tree, seeds: clean, leaves };
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

  const res = await callModel([{ role: 'user', content: prompt }], opts.maxTokens ?? 8000);
  const parsed = parsePlantOutput(res.text);
  return { ...parsed, seeds: parsed.seeds.slice(0, maxSeeds), usage: res.usage ?? null };
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
export async function plantFrom(opts) {
  const collected = await collectMaterials(opts.path);
  if (!collected.text.trim()) {
    throw new Error(`这个路径里没找到可读的文本文件：${opts.path}`);
  }

  const extracted = await extractSeeds({
    material: collected.text,
    source: opts.path,
    callModel: opts.callModel,
    maxSeeds: opts.maxSeeds,
  });

  const plan = {
    source: opts.path,
    filesRead: collected.files.length,
    truncated: collected.truncated,
    tree: extracted.tree,
    seeds: extracted.seeds,
    leaves: extracted.leaves,
    usage: extracted.usage,
    written: false,
  };

  if (opts.dryRun) return plan;

  // ── 落盘 ──
  const fallbackId = `planted-${Date.now().toString(36)}`;
  const treeId = opts.treeId || safeId(extracted.tree?.id, fallbackId);

  const existing = await readTree(treeId);
  if (existing) {
    throw new Error(`大树 ${treeId} 已经存在了 —— 换个 id，或者用 --tree 指定另一棵`);
  }

  await createTree({
    id: treeId,
    title: extracted.tree?.title || path.basename(opts.path),
    type: extracted.tree?.type || '',
    root_path: opts.path,
  });

  const created = [];
  for (const s of extracted.seeds) {
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

  return { ...plan, written: true, treeId, created };
}
