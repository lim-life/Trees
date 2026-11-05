/**
 * 坐标牌（Coordinate plaque）—— 大树在目录里的一张「坐标牌」。
 *
 * 牌里没有任何自由文本，只有两类东西：
 *   1. 闭集字段（domain / artifact / size）—— 由固定关键词表推出，确定性
 *   2. 指针（refs）—— 指向种子正文的「判据」「不适用」段落
 *
 * 为什么用指针而不是摘录：摘录会漂移（种子改了、牌没改），
 * 而且「挑哪几条摘」本身就是摘要。存指针就没有副本，
 * 于是可以列出**全部**种子而不需要挑选 —— 压缩通道从结构上关死。
 *
 * 这个模块是纯函数：不读盘、不看时间、不随机、不联网、不调模型。
 * 不 import tree.js，避免循环依赖。
 */
import { parseSections } from './synthesize.js';

/** 牌上允许引用的段落。 */
export const SECTIONS = ['判据', '不适用'];

/** 领域闭集。顺序即平局时的优先级。 */
export const DOMAINS = [
  'software', 'web', 'hardware', 'design', 'data', 'writing', 'research', 'ops', 'other',
];

/** 产出物闭集。顺序即平局时的优先级。 */
export const ARTIFACTS = [
  'app', 'library', 'static-site', 'slides', 'document', 'dataset', 'prototype', 'service', 'other',
];

/** 规模闭集；unknown 只作兜底，buildIndex 从不产出。 */
export const SIZES = ['small', 'medium', 'large', 'unknown'];

/** curator_note 的来源。 */
export const CURATOR_SOURCES = ['human', 'model', 'migrated-plaque'];

/**
 * 关键词表。**改这张表等于全库迁移** —— 任何一棵树的 domain/artifact 都会变，
 * 逐字节重建测试会先报警。加词请按闭集分桶，不要新增桶。
 */
const DOMAIN_KEYWORDS = {
  // 不用单字「库」——它会命中「经验库」「词库」，把非软件的经验判成 software
  software: ['编程', '代码', '脚本', '命令行', 'cli', 'node', 'javascript', 'typescript', 'python', '编译', '算法', '测试', 'sdk',
    'yaml', 'frontmatter', '序列化', '解析器', 'llm', '推理模型', 'max_tokens', '经验库', '组件库', '数据库'],
  // 交互词归 web：序列帧、浮层、深链都是前端形态，不是设计稿
  web: ['前端', 'css', 'html', 'dom', '浏览器', '网页', '页面', 'react', 'vue', '响应式',
    '交互', '动画', '序列帧', '预加载', '加载页', '浮层', '深链', '键盘', '触摸', '拖动', '滚轮'],
  hardware: ['硬件', '嵌入式', 'arduino', '串口', '固件', 'pcb', '电路', '传感器', '单片机', '3d打印'],
  // 制造业的工业设计词要单独补：否则「注塑 / 分型面 / 止口」全掉进 other
  design: ['设计', '排版', '字体', '网格', '动效', '视觉', 'ui', 'ux', '建模', 'rhino', 'blender', '色彩',
    '注塑', '模具', '分型面', '止口', '拔模', '外壳', '工程图', '公差', '壁厚',
    'freecad', 'cad', '几何', '渲染', '倒角', '圆角', '装配', '开孔'],
  data: ['数据', '统计', '图表', 'csv', 'sql', '分析'],
  writing: ['写作', '文案', '报告', '论文', '说明', '文档'],
  research: ['调研', '检索', '文献', '资料', '实验'],
  // 运营类：自动化/hook 是工程流程；发品/报价/接单是电商运营（闭集里最接近 ops）
  ops: ['运维', '部署', '服务器', 'docker', 'git', 'windows', 'bat', '批处理', '备份', '运营',
    '自动化', 'hook', '日志', '可观测性', '文件收集', '目录遍历',
    '发品', '私域', '定价', '报价', '接单', '商品图', '转化', '平台规则'],
};

