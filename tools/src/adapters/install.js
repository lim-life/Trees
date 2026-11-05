/**
 * 把 Trees 挂到各个宿主上（Cursor / Cline / Claude Code / Codex / Gemini）。
 *
 * 原则：
 *   - **只碰自己那一项**（`mcpServers.trees`），不重写别人的配置
 *   - 写之前先读、先合并；写的时候 tmp + rename
 *   - 宿主没装（目录不存在）就明说，不硬造目录
 *   - `--show` 永远能看，什么都不写
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 各宿主把 MCP 配置放在哪。 */
export const HOSTS = {
  cursor: {
    label: 'Cursor',
    kind: 'json',
    file: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    hint: 'Cursor → Settings → MCP，或直接看 ~/.cursor/mcp.json',
  },
  cline: {
    label: 'Cline (VS Code)',
    kind: 'json',
    file: () => {
      const base = process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User')
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
          : path.join(os.homedir(), '.config', 'Code', 'User');
      return path.join(base, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    },
    hint: 'Cline → MCP Servers → Installed，或编辑上面的 json',
  },
  gemini: {
    label: 'Gemini CLI',
    kind: 'json',
    file: () => path.join(os.homedir(), '.gemini', 'settings.json'),
    hint: 'Gemini CLI 读 ~/.gemini/settings.json 的 mcpServers',
  },
  codex: {
    label: 'Codex CLI',
    kind: 'toml',
    file: () => path.join(os.homedir(), '.codex', 'config.toml'),
    hint: 'Codex 读 ~/.codex/config.toml 的 [mcp_servers.trees]',
  },
  claude: {
    label: 'Claude Code',
    kind: 'command',
    command: (cliPath, nodePath) => ({
      cmd: 'claude',
      args: ['mcp', 'add', 'trees', '-s', 'user', '--', nodePath, cliPath, 'mcp'],
    }),
    hint: '等价于手动跑：claude mcp add trees -s user -- node <cli.js> mcp',
  },
};

/**
 * 算出要写什么，不碰磁盘。
 * @param {string} host
 * @param {{cliPath:string, nodePath?:string}} opts
 * @returns {{host:string, kind:string, file?:string, snippet?:string, command?:object, hint?:string}}
 */
export function buildPlan(host, opts) {
  const entry = HOSTS[host];
  if (!entry) throw new Error(`不认识的宿主：${host}（可选：${Object.keys(HOSTS).join(' / ')}）`);
  const nodePath = opts.nodePath || process.execPath;
  const cliPath = opts.cliPath;
  if (!cliPath) throw new Error('缺少 cliPath');

  if (entry.kind === 'command') {
    return { host, kind: 'command', command: entry.command(cliPath, nodePath), hint: entry.hint };
  }

  const file = entry.file();
  if (entry.kind === 'toml') {
    return {
      host,
      kind: 'toml',
      file,
      snippet: [
        '',
        '[mcp_servers.trees]',
        `command = ${JSON.stringify(nodePath)}`,
        `args = [${JSON.stringify(cliPath)}, "mcp"]`,
        '',
      ].join('\n'),
      hint: entry.hint,
    };
  }

  return {
    host,
    kind: 'json',
    file,
    snippet: JSON.stringify({
      mcpServers: { trees: { command: nodePath, args: [cliPath, 'mcp'] } },
    }, null, 2),
    hint: entry.hint,
  };
}

/**
 * Windows 上 .cmd / .bat 不能直接被 spawn，要交给 cmd.exe。
 * @returns {{status:number|null, stdout?:string, stderr?:string, error?:Error}}
 */
function runCommand(cmd, args) {
  const opts = { encoding: 'utf8' };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return spawnSync('cmd.exe', ['/d', '/c', cmd, ...args], opts);
  }
  return spawnSync(cmd, args, opts);
}

async function readJson(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/**
 * 真装。
 * @param {string} host
 * @param {{cliPath:string, nodePath?:string}} opts
 * @returns {Promise<{ok:boolean, message:string, file?:string}>}
 */
export async function installHost(host, opts) {
  const plan = buildPlan(host, opts);

  if (plan.kind === 'command') {
    // Windows 上 npm 全局装的是 claude.cmd，而 .cmd 不能直接 spawn，得走 cmd.exe /c
    const candidates = process.platform === 'win32'
      ? [`${plan.command.cmd}.cmd`, plan.command.cmd]
      : [plan.command.cmd];
    const found = candidates.find((cmd) => !runCommand(cmd, ['--version']).error);
    if (!found) {
      return {
        ok: false,
        message: `没找到 ${plan.command.cmd} 命令。手动执行：\n  ${plan.command.cmd} ${plan.command.args.join(' ')}`,
      };
    }
    const run = runCommand(found, plan.command.args);
    return run.status === 0
      ? { ok: true, message: `已在 ${HOSTS[host].label} 里注册（用户级）` }
      : { ok: false, message: `注册失败：${(run.stderr || run.stdout || '').trim()}` };
  }

  // 宿主没装就明说，不硬造目录（免得在别人的机器上留下空文件夹）
  const dirExists = await stat(path.dirname(plan.file)).then((s) => s.isDirectory()).catch(() => false);
  if (!dirExists) {
    return { ok: false, message: `没找到 ${HOSTS[host].label} 的配置目录，可能没装：${path.dirname(plan.file)}\n手动把这段加到 ${plan.file}：\n${plan.snippet}` };
  }

  if (plan.kind === 'toml') {
    const current = await readFile(plan.file, 'utf8').catch(() => '');
    if (current.includes('[mcp_servers.trees]')) {
      return { ok: true, message: `已经配过了（${plan.file}）`, file: plan.file };
    }
    await writeAtomic(plan.file, `${current.replace(/\n*$/, '\n')}${plan.snippet}`);
    return { ok: true, message: `已写入 ${plan.file}`, file: plan.file };
  }

  const current = await readJson(plan.file);
  const next = {
    ...current,
    mcpServers: { ...(current.mcpServers || {}), trees: { command: opts.nodePath || process.execPath, args: [opts.cliPath, 'mcp'] } },
  };
  await writeAtomic(plan.file, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, message: `已写入 ${plan.file}`, file: plan.file };
}
