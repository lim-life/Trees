/**
 * 合成（Synthesize）—— Trees 的核心机制：按需蒸馏。
 *
 * 两颗种子在**同一类情境下被反复用到**、而且**互补**时，可以把它们蒸馏成
 * 一颗更高级的种子。原件永不删除，只标记 `synthesized_into`，随时可以拆回去。
 *
 * 两条铁律贯穿本文件：
 *   1. **合成要人审** —— 所以这里只生成候选，真正的合成必须显式调用，绝不自动发生。
 *   2. **抽象不替代原始** —— 原件保留，`bloodline` 记下血统，`unsynthesize` 可回拆。
 *
 * 与「浇水」的分工（这个区别很重要）：
 *   浇水 = 在真实项目里用了，并且验证通过   ← 实践产生的证据
 *   合成 = 把若干条具体经验归纳成更抽象的   ← 认知产生的提炼
 *   所以合成**不增加**原件的 watered。资历只能靠真用过。
 *
 * 互补不是二元的 —— 见 `judgeComplementarity`。合起来更完整才叫强互补；
 * 合起来跟原来差不多（等价）没必要合；合起来会打架（互斥）绝对不许合。
 */
import { readSeed, writeSeed, createSeed, listSeeds, advanceState, deleteSeed } from './seed.js';

/** 允许参与合成的最低浇水次数。证据不够就不该蒸馏。 */
export const SYNTH_MIN_WATERED = 5;

/** 只共享这么多个标签，算低关联：只做邻接标记，不合成（SPEC 规则 3）。 */
export const ADJACENT_MAX_SHARED_LABELS = 1;

/** 互补的成色。 */
export const COMPLEMENT = {
  /** 串联：一颗是另一颗的前置 —— 先 A 才能 B，必须绑在一起。*/
  CHAIN: 'chain',
  /** 各补一块，合起来更完整 —— 1+1>2。*/
  STRONG: 'strong',
  /** 有补充，但不是新维度，合起来略强。*/
  PARTIAL: 'partial',
  /** 说的是一回事，合起来不增加信息。*/
  REDUNDANT: 'redundant',
  /** 同一情境下给出相反的做法，合起来会自相矛盾。*/
  CONFLICT: 'conflict',
  /** 只共享极少标签，按规则只做邻接标记。*/
  ADJACENT: 'adjacent',
  /** 看不出关系。*/
  NONE: 'none',
};

/** 补位强度下限：一方的边界落在另一方主场的比例。 */
const BULGE_MIN = 0.25;
/** 做法重合到这个比例，说明两边做的是同一件事（等价）。 */
const PROC_REDUNDANT = 0.5;
/** 判据重合到这个比例、做法却不一样，说明同一情境两种主张（互斥）。 */
const JUDGE_CONFLICT = 0.5;
/** 认为"做法不同"的上限。 */
const PROC_DISTINCT = 0.3;
/** 整体相似度（交集/并集）到这个比例，两边就是同一份东西 —— 等价。 */
const JACCARD_REDUNDANT = 0.6;
/** 并集至少要涨到这个倍数，才算"合起来更完整" —— 强互补的门槛。 */
const GAIN_MIN = 1.4;

/** 中文二元组的常见虚词，不参与匹配。 */
const CJK_STOP = new Set([
  '什么', '这个', '那个', '一个', '可以', '不是', '就是', '所以', '但是', '因为',
  '如果', '还有', '没有', '时候', '这样', '那样', '怎么', '为什', '么时', '的话',
  '而且', '或者', '以及', '这些', '那些', '我们', '你们', '他们', '自己', '已经',
]);

// ───────────────────────── 文本工具 ─────────────────────────

/**
 * 把一段文字切成可比较的词元。零依赖的做法：
 * 英文按单词切，中文按「二字组」切（不需要分词库）。
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/[A-Za-z0-9_./\\-]{2,}/g)) {
    out.add(m[0].toLowerCase());
  }
  const runs = s.match(/[一-鿿]+/g) || [];
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!CJK_STOP.has(bg)) out.add(bg);
    }
  }
  return out;
}

/**
 * 把种子正文按 `## 标题` 拆成段落。
 * @param {string} body
 * @returns {{判据:string, 做法:string, 不适用:string, 旁证:string, 其他:string}}
 */
