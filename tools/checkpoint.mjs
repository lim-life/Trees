// Stop hook：按「时间/体积」阈值做会话检查点，不依赖 compaction。
// 达到阈值才：复制 transcript 快照 + 调 trees auto --force 种一颗会话树。
// 没达到就静默退出，零成本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.TREES_CLI || path.join(HERE, 'bin', 'cli.js');
const INTERVAL_MS = Number(process.env.TREES_CHECKPOINT_MS || 20 * 60 * 1000);
const MIN_BYTES = Number(process.env.TREES_CHECKPOINT_BYTES || 200000);
const STATE = path.join(os.homedir(), '.trees', 'checkpoint-state.json');
const SNAP_DIR = path.join(os.homedir(), '.trees', 'checkpoints');
const LOG = path.join(os.homedir(), '.trees', 'checkpoint.log');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()}\t${line}\n`, 'utf8');
  } catch { /* 日志失败不影响会话 */ }
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

function newestTranscript(cwd) {
  try {
    const abs = path.resolve(cwd);
    const slug = abs.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}-`).replace(/[\\/]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', slug);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let best = null;
    for (const f of files) {
      const file = path.join(dir, f);
      const s = fs.statSync(file);
      if (!best || s.mtimeMs > best.mtime) best = { file, mtime: s.mtimeMs };
    }
    return best?.file || '';
  } catch { return ''; }
}

const payload = readStdin() || {};
const cwd = payload.cwd || process.cwd();
let transcript = payload.transcript_path || '';
if (!transcript || !fs.existsSync(transcript)) transcript = newestTranscript(cwd);
if (!transcript || !fs.existsSync(transcript)) process.exit(0);

const size = fs.statSync(transcript).size;
const key = payload.session_id || path.basename(transcript, '.jsonl');
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { state = {}; }
const prev = state[key] || { at: 0, size: 0 };

const now = Date.now();
if (now - prev.at < INTERVAL_MS && size - prev.size < MIN_BYTES) process.exit(0);

// 1) 先存原始快照：即使后面模型总结失败，材料也还在
fs.mkdirSync(SNAP_DIR, { recursive: true });
const snap = path.join(SNAP_DIR, `${key}.latest.jsonl`);
try { fs.copyFileSync(transcript, snap); } catch (err) { log(`snapshot fail ${key}: ${err.message}`); process.exit(0); }

// 2) 再种会话树（模型总结失败会被 auto 跳过，但快照已保存）
const res = spawnSync(process.execPath, [CLI, 'auto', '--transcript', snap, '--force'], {
  encoding: 'utf8', timeout: 120000, windowsHide: true,
  env: { ...process.env },
});
const tail = String(res.stdout || res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`;
log(`checkpoint ${key} size=${size} → ${tail}`);

state[key] = { at: now, size, snapshot: snap };
try {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
} catch { /* 状态写不了下次会重复检查，不影响快照 */ }
