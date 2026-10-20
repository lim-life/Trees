/**
 * 会话回写（Session write-back）—— 会话结束时只记录，不播种。
 *
 * 一个长项目会跨很多会话。每个会话结束时做三件事：
 *   1. 总结这次做了什么、留下未完成事项
 *   2. 判断项目是否完成
 *   3. 生成一个会话树（钥匙 s-XXXXXXXX），指向上一个会话
 *
 * **不提取种子。** 播种只发生在项目完成、会话链合并成项目大树的时候。
 * 会话树是原料，项目大树是结果；没完成的项目不该往经验库里放东西。
 *
 * 三条边界：
 *   - 默认关闭，每次回写会调一次模型（只做总结和判断，成本很小）。
 *   - 一个会话一个节点；重复触发只跳过已经存在的节点。
 *   - 会话文本发送前遮掉疑似密钥。
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTree, readTree } from './tree.js';
import { readConfig } from './config.js';
import {
  evaluateChain, finishProject, findLastKey, writeLastKey, clearLastKey,
} from './project.js';

/** 少于这么多字的会话不值得总结（寒暄、一句话任务）。 */
export const MIN_SESSION_CHARS = 600;
/** 最多喂给模型多少字。 */
export const MAX_SESSION_CHARS = 60000;

const KEY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 回写日志的位置。 */
export function autoLogPath() {
  return path.join(os.homedir(), '.trees', 'auto.log');
}

/** 把可能像密钥的片段遮掉 —— 会话文本要发给模型，别把 key 一起送出去。 */
function redact(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9_-]{16,}/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1***');
}

/**
 * 从 Claude Code 的 transcript（JSONL）里抽出对话文本。
 * 只保留用户和 AI 的文本；工具结果、系统注入一律丢弃。
 * @param {string} raw
 * @returns {string}
 */
export function extractTranscript(raw) {
  const parts = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const role = obj.type === 'user' ? '用户' : obj.type === 'assistant' ? 'AI' : null;
    if (!role) continue;

    const content = obj.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((x) => x && x.type === 'text')
        .map((x) => x.text || '')
        .join('\n');
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!text) continue;
    if (text.length > 20000) {
      text = `${text.slice(0, 2000)}\n…（中间省略）…\n${text.slice(-2000)}`;
    }
    parts.push(`${role}：${redact(text)}`);
  }
  return parts.join('\n\n');
}

function clipTail(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(-cap);
  const nl = cut.indexOf('\n\n');
  return nl >= 0 ? cut.slice(nl + 2) : cut;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成一把新钥匙，并确认库里没有撞号。 */
async function allocateKey() {
  for (let i = 0; i < 12; i++) {
    const bytes = randomBytes(8);
    let key = 's-';
    for (const b of bytes) key += KEY_ALPHABET[b % KEY_ALPHABET.length];
    if (!(await readTree(key))) return key;
  }
  throw new Error('钥匙连续撞号，请重试');
}

async function appendLog(line, file = autoLogPath()) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${stamp()}  ${line}\n`, 'utf8');
  } catch { /* 日志写不了就算了 */ }
}

/**
 * 读最近几行回写日志。
 * @param {number} [limit]
 * @param {string} [file]
 * @returns {Promise<string>}
 */
export async function readAutoLog(limit = 5, file = autoLogPath()) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.trim().split('\n').slice(-limit).join('\n');
  } catch {
    return '';
  }
}

/** 会话归档提示词。只总结和判断，不提取种子。 */
function sessionPrompt(material, source) {
  return [
    '你在给一个长项目的某一次会话做归档。这个项目可能还会继续。',
    '',
    '只做三件事：',
    '1. 用 3-6 句总结这次会话做了什么、关键决策、结果。',
    '2. 列出还没做完的具体事项（`open_threads`）。',
    '3. 判断项目是否完成。',
    '',
    '判据：',
    '- `project_status`: `complete` 仅当用户明确说完成/交付，或所有交付物都完成且没有未完成事项；',
    '  `ongoing` 表示还有没做完的事；拿不准写 `unknown`。',
    '- `explicit_complete`: 用户是否明确说了完成/交付（true / false）。',
    '- **会话结束本身不算完成** —— 可能只是没时间了、换任务了。',
    '',
    '**不要提取经验种子。** 项目完成时会从整条会话链统一提取。',
    '',
    '输出纯 JSON，不要代码围栏，不要任何解释：',
    '{"title":"一句话标题（≤20字）","summary":"3-6 句总结",'
    + '"project_status":"ongoing|complete|unknown","status_reason":"一句话依据",'
    + '"open_threads":["还没做完的事"],"explicit_complete":false}',
    '',
    `## 会话材料（来源：${source}）`,
    '',
    material,
  ].join('\n');
}

/** 从模型输出里抠 JSON。 */
function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型没返回 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 调模型总结一次会话。失败时抛错，由调用方决定是否降级。
 * @param {{material:string, source?:string, callModel?:Function, maxTokens?:number}} opts
 * @returns {Promise<object>}
 */