export function parseSections(body) {
  const out = { 判据: '', 做法: '', 不适用: '', 旁证: '', 其他: '' };
  const text = String(body || '');
  const re = /^##\s*(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ name: m[1].trim(), bodyStart: m.index + m[0].length });
  }
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].bodyStart - (marks[i + 1].name.length + 3) : text.length;
    const chunk = text.slice(mk.bodyStart, end).trim();
    if (Object.prototype.hasOwnProperty.call(out, mk.name)) out[mk.name] = chunk;
    else out.其他 += `## ${mk.name}\n${chunk}\n`;
  });
  return out;
}

/**
 * 同时算交集和并集 —— 判定互补这两边都要看，缺一个就会误判。
 *
 * - `containment` 交集 / 较小者：小的那个被覆盖了多少。用来判「等价」。
 * - `jaccard`     交集 / 并集  ：整体相似度。越接近 1 越像同一件事。
 * - `gain`        并集 / 较大者：合起来比原来最大的那份多出多少。**这是"更完整"的直接度量。**
 *                 一方完全包含另一方时 gain = 1（合了等于没合）；
 *                 两边完全不重叠且一样大时 gain = 2（各占一块，合起来翻倍）。
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function compare(a, b) {
  const shared = [];
  for (const t of a) if (b.has(t)) shared.push(t);
  const unionSize = new Set([...a, ...b]).size;
  const minSize = Math.min(a.size, b.size);
  const maxSize = Math.max(a.size, b.size);
  return {
    shared,
    containment: minSize ? shared.length / minSize : 0,
    jaccard: unionSize ? shared.length / unionSize : 0,
    gain: maxSize ? unionSize / maxSize : 1,
  };
}

const round3 = (n) => Number(n.toFixed(3));

// ───────────────────────── 互补判据 ─────────────────────────

/**
 * 判断两颗种子之间是什么关系、互补到什么成色。
 *
 * 看四件事：
 * - **补位强度** `bulge`：A 的「不适用」落在 B 的「判据」里的比例（反向也看）。
 *   一方不灵的地方正是另一方的主场 —— 这是"合起来更完整"的核心信号。
 * - **做法重合** `procOverlap`：两边做的是不是同一件事。
 * - **判据重合** `judgeOverlap`：两边是不是用在同一个情境。
 * - **共享标签**：用来判低关联。
 *
 * 判定顺序（互斥 → 等价 → 强互补 → 部分互补 → 邻接），因为前两种是"不许合"，
 * 优先识别出来，别让它们混进可合成队列。
 *
 * @param {object} a
 * @param {object} b
 * @returns {{kind:string, score:number, advice:string, reason:string, evidence:string[], metrics:object}}
 */