const ARTIFACT_KEYWORDS = {
  app: ['app', '应用', '小程序', '客户端'],
  // 不要用单字「包」——它会命中「包边」「包装」，把一个外壳判成库
  library: ['组件库', 'sdk', '依赖', 'npm包', '组件包'],
  'static-site': ['html', '网页', '页面', '静态', '演示页'],
  slides: ['ppt', '幻灯片', '演示', '汇报', 'deck'],
  document: ['文档', '报告', '手册', '说明书', 'md'],
  dataset: ['数据集', '表格', 'csv', '数据'],
  prototype: ['原型', 'demo', '样机', '模型', '建模', '外壳', '草稿'],
  service: ['服务', '接口', 'api', '后端'],
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sizeOf(count) {
  if (count >= 10) return 'large';
  if (count >= 4) return 'medium';
  return 'small';
}

/**
 * 每个词元对每个桶最多记一分，避免同一段标签反复命中同一个词把分数刷高。
 * @param {string[]} terms
 * @param {Record<string, string[]>} table
 * @returns {Map<string, number>}
 */
function countHits(terms, table) {
  const scores = new Map();
  for (const term of terms) {
    const text = term.toLowerCase();
    for (const [bucket, words] of Object.entries(table)) {
      if (words.some((word) => text.includes(word))) {
        scores.set(bucket, (scores.get(bucket) || 0) + 1);
      }
    }
  }
  return scores;
}

/** 取最高分；平局时按闭集声明顺序取靠前的；零命中返回 other。 */
function pickBucket(scores, order) {
  let best = '';
  let bestScore = 0;
  for (const bucket of order) {
    const score = scores.get(bucket) || 0;
    if (score > bestScore) {
      best = bucket;
      bestScore = score;
    }
  }
  return best || 'other';
}

/**
 * 领域分类：同一张表既给树用，也给种子用。
 * 种子的领域必须由代码算出来，不能由模型写 —— 它是分区的键，飘了整棵树都召回不到。
 * @param {string[]} terms 标签 / 类型等词元
 * @returns {string} DOMAINS 里的一个
 */
export function classifyDomain(terms) {
  return pickBucket(countHits(terms || [], DOMAIN_KEYWORDS), DOMAINS);
}

/** 从标签列表推领域。没有标签就是 other。 */
export function domainOfLabels(labels) {
  return classifyDomain((labels || []).map(String));
}

/**
 * 从树和它的种子构建坐标牌。纯函数，结果只取决于入参。
 *
 * @param {{type?:string, seeds?:string[]}} tree
 * @param {Array<{id:string, labels?:string[]}>} seeds 该树的种子（可含多余项，按 tree.seeds 取）
 * @returns {{domain:string, artifact:string, size:string, refs:Array<{seed:string, section:string}>}}
 */
export function buildIndex(tree, seeds) {
  if (!isRecord(tree)) throw new TypeError('大树必须是对象');

  const byId = new Map();
  for (const seed of seeds || []) {
    if (seed && typeof seed.id === 'string') byId.set(seed.id, seed);
  }

  const refs = [];
  const resolved = [];
  for (const id of tree.seeds || []) {
    const seed = byId.get(id);
    if (!seed) continue;
    resolved.push(seed);
    for (const section of SECTIONS) refs.push({ seed: id, section });
  }

  const terms = String(tree.type || '')
    .split(/[/、,，;；]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const seed of resolved) {
    for (const label of seed.labels || []) terms.push(String(label));
  }

  return {
    domain: classifyDomain(terms),
    artifact: pickBucket(countHits(terms, ARTIFACT_KEYWORDS), ARTIFACTS),
    size: sizeOf(resolved.length),
    refs,
  };
}

/**
 * 这棵树是否还没被验证过：没有任何一颗种子被浇过水。
 * 不落盘 —— 它是读的时候现算的，所以浇水会立刻反映在牌上。
 * @param {Array<{watered?:number}>} seeds
 * @returns {boolean}
 */
export function isProvisional(seeds) {
  return !(seeds || []).some((seed) => Number(seed?.watered) > 0);
}

/**
 * 把盘上读到的东西修成合法形状。**不抛错**：
 * 坐标牌是可重建的视图，一个坏字段不该让整棵树读不出来。
 *
 * @param {*} rawIndex frontmatter 里的 index 段
 * @param {*} rawRefs frontmatter 里的 index_refs 段
 * @returns {{domain:string, artifact:string, size:string, refs:Array}|null}
 */
export function sanitizeIndex(rawIndex, rawRefs) {
  const refs = [];
  const seen = new Set();
  for (const ref of Array.isArray(rawRefs) ? rawRefs : []) {
    if (!isRecord(ref)) continue;
    const seed = typeof ref.seed === 'string' ? ref.seed : '';
    if (!/^seed-\d{4,}$/.test(seed)) continue;
    if (!SECTIONS.includes(ref.section)) continue;
    const key = `${seed}#${ref.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ seed, section: ref.section });
  }

  if (!isRecord(rawIndex)) {
    return refs.length
      ? { domain: 'other', artifact: 'other', size: 'unknown', refs }
      : null;
  }

  return {
    domain: DOMAINS.includes(rawIndex.domain) ? rawIndex.domain : 'other',
    artifact: ARTIFACTS.includes(rawIndex.artifact) ? rawIndex.artifact : 'other',
    size: SIZES.includes(rawIndex.size) ? rawIndex.size : 'unknown',
    refs,
  };
}

/**
 * 把指针解析成正文。种子正文是**现在**读的，所以种子改了不需要重建牌。
 *
 * @param {{refs?:Array<{seed:string, section:string}>}|null} index
 * @param {Array<{id:string, body?:string}>} seeds
 * @returns {{items:Array, missingCount:number, emptyCount:number}}
 */
export function resolveIndex(index, seeds) {
  const byId = new Map();
  for (const seed of seeds || []) {
    if (seed && typeof seed.id === 'string') byId.set(seed.id, seed);
  }

  const parsed = new Map();
  const items = [];
  let missingCount = 0;
  let emptyCount = 0;

  for (const ref of index?.refs || []) {
    const seed = byId.get(ref.seed);
    if (!seed) {
      missingCount += 1;
      items.push({ ...ref, text: '', missing: true, empty: true });
      continue;
    }

    let sections = parsed.get(ref.seed);
    if (!sections) {
      sections = parseSections(seed.body || '');
      parsed.set(ref.seed, sections);
    }

    const text = String(sections[ref.section] || '').trim();
    if (!text) emptyCount += 1;
    items.push({ ...ref, text, missing: false, empty: !text });
  }

  return { items, missingCount, emptyCount };
}

/** 正文压成一行并截断，只用于展示，不回写。 */
function oneLine(text, maxChars) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * 目录里的一行。不复制正文，只在渲染时把指针展开。
 *
 * @param {{domain:string, artifact:string, size:string, refs:Array}|null} index
 * @param {Array} seeds
 * @param {{maxRefs?:number, maxChars?:number, fallback?:string}} [opts]
 * @returns {string}
 */
export function summarizeIndex(index, seeds, opts = {}) {
  const maxRefs = opts.maxRefs ?? 4;
  const maxChars = opts.maxChars ?? 48;
  const fallback = opts.fallback ?? '';

  if (!index) return fallback;

  const { items, missingCount } = resolveIndex(index, seeds);
  const parts = [`${index.domain}/${index.artifact}/${index.size}`];

  const shown = items
    .filter((item) => !item.missing && !item.empty)
    .slice(0, maxRefs)
    .map((item) => `${item.seed}「${oneLine(item.text, maxChars)}」`);
  if (shown.length) parts.push(shown.join(' · '));
  if (missingCount) parts.push(`（引用失效 ${missingCount} 条）`);

  return parts.join(' ');
}

/**
 * `trees tree` / `trees plaque` 里展开的完整坐标牌。
 * @param {{domain:string, artifact:string, size:string, refs:Array}|null} index
 * @param {Array} seeds
 * @param {{provisional?:boolean}} [opts]
 * @returns {string[]} 每一行
 */
export function renderIndexDetail(index, seeds, opts = {}) {
  if (!index) return ['坐标牌  （尚未生成，跑 trees reindex --all）'];

  const lines = [`坐标牌  ${index.domain} / ${index.artifact} / ${index.size}`];
  if (opts.provisional) lines.push('验证    尚未验证（还没有种子被浇过水）');

  const grouped = new Map();
  for (const item of resolveIndex(index, seeds).items) {
    if (!grouped.has(item.section)) grouped.set(item.section, []);
    grouped.get(item.section).push(item);
  }

  for (const section of SECTIONS) {
    const items = grouped.get(section) || [];
    if (!items.length) continue;
    lines.push('', `## ${section}`);
    for (const item of items) {
      if (item.missing) lines.push(`- ${item.seed}  （种子已不存在）`);
      else if (item.empty) lines.push(`- ${item.seed}  （这一段是空的）`);
      else lines.push(`- ${item.seed}  ${oneLine(item.text, 200)}`);
    }
  }

  return lines;
}
