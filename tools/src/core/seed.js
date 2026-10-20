/**
 * @file 种子模型（Seed）
 *
 * 种子是 Trees 中「经验」的最小单位：天生是一条**具体经验**，
 * 只有经过反复浇水（watered 达标）或被合成，才会沿状态机升级 —— 这就是「抽象延迟」。
 *
 * 存储约定：
 *   - 活跃种子：seeds/<id>.md
 *   - 入盒种子：box/<id>.md（state === 'boxed'）
 *   - 文件格式：YAML frontmatter + Markdown 正文（必须含 ## 判据 / ## 做法 / ## 不适用）
 *
 * 设计原则：
 *   - 原件永不因状态变化被删除：入盒/召唤都是「移动」，合成只写 synthesized_into / bloodline。
 *   - 空库友好：目录不存在或为空时，读类操作返回空值而不抛错。
 *   - 零依赖：仅使用 Node 标准库。
 *
 * 说明：按模块约定，所有导出函数均为 async；其中 advanceState / seedAge
 * 不做任何 I/O、不修改入参，语义上仍是纯函数，只是以 Promise 形式返回结果。
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { getPath, ensureDirs, listFiles } from './paths.js';
import { parse, stringify } from './frontmatter.js';

// ───────────────────────────── 常量 ─────────────────────────────

/** 合法状态（顺序即生长顺序，boxed 为旁路状态） */
const STATES = Object.freeze(['buried', 'sprouting', 'growing', 'advanced', 'boxed']);

/** 状态推进所需的最少浇水成功次数 */
const WATER_THRESHOLD = Object.freeze({
  sprouting: 1, // buried    → sprouting
  growing: 2, //   sprouting → growing
  advanced: 5, //  growing   → advanced
});

/** 距最后一次浇水超过该天数即入盒 */
export const BOX_AFTER_DAYS = 180;

/** 召唤时 prev_state 缺失的回退状态 */
const DEFAULT_SUMMON_STATE = 'growing';

/** id 格式：seed-XXXX（至少 4 位数字，超过 9999 自然扩位） */
const ID_RE = /^seed-(\d{4,})$/;
const ID_PAD = 4;

/** 合法来源 */
const ORIGINS = Object.freeze(['native', 'external']);

/** 不同来源的初始置信度 */
const DEFAULT_CONFIDENCE = Object.freeze({ native: 1.0, external: 0.5 });

/** 正文必备的三段标题（顺序即写入顺序） */
const SECTION_TITLES = Object.freeze(['判据', '做法', '不适用']);

/** frontmatter 字段的规范顺序（保证输出稳定、git diff 友好） */
const FIELD_ORDER = Object.freeze([
  'id',
  'title',
  'labels',
  'state',
  'prev_state',
  'watered',
  'failed',
  'born',
  'last_watered',
  'from_tree',
  'from_branch',
  'origin',
  'confidence',
  'bloodline',
  'synthesized_into',
  'requires',
  'evidence',
]);

/** createSeed 分配 id 的最大重试次数（多 AI 并行撞号时使用） */
const MAX_ID_ATTEMPTS = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEEDS = 'seeds';
const BOX = 'box';

/**
 * @typedef {'buried'|'sprouting'|'growing'|'advanced'|'boxed'} SeedState
 */

/**
 * @typedef {Object} Seed
 * @property {string} id                     全局唯一 id，格式 seed-XXXX
 * @property {string} title                  一句话标题
 * @property {string[]} labels               情境标签
 * @property {SeedState} state               当前状态
 * @property {SeedState|null} prev_state     入盒前的状态，召唤时恢复
 * @property {number} watered                浇水成功次数
 * @property {number} failed                 失败次数（只记录，不影响状态）
 * @property {string|null} born              播种日 YYYY-MM-DD
 * @property {string|null} last_watered      最后一次浇水日 YYYY-MM-DD
 * @property {string} from_tree              出自哪棵大树
 * @property {string} from_branch            出自哪个 AI 分支
 * @property {'native'|'external'} origin    来源
 * @property {number} confidence             置信度 0~1
 * @property {string[]} bloodline            合成来源 seed id
 * @property {string|null} synthesized_into  被合成进哪个 id
 * @property {string[]} requires             前置依赖：`seed-XXXX` 指向已存在的前置种子；
 *                                           其他文字表示「还没出现的前置」，比如 "先检测串口"
 * @property {string} evidence               原始证据指针
 * @property {string} body                   Markdown 正文
 */

