/**
 * 闸门（Firewall）—— 入库前的程序化检查。
 *
 * 判断「这条算不算经验」是语义活，只能交给模型。但模型会顺着上下文写漂亮话，
 * 接进来的第三方 AI 更可能往里灌垃圾。所以规矩不能靠自觉，要靠代码：
 *
 *   **AI 负责判断，代码负责否决。**
 *
 * 这里只做确定性检查，不调模型、不看心情：
 *   1. 三段齐全         判据 / 做法 / 不适用，缺一段就不是种子
 *   2. 边界不是空话      「不适用」太短或写着"无""视情况而定" —— 等于没写
 *   3. 单段不过长        防止把整份文档塞成一颗种子
 *   4. 有人署名          必须能追到是哪个 AI 写的；匿名的经验不可审计
 *
 * 被拒的种子**不删除**，进 `forest/quarantine/`，理由写清楚，人可复核后放行。
 * 拦错一次只是多一步；放错一次，库里就永久多一条假经验。
 */
import { readFile, writeFile, mkdir, readdir, unlink, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getForestRoot } from './paths.js';
import { parseSections } from './synthesize.js';

/** 规则版本；改规则必须升级，便于区分历史判定。 */
export const GATE_VERSION = 'trees-gate/1';

/** 硬阈值。改这里等于改全库的入库标准。 */
export const LIMITS = {
  minBoundaryChars: 12,
  maxSectionChars: 3000,
  maxTitleChars: 80,
};

/** 「不适用」写成这些等于没写边界。 */
const VAGUE_BOUNDARY = [
  /^\s*无\s*$/,
  /视情况(而)?定/,
  /看情况/,
  /没有(什么)?限制/,
  /都(适用|可以|行)/,
  /无特殊/,
  /^[-—－\s]+$/,
  /^n\/?a$/i,
  /^none$/i,
];

/**
 * 判据里的「具体线索」。命中任意一条才算说清楚了什么情况下用它。
 * 只作 warning，不拦 —— 它容易误伤，又不该单独决定生死。
 */
