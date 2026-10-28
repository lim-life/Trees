/**
 * 事件账本（Event Ledger）—— append-only + 哈希链的 `forest/events.jsonl`。
 *
 * 为什么需要它：`watered` 只是一个计数，回答不了
 * 「谁、在什么时候、因为什么验证了它」。而召回加权、证据阶梯、
 * 复用版税、撤回传播，全都依赖这条时间线。
 *
 * 链式设计（为以后上链留对照）：
 *   - 每条事件带 `seq`、`prev`（上一条的 hash）、`hash`（本条规范化后的 sha256）
 *   - 改任何一条，后面的 prev 全部对不上
 *   - 旧版无 hash 的行视为 legacy：新链的第一条以它的原始字节哈希作为 prev
 *   - 单机无共识；它只证明"本机历史未被篡改"，不证明"全网唯一"
 *
 * 约定：
 *   - 一行一个 JSON，只追加，不改写；
 *   - 写失败不阻断主流程（账本不能把播种/浇水搞崩）；
 *   - 读取时跳过坏行；verify 会指出坏在哪一行。
 *
 * @typedef {{seq:number, ts:string, type:string, prev:string|null, hash:string,
 *            actor?:string, seed?:string, tree?:string, title?:string,
 *            origin?:string, ok?:boolean, detail?:object}} TreeEvent
 */
import { appendFile, mkdir, readFile, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureDirs, getForestRoot } from './paths.js';

const LOCK_WAIT_MS = 5000;
const LOCK_STEP_MS = 50;

/** 账本文件位置。 */
export function eventsPath() {
  return path.join(getForestRoot(), 'events.jsonl');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 稳定序列化：键排序，保证换进程/换机器重算一致。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordHash(record) {
  const { hash: _hash, ...rest } = record;
  return sha256(canonical(rest));
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function readLines() {
  try {
    return (await readFile(eventsPath(), 'utf8')).split('\n').filter((line) => line.trim());
  } catch {
    return [];
  }
}

async function withLock(fn) {
  const dir = path.join(getForestRoot(), '.events.lock');
  const started = Date.now();
  let acquired = false;
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      await mkdir(dir);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await sleep(LOCK_STEP_MS);
    }
  }
  if (!acquired) throw new Error('events: 账本被另一个进程锁住（超过 5s）');
  try {
    return await fn();
  } finally {
    await rmdir(dir).catch(() => undefined);
  }
}

async function appendOne(type, fields) {
  await ensureDirs();
  return withLock(async () => {
    const lines = await readLines();
    const last = lines[lines.length - 1] || '';
    let prev = null;
    let seq = 1;
    if (last) {
      let lastEvent = null;
      try {
        lastEvent = JSON.parse(last);
      } catch {
        lastEvent = null;
      }
      prev = typeof lastEvent?.hash === 'string' && lastEvent.hash
        ? lastEvent.hash
        : sha256(last);
      seq = Number.isInteger(lastEvent?.seq) ? lastEvent.seq + 1 : lines.length + 1;
    }

    const body = {
      seq,
      ts: new Date().toISOString(),
      type: String(type || 'unknown'),
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      prev,
    };
    const record = { ...body, hash: recordHash(body) };
    await appendFile(eventsPath(), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  });
}

// 同进程内串行；跨进程靠目录锁
let queue = Promise.resolve();

/**
 * 追加一条事件。失败时静默返回记录（不影响主流程）。
 *
 * @param {string} type 事件类型，如 plant / water / fail / tree / box / summon / synthesize
 * @param {object} [fields] 事件字段；actor 建议传植树人身份
 * @returns {Promise<TreeEvent>}
 */
export function logEvent(type, fields = {}) {
  const run = queue.then(() => appendOne(type, fields));
  queue = run.then(() => undefined, () => undefined);
  return run.catch(() => ({
    seq: 0,
    ts: new Date().toISOString(),
    type: String(type || 'unknown'),
    ...fields,
    prev: null,
    hash: '',
  }));
}

/**
 * 读事件，按写入顺序返回最后 N 条。
 *
 * @param {{limit?:number, type?:string, seed?:string, tree?:string, actor?:string}} [opts]
 * @returns {Promise<TreeEvent[]>}
 */
export async function listEvents(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : 50;
  const out = [];
  for (const line of await readLines()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，不改写
    }
    if (opts.type && event.type !== opts.type) continue;
    if (opts.seed && event.seed !== opts.seed) continue;
    if (opts.tree && event.tree !== opts.tree) continue;
    if (opts.actor && event.actor !== opts.actor) continue;
    out.push(event);
  }
  return out.slice(-limit);
}

/**
 * 校验整条链。
 * @returns {Promise<{ok:boolean, count:number, chained:number, legacy:number,
 *                    head:string|null, brokenAt?:number, reason?:string}>}
 */
export async function verifyEvents() {
  const lines = await readLines();
  let prev = null;
  let chained = 0;
  let legacy = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, count: lines.length, chained, legacy, head: prev, brokenAt: i + 1, reason: '坏 JSON' };
    }

    if (typeof event.hash === 'string' && event.hash) {
      if (recordHash(event) !== event.hash) {
        return { ok: false, count: lines.length, chained, legacy, head: prev, brokenAt: i + 1, reason: 'hash 不匹配' };
      }
      if ((event.prev ?? null) !== prev) {
        return { ok: false, count: lines.length, chained, legacy, head: prev, brokenAt: i + 1, reason: 'prev 不连续' };
      }
      prev = event.hash;
      chained++;
    } else {
      prev = sha256(line);
      legacy++;
    }
  }

  return { ok: true, count: lines.length, chained, legacy, head: prev };
}