export function judgeComplementarity(a, b) {
  const sa = parseSections(a.body);
  const sb = parseSections(b.body);
  const la = new Set(a.labels || []);
  const lb = new Set(b.labels || []);
  const sharedLabels = [...la].filter((x) => lb.has(x));

  // 交集视角：两边重合多少
  const fwd = compare(tokenize(sa.不适用), tokenize(sb.判据));
  const bwd = compare(tokenize(sb.不适用), tokenize(sa.判据));
  const bulge = Math.max(fwd.containment, bwd.containment);
  const proc = compare(tokenize(sa.做法), tokenize(sb.做法));
  const judge = compare(tokenize(sa.判据), tokenize(sb.判据));

  // 并集视角一：适用场景覆盖得多广 —— 这才是「合起来更完整」的直接度量。
  // 注意不是量全文 token：补位型的两颗种子本来就是互为镜像的
  // （A 的「不适用」正好是 B 的「判据」），全文并集大不了多少，
  // 真正变大的，是它们各自覆盖的情境。
  const contexts = compare(tokenize(sa.判据), tokenize(sb.判据));
  // 并集视角二：整颗种子合起来是不是同一份东西（判「等价」用）
  const whole = compare(
    tokenize([sa.判据, sa.做法, sa.不适用].join('\n')),
    tokenize([sb.判据, sb.做法, sb.不适用].join('\n')),
  );

  const metrics = {
    bulge: round3(bulge),
    processOverlap: round3(proc.containment),
    contextOverlap: round3(judge.containment),
    jaccard: round3(whole.jaccard),
    coverageGain: round3(contexts.gain),
    textGain: round3(whole.gain),
    sharedLabels,
  };
  const base = { score: 0, advice: '', reason: '', evidence: [], metrics };

  // ⓪ 前置关系：这是**人声明的事实**，不是猜出来的相似度，所以优先级最高。
  //    先 A 才能 B —— 两颗必须绑成一条流程。
  const aNeedsB = (a.requires || []).includes(b.id);
  const bNeedsA = (b.requires || []).includes(a.id);
  if (aNeedsB || bNeedsA) {
    const [before, after] = aNeedsB ? [b, a] : [a, b];
    return {
      ...base, kind: COMPLEMENT.CHAIN, score: 1, advice: '必须绑在一起',
      reason: `${after.id} 依赖 ${before.id} —— 先做 ${before.id} 才能做 ${after.id}，绑成一条流程`,
      evidence: [before.id],
    };
  }

  // ① 互斥：同一个情境，两种主张 —— 合起来会自相矛盾，最危险
  if (judge.containment >= JUDGE_CONFLICT && proc.containment < PROC_DISTINCT) {
    return {
      ...base, kind: COMPLEMENT.CONFLICT, score: judge.containment, advice: '别合成',
      reason: '两边用在同一个情境，却给了不一样的做法 —— 合起来会自相矛盾，先把谁对谁错搞清楚',
      evidence: judge.shared.slice(0, 8),
    };
  }

  // ② 等价：重合到几乎就是同一份东西，合起来并集不会变大
  if (whole.jaccard >= JACCARD_REDUNDANT
      || (proc.containment >= PROC_REDUNDANT && judge.containment >= PROC_REDUNDANT)) {
    return {
      ...base, kind: COMPLEMENT.REDUNDANT, score: whole.jaccard, advice: '没必要合成',
      reason: '两边几乎就是同一份内容 —— 合起来并集不会变大，白费力气',
      evidence: whole.shared.slice(0, 8),
    };
  }

  // ③ 强互补：一方边界正是另一方主场，做法不同，而且情境覆盖确实变宽
  if (bulge >= BULGE_MIN && proc.containment < PROC_DISTINCT
      && judge.containment < JUDGE_CONFLICT && contexts.gain >= GAIN_MIN) {
    return {
      ...base, kind: COMPLEMENT.STRONG, score: bulge, advice: '值得合成',
      reason: (fwd.containment >= bwd.containment
        ? `${a.id} 的边界正好是 ${b.id} 的主场`
        : `${b.id} 的边界正好是 ${a.id} 的主场`)
        + `，两边做法不同，合起来覆盖的场景多了 ${(contexts.gain - 1).toFixed(2)} 倍 —— 更完整`,
      evidence: (fwd.containment >= bwd.containment ? fwd : bwd).shared.slice(0, 8),
    };
  }

  // ④ 部分互补：有补充，但覆盖没宽出多少
  if (bulge >= BULGE_MIN || (sharedLabels.length >= 2 && proc.containment < PROC_DISTINCT)) {
    return {
      ...base, kind: COMPLEMENT.PARTIAL, score: Math.max(bulge, 0.2),
      advice: '可以合成，收益一般',
      reason: `有些重叠，也有些补充 —— 覆盖只宽了 ${(contexts.gain - 1).toFixed(2)} 倍，算不上新维度`,
      evidence: sharedLabels,
    };
  }

  // ⑤ 低关联：只标记，不合成
  if (sharedLabels.length > 0 && sharedLabels.length <= ADJACENT_MAX_SHARED_LABELS) {
    return {
      ...base, kind: COMPLEMENT.ADJACENT, advice: '只标记，不合成',
      reason: `只共享 ${sharedLabels.length} 个标签，按规则只做邻接标记`,
      evidence: sharedLabels,
    };
  }

  return { ...base, kind: COMPLEMENT.NONE, reason: '看不出关系' };
}

/** 这个成色能不能合成。 */
export function isSynthesizable(kind) {
  return kind === COMPLEMENT.CHAIN || kind === COMPLEMENT.STRONG || kind === COMPLEMENT.PARTIAL;
}

/**
 * 扫描全库，找出所有值得人看一眼的种子对，按成色分类。
 *
 * 只出候选，不做判定 —— 合成要人审。
 *
 * @param {{minWatered?:number, includeAdjacent?:boolean}} [opts]
 * @returns {Promise<Array<{a,b,aTitle,bTitle,kind,score,advice,reason,evidence,metrics}>>}
 */
export async function findCandidates(opts = {}) {
  const minWatered = opts.minWatered ?? SYNTH_MIN_WATERED;
  const includeAdjacent = opts.includeAdjacent !== false;

  const all = (await listSeeds({}))
    .filter((s) => !s.synthesized_into)
    .filter((s) => s.watered >= minWatered);

  const out = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const v = judgeComplementarity(all[i], all[j]);
      if (v.kind === COMPLEMENT.NONE) continue;
      if (v.kind === COMPLEMENT.ADJACENT && !includeAdjacent) continue;
      out.push({
        a: all[i].id, b: all[j].id,
        aTitle: all[i].title, bTitle: all[j].title,
        ...v,
      });
    }
  }
  const rank = {
    [COMPLEMENT.CHAIN]: 0, [COMPLEMENT.STRONG]: 1, [COMPLEMENT.PARTIAL]: 2,
    [COMPLEMENT.CONFLICT]: 3, [COMPLEMENT.REDUNDANT]: 4, [COMPLEMENT.ADJACENT]: 5,
  };
  return out.sort((x, y) => (rank[x.kind] - rank[y.kind]) || (y.score - x.score));
}

