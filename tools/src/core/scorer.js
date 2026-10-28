/**
 * 向量打分器（Scorer）—— 系统统一的管理模型，只做一件事：
 * 把一条知识打成 [D1 抽象度, D2 领域, D3 先验调用价值, D4 风险]。
 *
 * 它不是裁判，不参与：
 *   - 真假 / 证据等级
 *   - 撤回 / 审核
 *   - 动态调用价值（D3 之后只由事件账本更新）
 *
 * 工程约束：
 *   - 固定 rubric、固定 JSON、temperature=0
 *   - 按 contentHash + scorer 版本缓存，同一内容不重复花钱
 *   - 分数带版本与原始响应哈希，换模型必须重打
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getForestRoot } from './paths.js';
import { readConfig } from './config.js';
import { contentHash } from './content.js';
import { readSeed, writeSeed, listSeeds } from './seed.js';

export const SCORER_VERSION = 'trees-scorer/1';
const CACHE_FILE = 'scores.json';

const RUBRIC = [
  '你是知识向量打分器。只根据下面规则，对输入知识文本输出四个 0~1 的浮点数。',
  '严格 JSON，不要解释，不要代码围栏：{"d1":0,"d2":0,"d3":0,"d4":0}',
  '',
  'D1 抽象度：0 = 完整步骤/命令/配置/排错，照着能跑；1 = 纯公理/猜想/纯理论。',
  'D2 领域偏向：0 = 计算机/工程/数学/安全；1 = 人文/艺术/生活。',
  'D3 先验调用价值：只做初始预估，参考同类知识的需求热度；之后会被真实调用数据覆盖。',
  'D4 风险：0 = 无害；0.5 = 渗透原理但无可用 EXP；0.8 = 完整可复现攻击流程；1 = 制毒/爆炸/勒索等完整实操。',
].join('\n');

export function scorerPrompt(text) {
  return `${RUBRIC}\n\n## 知识文本\n${String(text || '').slice(0, 8000)}`;
}

export function parseScore(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('scorer 没有返回 JSON');
  const obj = JSON.parse(raw.slice(start, end + 1));
  const clamp = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
  };
  return {
    d1: clamp(obj.d1, 0.5),
    d2: clamp(obj.d2, 0.5),
    d3: clamp(obj.d3, 0.3),
    d4: clamp(obj.d4, 0.1),
  };
}

export async function getScorerConfig(env = process.env) {
  const cfg = await readConfig();
  const s = cfg.scorer && typeof cfg.scorer === 'object' ? cfg.scorer : {};
  const merged = {
    baseUrl: env.TREES_SCORER_BASE_URL || s.baseUrl || cfg.baseUrl || '',
    apiKey: env.TREES_SCORER_API_KEY || (s.apiKeyEnv ? env[s.apiKeyEnv] : '') || s.apiKey || cfg.apiKey || '',
    model: env.TREES_SCORER_MODEL || s.model || cfg.model || '',
    timeoutMs: Number(s.timeoutMs) || Number(cfg.timeoutMs) || 60000,
  };
  return merged.baseUrl && merged.apiKey && merged.model ? merged : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cachePath() {
  return path.join(getForestRoot(), CACHE_FILE);
}

async function readCache() {
  try {
    const raw = JSON.parse(await readFile(cachePath(), 'utf8'));
    return raw && raw.entries && typeof raw.entries === 'object' ? raw : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

async function writeCache(cache) {
  await mkdir(getForestRoot(), { recursive: true });
  await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function defaultCallModel() {
  const cfg = await getScorerConfig();
  if (!cfg) {
    throw new Error('没有配置 scorer。运行：trees config --scorer-model <模型> [--scorer-base-url ... --scorer-api-key ...]');
  }
  const { chat } = await import('../llm/chat.js');
  return (messages, maxTokens) => chat({ messages, maxTokens, config: cfg, temperature: 0 });
}

/**
 * 给一段文本打分（带缓存）。
 * @param {string} text
 * @param {{callModel?:Function, force?:boolean, maxTokens?:number}} [opts]
 */
export async function scoreText(text, opts = {}) {
  const key = `${SCORER_VERSION}:${contentHash('', text)}`;
  const cache = await readCache();
  if (!opts.force && cache.entries[key]) return cache.entries[key];

  const callModel = opts.callModel || await defaultCallModel();
  const res = await callModel([{ role: 'user', content: scorerPrompt(text) }], opts.maxTokens ?? 800);
  const scores = parseScore(res.text);
  const entry = {
    ...scores,
    scorer: SCORER_VERSION,
    model: res.model || '',
    scored_at: new Date().toISOString(),
    raw_hash: sha256(String(res.text || '')),
  };
  cache.entries[key] = entry;
  await writeCache(cache);
  return entry;
}

/** 给查询计划器用的同一个管理模型。 */
export async function scorerCallModel() {
  return defaultCallModel();
}

/** 给一颗种子打分并写回。 */
export async function scoreSeed(seedId, opts = {}) {
  const seed = await readSeed(seedId);
  if (!seed) return null;
  const entry = await scoreText(`${seed.title}\n${seed.body}`, opts);
  const updated = await writeSeed({
    ...seed,
    vector: {
      d1: entry.d1,
      d2: entry.d2,
      d4: entry.d4,
      scorer: entry.scorer,
      scored_at: entry.scored_at,
    },
    call_value: entry.d3,
    call_value_updated: new Date().toISOString().slice(0, 10),
  });
  return { seed: updated, score: entry };
}

/** 给所有还没有向量的种子补分。 */
export async function scoreMissing(opts = {}) {
  const limit = Number(opts.limit) || 20;
  const seeds = (await listSeeds({})).filter((s) => !s.vector).slice(0, limit);
  const done = [];
  for (const seed of seeds) {
    done.push(await scoreSeed(seed.id, opts));
  }
  return done;
}