export async function summarizeSession(opts) {
  const callModel = opts.callModel ?? (async (messages, maxTokens) => {
    const { chat } = await import('../llm/chat.js');
    return chat({ messages, maxTokens });
  });
  const res = await callModel(
    [{ role: 'user', content: sessionPrompt(clipTail(opts.material, MAX_SESSION_CHARS), opts.source || '会话') }],
    opts.maxTokens ?? 2000,
  );
  const obj = parseJson(res.text);
  const status = ['complete', 'ongoing', 'unknown'].includes(obj.project_status)
    ? obj.project_status
    : 'unknown';
  return {
    title: String(obj.title || '').trim().slice(0, 40),
    summary: String(obj.summary || '').trim(),
    project_status: status,
    status_reason: String(obj.status_reason || '').trim(),
    open_threads: Array.isArray(obj.open_threads)
      ? obj.open_threads.map(String).map((x) => x.trim()).filter(Boolean)
      : [],
    explicit_complete: obj.explicit_complete === true,
    usage: res.usage ?? null,
  };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 跑一次会话回写：只记录，不播种；满足条件时（autoFinish）合并并首次播种。
 *
 * @param {{transcript?:string, material?:string, cwd?:string, fromKey?:string,
 *          config?:object, callModel?:Function, minChars?:number, maxChars?:number,
 *          dryRun?:boolean, force?:boolean, logPath?:string}} [opts]
 * @returns {Promise<object>}
 */
export async function runAuto(opts = {}) {
  const cfg = opts.config ?? await readConfig();
  if (!opts.force && cfg.autoPlant !== true) {
    return { skipped: '会话回写未开启（trees auto --enable）' };
  }
  if (!opts.material && !opts.transcript) return { skipped: '没有会话记录' };

  const cwd = path.resolve(opts.cwd || process.cwd());
  let parentKey = opts.fromKey ?? await findLastKey(cwd);
  if (parentKey) {
    const parent = await readTree(parentKey);
    if (!parent) parentKey = null;
  }

  let material = opts.material;
  if (material === undefined) {
    try {
      material = extractTranscript(await readFile(opts.transcript, 'utf8'));
    } catch (err) {
      return { skipped: `读不到会话记录：${err.message}` };
    }
  }

  const minChars = opts.minChars ?? MIN_SESSION_CHARS;
  const short = material.length < minChars;
  if (short && !parentKey) return { skipped: `对话太短（${material.length} 字）` };

  let summary = {
    title: '', summary: '', project_status: 'unknown', status_reason: '',
    open_threads: [], explicit_complete: false,
  };
  if (!short) {
    try {
      summary = await summarizeSession({
        material,
        source: opts.transcript || '会话',
        callModel: opts.callModel,
      });
    } catch (err) {
      if (!parentKey) return { skipped: `总结失败：${err.message}` };
      summary.status_reason = `总结失败：${err.message}`;
    }
  }

  const key = await allocateKey();
  const title = summary.title ? `${summary.title} · ${today()}` : `会话 · ${today()}`;
  const tree = await createTree({
    id: key,
    title,
    type: '会话',
    kind: 'session',
    root_path: cwd,
    continues_from: parentKey,
    project_status: summary.project_status,
    status_reason: summary.status_reason,
    open_threads: summary.open_threads,
    explicit_complete: summary.explicit_complete,
    body: [
      '## 本次做了什么',
      summary.summary || '（未总结）',
      '',
      '## 关键决策',
      '',
      '',
      '## 下一步',
      (summary.open_threads || []).map((x) => `- ${x}`).join('\n') || '（无）',
      '',
    ].join('\n'),
  });

  if (!opts.dryRun) await writeLastKey(cwd, key);
  await appendLog(
    `session ${opts.transcript ? path.basename(opts.transcript) : 'manual'} → ${key}`
    + `（${summary.project_status}${parentKey ? ` ← ${parentKey}` : ''}）`,
    opts.logPath,
  );

  const verdict = await evaluateChain(key);
  let mergedInto = null;
  if (!opts.dryRun && verdict.ready && cfg.autoFinish === true) {
    try {
      const project = await finishProject(key, {
        fromBranch: cfg.model || '',
        callModel: opts.callModel,
      });
      mergedInto = project.id;
      await clearLastKey(cwd);
      await appendLog(`session ${key} → 合并 ${project.id}，播种 ${project.seeds} 颗`, opts.logPath);
    } catch (err) {
      await appendLog(`session ${key} 合并失败：${err.message}`, opts.logPath);
    }
  }

  return {
    key,
    treeId: tree.id,
    projectStatus: summary.project_status,
    openThreads: summary.open_threads,
    mergedInto,
    finish: verdict,
    short,
    dryRun: Boolean(opts.dryRun),
  };
}