// ───────────────────────── 合成 / 回拆 ─────────────────────────

/** 把两颗种子的段落拼成一份待审草稿 —— 合成要人审，所以这只是草稿。 */
function draftBody(a, b) {
  const sa = parseSections(a.body);
  const sb = parseSections(b.body);
  const join = (x, y) => [x && `（来自 ${a.id}）${x}`, y && `（来自 ${b.id}）${y}`]
    .filter(Boolean).join('\n\n');
  return [
    '## 判据',
    join(sa.判据, sb.判据) || '（待补：什么时候该用）',
    '',
    '## 做法',
    join(sa.做法, sb.做法) || '（待补：怎么做）',
    '',
    '## 不适用',
    join(sa.不适用, sb.不适用) || '（待补：什么时候别用）',
    '',
    '## 旁证',
    `由 ${a.id}（${a.title}）与 ${b.id}（${b.title}）蒸馏而来，待补原始证据。`,
    '',
  ].join('\n');
}

/**
 * 把两颗种子合成一颗更高级的种子。**必须显式调用**，不会自动发生。
 *
 * 会先判互补成色：**互斥的直接拒绝**（`force: true` 可强行绕过）。
 * 新种子：
 *   - `state` 直接是 `advanced`（它生来就是抽象产物）
 *   - `bloodline` 记下两颗原料
 *   - `confidence` 取两者的**较小值** —— 抽象出来的东西，置信度不该高过它的原料
 *   - `labels` 取并集
 *   - `watered` / `failed` 都是 0：它是新种子，资历从零开始
 *
 * @param {string} idA
 * @param {string} idB
 * @param {{title?:string, body?:string, from_branch?:string, from_tree?:string, force?:boolean}} [opts]
 * @returns {Promise<object>} 新种子的完整对象
 */
export async function synthesizeSeed(idA, idB, opts = {}) {
  if (idA === idB) throw new Error('不能把一颗种子和自己合成');
  const a = await readSeed(idA);
  const b = await readSeed(idB);
  if (!a) throw new Error(`找不到种子：${idA}`);
  if (!b) throw new Error(`找不到种子：${idB}`);
  if (a.synthesized_into || b.synthesized_into) {
    throw new Error('这颗种子已经被合成过了，先 unsynthesize 再试');
  }
  if (a.watered < SYNTH_MIN_WATERED || b.watered < SYNTH_MIN_WATERED) {
    throw new Error(
      `证据还不够：两颗种子都至少要被用过 ${SYNTH_MIN_WATERED} 次才能蒸馏`
      + `（现在是 ${a.watered} / ${b.watered}）`
    );
  }

  const verdict = judgeComplementarity(a, b);
  if (verdict.kind === COMPLEMENT.CONFLICT && !opts.force) {
    throw new Error(`互斥，拒绝合成：${verdict.reason}`
      + `（确定要合成的话加 force，但不建议）`);
  }

  const labels = [...new Set([...(a.labels || []), ...(b.labels || [])])];
  const title = opts.title || `${a.title} × ${b.title}`;

  const seed = await createSeed({
    title,
    labels,
    body: opts.body || draftBody(a, b),
    state: 'advanced',
    watered: 0,
    failed: 0,
    from_tree: opts.from_tree ?? a.from_tree ?? '',
    from_branch: opts.from_branch ?? '',
    origin: 'native',
    confidence: Math.min(a.confidence ?? 1, b.confidence ?? 1),
    bloodline: [a.id, b.id],
  });

  for (const orig of [a, b]) {
    const updated = { ...orig, synthesized_into: seed.id };
    updated.state = await advanceState(updated);
    await writeSeed(updated);
  }

  seed.complement = verdict.kind;
  return seed;
}

/**
 * 把一颗被合成过的种子拆回来。原件立刻恢复可用；
 * 血统拆光了，那颗高级种子才被删除（它只是产物，本身没有实践经验）。
 *
 * @param {string} seedId 原件的 id
 * @returns {Promise<{restored:object, removed:string|null, remainingBloodline:string[]|null}>}
 */