const ANCHORS = [
  /`[^`]+`/,               // 行内代码
  /\.[a-z0-9]{1,6}\b/i,    // 扩展名 / 域名
  /[\\/][\w.\-]+/,         // 路径
  /\d/,                    // 数字、版本、阈值
  /[「『"]/,               // 引用的原文
];

const SECTION_NAMES = ['判据', '做法', '不适用'];

function text(value) {
  return String(value ?? '').trim();
}

function quarantineDir() {
  return path.join(getForestRoot(), 'quarantine');
}

function rejectLogPath() {
  return path.join(getForestRoot(), 'rejects.log');
}

/**
 * 检查一条待入库的种子。
 *
 * @param {{title?:string, criteria?:string, method?:string, notApplicable?:string,
 *          branch?:string, labels?:string[]}} candidate
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>, warnings:Array}}
 */
export function inspect(candidate) {
  const title = text(candidate.title);
  const criteria = text(candidate.criteria);
  const method = text(candidate.method);
  const boundary = text(candidate.notApplicable);
  const branch = text(candidate.branch);

  const errors = [];
  const warnings = [];

  // 1. 三段齐全
  const missing = [];
  if (!title) missing.push('标题');
  if (!criteria) missing.push('判据');
  if (!method) missing.push('做法');
  if (!boundary) missing.push('不适用');
  if (missing.length) {
    errors.push({ code: 'missing-section', message: `缺：${missing.join(' / ')}` });
  }

  // 2. 边界不是空话
  if (boundary && boundary.length < LIMITS.minBoundaryChars) {
    errors.push({
      code: 'vague-boundary',
      message: `「不适用」只有 ${boundary.length} 字，至少 ${LIMITS.minBoundaryChars} 字，要写出具体环境或反例`,
    });
  } else if (boundary && VAGUE_BOUNDARY.some((re) => re.test(boundary))) {
    errors.push({ code: 'vague-boundary', message: `「不适用」是空话：${boundary.slice(0, 40)}` });
  }

  // 3. 长度
  for (const [name, value] of [['判据', criteria], ['做法', method], ['不适用', boundary]]) {
    if (value.length > LIMITS.maxSectionChars) {
      errors.push({
        code: 'too-long',
        message: `${name} ${value.length} 字，超过 ${LIMITS.maxSectionChars} —— 这不是一条经验，是一份文档`,
      });
    }
  }
  if (title.length > LIMITS.maxTitleChars) {
    warnings.push({ code: 'long-title', message: `标题 ${title.length} 字，偏长` });
  }

  // 4. 署名（谁写的必须可追）
  if (!branch) {
    errors.push({ code: 'anonymous', message: '没有署名（--branch / 配置里的模型名）—— 匿名的经验不可审计' });
  }

  // 软检查：判据说得具体吗
  if (criteria && !ANCHORS.some((re) => re.test(criteria))) {
    warnings.push({ code: 'no-anchor', message: '判据里没有任何具体线索（路径、命令、扩展名、数字、原文引用）' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 软提醒只留痕，不刷屏 —— 提醒不影响入库，看一次就够，下次未必一致。
 * 写进 `~/.trees/gate.log`；TREES_GATE_LOG 可改位置。
 * @param {Array<{title:string, warnings:Array<{code:string,message:string}>}>} items
 * @param {{tree?:string, branch?:string}} [ctx]
 */
export async function recordWarnings(items, ctx = {}) {
  if (!Array.isArray(items) || !items.length) return;
  const file = process.env.TREES_GATE_LOG || path.join(os.homedir(), '.trees', 'gate.log');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const lines = items.flatMap((item) =>
    (item.warnings || []).map((w) => `${stamp}\t${ctx.tree || ''}\t${ctx.branch || ''}\t${w.code}\t${item.title}`));
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
  } catch { /* 留痕失败不能拖垮播种 */ }
}

/**
 * 从一条已解析的种子（带 body）检查 —— 给 `trees gate <seed-id>` 用。
 * @param {{title:string, body?:string, from_branch?:string}} seed
 */
export function inspectSeed(seed) {
  const sections = parseSections(seed.body || '');
  return inspect({
    title: seed.title,
    criteria: sections.判据,
    method: sections.做法,
    notApplicable: sections.不适用,
    branch: seed.from_branch,
  });
}

/** 文件名里不能用的一律换掉，保持可读。 */
function safeName(value) {
  return String(value || 'seed').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60);
}

/**
 * 把被拒的种子放进隔离区，并把理由写进 rejects.log。**不删除**。
 *
 * @param {Array<{candidate:object, verdict:{errors:Array}}>} items
 * @param {{tree?:string, branch?:string}} [ctx]
 * @returns {Promise<Array<{file:string, title:string, errors:Array}>>}
 */
export async function quarantine(items, ctx = {}) {
  if (!items.length) return [];
  const dir = quarantineDir();
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const saved = [];
  const logLines = [];

  for (const [index, item] of items.entries()) {
    const { candidate, verdict } = item;
    const id = `q-${stamp}-${index + 1}`;
    const file = path.join(dir, `${id}-${safeName(candidate.title)}.md`);
    const reasons = verdict.errors.map((e) => `- [${e.code}] ${e.message}`).join('\n');
    const content = [
      '---',
      `id: "${id}"`,
      `title: "${String(candidate.title || '').replace(/"/g, '\\"')}"`,
      `gate: "${GATE_VERSION}"`,
      `tree: "${ctx.tree || ''}"`,
      `branch: "${ctx.branch || ''}"`,
      `at: "${new Date().toISOString()}"`,
      '---',
      '',
      '## 被拦下的理由',
      reasons,
      '',
      '## 判据',
      candidate.criteria || '',
      '',
      '## 做法',
      candidate.method || '',
      '',
      '## 不适用',
      candidate.notApplicable || '',
      '',
    ].join('\n');

    await writeFile(file, content, 'utf8');
    saved.push({ file, title: candidate.title, errors: verdict.errors });
    logLines.push(`${new Date().toISOString()}  ${id}  ${candidate.title || '(无标题)'}  ${verdict.errors.map((e) => e.code).join(',')}`);
  }

  const logFile = rejectLogPath();
  let existing = '';
  try { existing = await readFile(logFile, 'utf8'); } catch { /* 第一次 */ }
  await writeFile(logFile, `${existing}${logLines.join('\n')}\n`, 'utf8');

  return saved;
}

/**
 * 列出隔离区。
 * @returns {Promise<Array<{file:string, id:string, title:string, reasons:string}>>}
 */
export async function listQuarantine() {
  const dir = quarantineDir();
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    const raw = await readFile(file, 'utf8').catch(() => '');
    const reasonBlock = raw.split('## 被拦下的理由')[1] || '';
    out.push({
      file,
      id: name.replace(/\.md$/, ''),
      title: (raw.match(/^title: "(.*)"$/m) || [])[1] || name,
      reasons: reasonBlock.split('## ')[0].trim(),
    });
  }
  return out;
}

/** 放行：把隔离区里的一条读回来交给调用方，文件移到 accepted/ 留档。 */
export async function acceptQuarantine(file) {
  const raw = await readFile(file, 'utf8');
  const body = raw.split(/\n---\n/)[1] || '';
  const sections = parseSections(body);
  const title = (raw.match(/^title: "(.*)"$/m) || [])[1] || '';
  const branch = (raw.match(/^branch: "(.*)"$/m) || [])[1] || '';

  const doneDir = path.join(quarantineDir(), 'accepted');
  await mkdir(doneDir, { recursive: true });
  await unlink(file).catch(() => undefined);
  await writeFile(path.join(doneDir, path.basename(file)), raw, 'utf8');

  return {
    title,
    branch,
    criteria: sections.判据,
    method: sections.做法,
    notApplicable: sections.不适用,
  };
}