/**
 * @typedef {Object} SeedSections
 * @property {string} [criteria]        ## 判据
 * @property {string} [method]          ## 做法
 * @property {string} [not_applicable]  ## 不适用
 */

/**
 * @typedef {Object} SeedFilter
 * @property {SeedState} [state]            按状态过滤
 * @property {string|string[]} [label]      按标签过滤（数组表示必须全部包含）
 * @property {string} [from_tree]           按来源大树过滤
 * @property {'native'|'external'} [origin] 按来源过滤
 */

// ───────────────────────────── 通用工具 ─────────────────────────────

/**
 * 判断错误是否为「文件/目录不存在」类。
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissing(err) {
  const code = /** @type {{code?: string}} */ (err)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 今天的本地日期字符串。
 * @returns {string} YYYY-MM-DD
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 把各种日期表示规整成 YYYY-MM-DD；无法识别返回 null。
 * YAML 解析器可能把日期解析成 Date（UTC 零点），因此 Date 取 UTC 分量。
 * @param {unknown} value
 * @returns {string|null}
 */
function toDateStr(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 回环校验，排除 2026-02-31 这类非法日期
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * YYYY-MM-DD → 自纪元起的整天数（按 UTC 计算，避免夏令时干扰）。
 * @param {string} dateStr
 * @returns {number}
 */
function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toStr(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 非负整数规整。
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 字符串数组规整：去空、去重、保序。
 * @param {unknown} value
 * @returns {string[]}
 */
function toStrList(value) {
  const list = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = toStr(item);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * @param {unknown} id
 * @returns {id is string}
 */
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * 从 id 取数字部分；非法 id 返回 NaN。
 * @param {string} id
 * @returns {number}
 */
function idNumber(id) {
  const m = ID_RE.exec(id);
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * 按数字序比较 id（seed-0009 < seed-0010）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareIds(a, b) {
  return idNumber(a) - idNumber(b);
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatId(n) {
  return `seed-${String(n).padStart(ID_PAD, '0')}`;
}

/**
 * 种子文件的绝对路径。
 * @param {'seeds'|'box'} kind
 * @param {string} id
 * @returns {string}
 */
function fileFor(kind, id) {
  return path.join(getPath(kind), `${id}.md`);
}

/**
 * 状态决定存放目录：boxed → box/，其余 → seeds/。
 * @param {SeedState} state
 * @returns {'seeds'|'box'}
 */
function kindOf(state) {
  return state === 'boxed' ? BOX : SEEDS;
}

// ───────────────────────────── 正文处理 ─────────────────────────────

/**
 * @param {string} title
 * @returns {RegExp}
 */
function sectionRe(title) {
  return new RegExp(`^##[ \\t]+${title}[ \\t]*$`, 'm');
}

/**
 * 由结构化段落生成正文。
 * @param {SeedSections} [sections]
 * @returns {string}
 */
function buildBody(sections = {}) {
  const values = [sections.criteria, sections.method, sections.not_applicable];
  return SECTION_TITLES.map((t, i) => `## ${t}\n\n${toStr(values[i])}`.trimEnd()).join('\n\n') + '\n';
}

/**
 * 确保正文包含三段必备标题；缺哪段补哪段（追加到末尾），已有内容原样保留。
 * @param {unknown} body
 * @returns {string}
 */
function ensureSections(body) {
  let out = typeof body === 'string' ? body.replace(/\s+$/, '') : '';
  for (const title of SECTION_TITLES) {
    if (!sectionRe(title).test(out)) {
      out += `${out ? '\n\n' : ''}## ${title}`;
    }
  }
  return out + '\n';
}

// ───────────────────────────── 规整与序列化 ─────────────────────────────

/**
 * @param {unknown} value
 * @returns {SeedState|null}
 */
function toState(value) {
  return STATES.includes(/** @type {string} */ (value)) ? /** @type {SeedState} */ (value) : null;
}

/**
 * 把任意来源的原始数据规整为完整 Seed 对象。
 * 未知字段原样保留（向前兼容其他模块扩展的字段）。
 *
 * @param {Record<string, any>} raw       原始字段
 * @param {string} id                     权威 id（读文件时以文件名为准）
 * @param {string} body                   正文
 * @param {string|null} fallbackDate      born 缺失时的默认日期（创建时为今天，读取时为 null）
 * @returns {Seed}
 */
function normalizeSeed(raw, id, body, fallbackDate) {
  const origin = ORIGINS.includes(raw.origin) ? raw.origin : 'native';

  let confidence = Number(raw.confidence);
  if (raw.confidence === null || raw.confidence === undefined || raw.confidence === '' || !Number.isFinite(confidence)) {
    confidence = DEFAULT_CONFIDENCE[origin];
  }
  confidence = Math.min(1, Math.max(0, confidence));

  const prev = toState(raw.prev_state);
  const born = toDateStr(raw.born) ?? fallbackDate;
  const synthesized = toStr(raw.synthesized_into);

  /** @type {Seed} */
  const seed = {
    id,
    title: toStr(raw.title),
    labels: toStrList(raw.labels),
    state: toState(raw.state) ?? 'buried',
    // prev_state 不允许是 boxed，否则召唤后仍在盒里
    prev_state: prev && prev !== 'boxed' ? prev : null,
    watered: toCount(raw.watered),
    failed: toCount(raw.failed),
    born,
    // last_watered 缺失时回退到 born（新种子视为播种当天浇过）
    last_watered: toDateStr(raw.last_watered) ?? born,
    from_tree: toStr(raw.from_tree),
    from_branch: toStr(raw.from_branch),
    origin,
    confidence,
    bloodline: toStrList(raw.bloodline),
    synthesized_into: synthesized || null,
    requires: toStrList(raw.requires),
    evidence: toStr(raw.evidence),
    body: typeof body === 'string' ? body : '',
  };

  // 保留未知扩展字段
  for (const [key, value] of Object.entries(raw)) {
    if (!FIELD_ORDER.includes(key) && key !== 'body' && key !== 'sections') {
      seed[key] = value;
    }
  }
  return seed;
}

/**
 * Seed → Markdown 文本（字段按规范顺序输出，扩展字段排在后面）。
 * @param {Seed} seed
 * @returns {string}
 */
function serialize(seed) {
  /** @type {Record<string, any>} */
  const data = {};
  for (const key of FIELD_ORDER) data[key] = seed[key];
  for (const [key, value] of Object.entries(seed)) {
    if (!FIELD_ORDER.includes(key) && key !== 'body') data[key] = value;
  }
  return stringify(data, ensureSections(seed.body));
}

// ───────────────────────────── 底层 I/O ─────────────────────────────

/**
 * 原子写：先写同目录临时文件再 rename，避免并发读者看到半截文件。
 * 临时文件以 "." 开头且不匹配 id 格式，不会被扫描为种子。
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function atomicWrite(file, text) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * 删除文件；不存在视为未删除。
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function removeIfExists(file) {
  try {
    await unlink(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * 列出某目录下合法的种子 id；目录不存在返回 []。
 * @param {'seeds'|'box'} kind
 * @returns {Promise<string[]>}
 */
async function listIdsIn(kind) {
  let names;
  try {
    names = await listFiles(kind);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return (Array.isArray(names) ? names : []).filter(isValidId);
}

/**
 * 扫描 seeds/ 与 box/ 中已占用的 id 数字。
 * @returns {Promise<Set<number>>}
 */
async function scanIdNumbers() {
  const [a, b] = await Promise.all([listIdsIn(SEEDS), listIdsIn(BOX)]);
  return new Set([...a, ...b].map(idNumber));
}

/**
 * 从指定目录读取单个种子；文件不存在返回 null，内容损坏抛错。
 * @param {'seeds'|'box'} kind
 * @param {string} id
 * @returns {Promise<Seed|null>}
 */
async function readFrom(kind, id) {
  const file = fileFor(kind, id);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  let parsed;
  try {
    parsed = parse(text);
  } catch (err) {
    throw new Error(`种子文件解析失败: ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const data = parsed && typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : {};
  // 文件名是 id 的权威来源，防止手工编辑导致 frontmatter 与文件名不一致
  return normalizeSeed(data, id, parsed?.content ?? '', null);
}

// ───────────────────────────── 状态机（纯逻辑） ─────────────────────────────

/**
 * 计算距最后一次浇水的天数（同步内部实现）。
 * @param {Partial<Seed>} seed
 * @returns {number}
 */
function computeAge(seed) {
  const ref = toDateStr(seed?.last_watered) ?? toDateStr(seed?.born);
  if (!ref) return 0;
  // 未来日期（时钟漂移/手工编辑）按 0 天处理
  return Math.max(0, dayNumber(todayStr()) - dayNumber(ref));
}

/**
 * 状态机核心（同步内部实现）。只看 watered、synthesized_into 与距 last_watered 的天数，
 * 不看 failed —— 失败只记录、不降级。
 * @param {Partial<Seed>} seed
 * @returns {SeedState}
 */
function computeNextState(seed) {
  const current = toState(seed?.state) ?? 'buried';

  // boxed 只能通过 summonSeed 离开，状态机自身不会把它放出来
  if (current === 'boxed') return 'boxed';

  // 任意状态：180 天未浇水 → 入盒（判据是 last_watered，不是 born）
  if (computeAge(seed) >= BOX_AFTER_DAYS) return 'boxed';

  const watered = toCount(seed?.watered);
  const synthesized = Boolean(toStr(seed?.synthesized_into));

  // 逐级推进：阈值单调递增，循环直到稳定，
  // 这样导入的高 watered 种子也能一次走到正确状态，但不会跳过任何一级的判据。
  let state = current;
  for (;;) {
    if (state === 'buried' && watered >= WATER_THRESHOLD.sprouting) {
      state = 'sprouting';
    } else if (state === 'sprouting' && watered >= WATER_THRESHOLD.growing) {
      state = 'growing';
    } else if (state === 'growing' && (watered >= WATER_THRESHOLD.advanced || synthesized)) {
      // 抽象延迟：只有攒够浇水或被合成进更高层种子，才升级为 advanced
      state = 'advanced';
    } else {
      return state;
    }
  }
}

/**
 * 应用新状态；进入 boxed 时记录 prev_state，保证可召唤回原状态。
 * @param {Seed} seed  会被就地修改（仅用于内部副本）
 * @param {SeedState} next
 * @returns {void}
 */
function applyState(seed, next) {
  if (next === 'boxed' && seed.state !== 'boxed') {
    seed.prev_state = seed.state;
  }
  seed.state = next;
}

// ───────────────────────────── 导出 API ─────────────────────────────

/**
 * 返回下一个可用 id（扫描 seeds/ 与 box/，取最大数字 +1）。空库返回 'seed-0001'。
 * @returns {Promise<string>} 如 'seed-0007'
 */
export async function nextId() {
  const used = await scanIdNumbers();
  let max = 0;
  for (const n of used) if (n > max) max = n;
  return formatId(max + 1);
}

/**
 * 创建并写入一颗新种子。
 *
 * - id 自动分配（传入的 fields.id 会被忽略）；写前重扫一次防撞号，
 *   并以排他方式（wx）写文件，多 AI 并行时撞号会自动换号重试。
 * - 缺失字段使用默认值；born / last_watered 默认今天；
 *   origin=external 时 confidence 默认 0.5。
 * - 正文可通过 `fields.body`（完整 Markdown）或 `fields.sections` 提供，
 *   缺失的必备段落会自动补齐标题。
 *
 * @param {Partial<Seed> & { sections?: SeedSections }} [fields={}]
 * @returns {Promise<Seed>} 已写入磁盘的完整种子
 */
export async function createSeed(fields = {}) {
  const input = fields && typeof fields === 'object' ? fields : {};
  await ensureDirs();

  const body = typeof input.body === 'string' && input.body.trim() ? input.body : buildBody(input.sections);
  const base = normalizeSeed({ ...input, id: undefined }, '', body, todayStr());
  if (base.state !== 'boxed') base.prev_state = null;

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = await nextId();
    const seed = { ...base, id };
    const text = serialize(seed);

    // 写前重扫：期间若有其他进程占用了该号，换号重来
    const used = await scanIdNumbers();
    if (used.has(idNumber(id))) continue;

    try {
      // wx：文件已存在则失败 —— 同一目录内的最后一道防撞号保险
      await writeFile(fileFor(kindOf(seed.state), id), text, { encoding: 'utf8', flag: 'wx' });
      return seed;
    } catch (err) {
      if (/** @type {{code?: string}} */ (err)?.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`createSeed: 连续 ${MAX_ID_ATTEMPTS} 次分配 id 冲突，请稍后重试`);
}

/**
 * 读取单个种子：先找 seeds/，再找 box/。
 * @param {string} id
 * @returns {Promise<Seed|null>} 不存在（或 id 非法）返回 null
 */
export async function readSeed(id) {
  if (!isValidId(id)) return null;
  return (await readFrom(SEEDS, id)) ?? (await readFrom(BOX, id));
}

/**
 * 写入种子。目录由 state 决定（boxed → box/，其余 → seeds/）。
 * 若种子原先在另一个目录，写入新位置后删除旧文件 —— 这是移动，不是复制。
 * 先写新、后删旧：中途崩溃最多留下重复文件（readSeed 以 seeds/ 为准），不会丢数据。
 *
 * @param {Seed} seed
 * @returns {Promise<Seed>} 规整后实际写入的种子
 * @throws {TypeError} id 或 state 非法时
 */
export async function writeSeed(seed) {
  if (!seed || typeof seed !== 'object') {
    throw new TypeError('writeSeed: seed 必须是对象');
  }
  if (!isValidId(seed.id)) {
    throw new TypeError(`writeSeed: 非法 id "${seed.id}"，应为 seed-XXXX`);
  }
  if (!toState(seed.state)) {
    throw new TypeError(`writeSeed: 非法 state "${seed.state}"，可选值: ${STATES.join(', ')}`);
  }

  const normalized = normalizeSeed(seed, seed.id, seed.body, null);
  const target = kindOf(normalized.state);
  const other = target === SEEDS ? BOX : SEEDS;

  await ensureDirs();
  await atomicWrite(fileFor(target, normalized.id), serialize(normalized));
  await removeIfExists(fileFor(other, normalized.id));
  return normalized;
}

/**
 * 列出种子（seeds/ 与 box/ 都扫描），按 id 数字升序。
 * 单个文件损坏时跳过并发出警告，不影响整体列表。
 *
 * @param {SeedFilter} [filter={}]
 * @returns {Promise<Seed[]>} 空库返回 []
 */
export async function listSeeds(filter = {}) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const [activeIds, boxIds] = await Promise.all([listIdsIn(SEEDS), listIdsIn(BOX)]);

  // 同一 id 同时存在于两个目录（移动中途崩溃）时，以 seeds/ 为准，与 readSeed 一致
  /** @type {Map<string, 'seeds'|'box'>} */
  const locations = new Map();
  for (const id of boxIds) locations.set(id, BOX);
  for (const id of activeIds) locations.set(id, SEEDS);

  const loaded = await Promise.all(
    [...locations].map(async ([id, kind]) => {
      try {
        return await readFrom(kind, id);
      } catch (err) {
        process.emitWarning(`跳过无法读取的种子 ${kind}/${id}.md: ${err instanceof Error ? err.message : String(err)}`, {
          code: 'TREES_SEED_UNREADABLE',
        });
        return null;
      }
    }),
  );

  const wantLabels = f.label === undefined || f.label === null ? [] : toStrList(f.label);

  return loaded
    .filter(/** @returns {s is Seed} */ (s) => s !== null)
    .filter((s) => (f.state ? s.state === f.state : true))
    .filter((s) => (f.origin ? s.origin === f.origin : true))
    .filter((s) => (f.from_tree !== undefined && f.from_tree !== null ? s.from_tree === toStr(f.from_tree) : true))
    .filter((s) => wantLabels.every((l) => s.labels.includes(l)))
    .sort((a, b) => compareIds(a.id, b.id));
}

/**
 * 删除种子文件（seeds/ 与 box/ 都查）。
 * 注意：这是显式的人工删除操作；状态变化与合成永远不会调用它（抽象不替代原始）。
 * @param {string} id
 * @returns {Promise<boolean>} 至少删除了一个文件返回 true
 */
export async function deleteSeed(id) {
  if (!isValidId(id)) return false;
  const results = await Promise.all([removeIfExists(fileFor(SEEDS, id)), removeIfExists(fileFor(BOX, id))]);
  return results.some(Boolean);
}

/**
 * 浇水。
 * - ok=true：watered+1，last_watered=今天，再按状态机推进
 * - ok=false：failed+1，不动 last_watered，不推进状态（失败不降级，只记录）
 *
 * boxed 种子浇水只累计次数、更新日期，仍留在盒中 —— 离开盒子只能走 summonSeed。
 * 注：读-改-写非原子，同一种子被并发浇水时后写者覆盖先写者。
 *
 * @param {string} id
 * @param {boolean} [ok=true]
 * @returns {Promise<Seed|null>} 更新后的种子；不存在返回 null
 */
export async function waterSeed(id, ok = true) {
  const seed = await readSeed(id);
  if (!seed) return null;

  const next = {
    ...seed,
    labels: [...seed.labels],
    bloodline: [...seed.bloodline],
    requires: [...seed.requires],
  };
  if (ok) {
    next.watered += 1;
    next.last_watered = todayStr();
    applyState(next, computeNextState(next));
  } else {
    next.failed += 1;
  }
  return writeSeed(next);
}

/**
 * 按状态机计算新状态（不修改入参、无 I/O）。
 * 判据：watered 次数、是否已被合成（synthesized_into）、距 last_watered 的天数；不看 failed。
 *
 * @param {Partial<Seed>} seed
 * @returns {Promise<SeedState>} 新状态；若返回 'boxed'，调用方应记录 prev_state（或直接使用 boxSeed）
 */
export async function advanceState(seed) {
  return computeNextState(seed);
}

/**
 * 距最后一次浇水的天数（整数，最小 0）。last_watered 缺失时回退用 born；都缺失返回 0。
 * @param {Partial<Seed>} seed
 * @returns {Promise<number>}
 */
export async function seedAge(seed) {
  return computeAge(seed);
}

/**
 * 入盒：记录当前状态到 prev_state，state 设为 boxed，文件移到 box/。
 * 已在盒中则原样返回（不覆盖 prev_state）。
 * @param {string} id
 * @returns {Promise<Seed|null>} 入盒后的种子；不存在返回 null
 */
export async function boxSeed(id) {
  const seed = await readSeed(id);
  if (!seed) return null;
  if (seed.state === 'boxed') return seed;

  const next = { ...seed };
  applyState(next, 'boxed');
  return writeSeed(next);
}

/**
 * 定期巡检：把「超过 BOX_AFTER_DAYS 天没浇水」却还留在活跃目录里的种子送进盒子。
 *
 * 状态机只在浇水/合成时推进，所以一颗再也没人碰的种子永远不会自己入盒 ——
 * 这个函数补上那条时间驱动的路径。纯写操作，dry-run 时不要调用。
 *
 * @param {{afterDays?:number}} [opts]
 * @returns {Promise<Seed[]>} 这次入盒的种子（含 prev_state）
 */
export async function sweepAging(opts = {}) {
  const afterDays = opts.afterDays ?? BOX_AFTER_DAYS;
  const boxed = [];
  for (const seed of await listSeeds({})) {
    if (seed.state === 'boxed') continue;
    if (computeAge(seed) < afterDays) continue;
    const next = await boxSeed(seed.id);
    if (next) boxed.push(next);
  }
  return boxed;
}

/**
 * 召唤：恢复 prev_state（缺失则为 growing），清空 prev_state，文件移回 seeds/。
 * 不在盒中则原样返回。
 *
 * 召唤不算浇水，因此不更新 last_watered；若召唤后长期不用，
 * 再次执行状态推进时仍会按 180 天规则重新入盒。
 *
 * @param {string} id
 * @returns {Promise<Seed|null>} 召唤后的种子；不存在返回 null
 */
export async function summonSeed(id) {
  const seed = await readSeed(id);
  if (!seed) return null;
  if (seed.state !== 'boxed') return seed;

  const restored = seed.prev_state && seed.prev_state !== 'boxed' ? seed.prev_state : DEFAULT_SUMMON_STATE;
  return writeSeed({ ...seed, state: restored, prev_state: null });
}