export async function unsynthesize(seedId) {
  const orig = await readSeed(seedId);
  if (!orig) throw new Error(`找不到种子：${seedId}`);
  if (!orig.synthesized_into) throw new Error(`这颗种子没有被合成过：${seedId}`);

  const parentId = orig.synthesized_into;
  const parent = await readSeed(parentId);

  const restored = { ...orig, synthesized_into: null };
  await writeSeed(restored);

  let removed = null;
  let remainingBloodline = null;
  if (parent) {
    const rest = (parent.bloodline || []).filter((id) => id !== seedId);
    if (rest.length === 0) {
      await deleteSeed(parentId);
      removed = parentId;
    } else {
      await writeSeed({ ...parent, bloodline: rest });
      remainingBloodline = rest;
    }
  }

  return { restored, removed, remainingBloodline };
}

/**
 * 查一颗种子的血统：它由哪些种子一路合成而来。
 *
 * @param {string} seedId
 * @returns {Promise<{seed:object, ancestors:object[], depth:number}>}
 */
export async function lineage(seedId) {
  const seed = await readSeed(seedId);
  if (!seed) throw new Error(`找不到种子：${seedId}`);

  const seen = new Set([seedId]);
  const ancestors = [];
  let frontier = [...(seed.bloodline || [])];
  let depth = 0;

  while (frontier.length) {
    depth++;
    const next = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = await readSeed(id);
      if (!s) continue;
      ancestors.push(s);
      next.push(...(s.bloodline || []));
    }
    frontier = next;
  }

  return { seed, ancestors, depth };
}

// ───────────────────────── 前置依赖（串联）─────────────────────────

/** `requires` 里长得像种子 id 的，就是指向一颗具体种子的前置。 */
const SEED_ID_RE = /^seed-\d{4,}$/;

/**
 * 一颗种子现在的前置哪些满足了、哪些还在等。
 *
 * `requires` 里指向已存在种子的算满足；其余（人写的描述）算悬空 —— 那就是在等它出现。
 *
 * @param {object} seed
 * @param {Set<string>} existingIds
 * @returns {{satisfied:string[], waiting:string[]}}
 */
export function inspectRequires(seed, existingIds) {
  const satisfied = [];
  const waiting = [];
  for (const r of seed.requires || []) {
    if (SEED_ID_RE.test(r) && existingIds.has(r)) satisfied.push(r);
    else waiting.push(r);
  }
  return { satisfied, waiting };
}

/**
 * 扫全库，列出所有「还在等前置」的种子。
 *
 * 等的东西可能是「先检测串口」这种还没播种的经验 —— 系统先把账记着，
 * 等它真出现的时候 findFulfillments 会提示。
 *
 * @returns {Promise<Array<{seed:object, waiting:string[], satisfied:string[]}>>}
 */
export async function findWaiting() {
  const all = (await listSeeds({})).filter((s) => !s.synthesized_into);
  const ids = new Set(all.map((s) => s.id));
  const out = [];
  for (const s of all) {
    const { satisfied, waiting } = inspectRequires(s, ids);
    if (waiting.length) out.push({ seed: s, waiting, satisfied });
  }
  return out;
}

/**
 * 这颗新种子，是不是谁在等的前置？
 *
 * 悬空项是人写的自由文字，只能靠词元重合近似匹配 —— 所以**结果要人确认**，
 * 命中不等于就是它。
 *
 * @param {object} seed
 * @returns {Promise<Array<{seed:object, wanted:string, score:number}>>}
 */
export async function findFulfillments(seed) {
  const waitingList = await findWaiting();
  const mine = tokenize(`${seed.title}
${(seed.labels || []).join(' ')}
${seed.body || ''}`);
  const out = [];
  for (const { seed: waiter, waiting } of waitingList) {
    if (waiter.id === seed.id) continue;
    for (const want of waiting) {
      const score = compare(tokenize(want), mine).containment;
      if (score >= 0.4) out.push({ seed: waiter, wanted: want, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * 给一颗种子登记一个前置。`before` 可以是已存在的种子 id，也可以是描述
 * （比如 "先检测串口"）—— 描述形式表示那东西还没出现，系统先记账。
 *
 * @param {string} seedId 谁需要前置
 * @param {string} before 前置：种子 id 或一段描述
 * @returns {Promise<object>} 更新后的种子
 */
export async function addRequire(seedId, before) {
  const seed = await readSeed(seedId);
  if (!seed) throw new Error(`找不到种子：${seedId}`);
  if ((seed.requires || []).includes(before)) return seed;
  return writeSeed({ ...seed, requires: [...(seed.requires || []), before] });
}
