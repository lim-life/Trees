/**
 * 把 dsh-trees 装进 DeepSeek Harness 的某个 profile。
 *
 * 做的事（全部可逆，改动前自动备份）：
 *   1. 复制插件包到 <profile>/node_modules/dsh-trees
 *   2. 在 <profile>/package.json 里登记依赖
 *   3. 在 <profile>/cordis.patch.yml 追加 loader row（幂等）
 *
 * 用法：
 *   node install.mjs [--profile desktop] [--dry-run]
 * 环境变量：DSH_HOME（默认 ~/.dsh）、TREES_HOME（默认仓库的 forest）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const profileArg = argv.indexOf('--profile');

const profile = profileArg >= 0 ? argv[profileArg + 1] : 'desktop';
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);
const treeCli = path.join(REPO, 'tools', 'bin', 'cli.js');
const treeHome = process.env.TREES_HOME || path.join(REPO, 'forest');

const slash = (p) => p.replace(/\\/g, '/');
const row = [
  '',
  '- id: trees',
  '  name: "dsh-trees"',
  '  config:',
  `    cli: "${slash(treeCli)}"`,
  `    home: "${slash(treeHome)}"`,
  '    limit: 3',
  '    budget: 700',
  '',
].join('\n');

function main() {
  if (!existsSync(profileDir)) {
    console.error(`找不到 DSH profile：${profileDir}`);
    console.error('先用 DSH 启动过一次该 profile，或用 --profile 指定正确名字。');
    process.exit(2);
  }
  if (!existsSync(treeCli)) {
    console.error(`找不到 Trees CLI：${treeCli}`);
    process.exit(2);
  }

  const pkgPath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const destDir = path.join(profileDir, 'node_modules', 'dsh-trees');

  console.log(`profile : ${profileDir}`);
  console.log(`plugin  : ${HERE} → ${destDir}`);
  console.log(`trees   : ${treeCli}`);
  console.log(`forest  : ${treeHome}`);

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['dsh-trees'] = `file:${slash(HERE)}`;

  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const hasRow = /^\s*-\s*id:\s*trees\s*$/m.test(patch);

  if (dryRun) {
    console.log('\n[dry-run] 会做：');
    console.log(`  - 复制插件到 ${destDir}`);
    console.log('  - package.json 增加依赖 dsh-trees');
    console.log(hasRow ? '  - cordis.patch.yml 已有 id: trees，跳过' : '  - cordis.patch.yml 追加 id: trees');
    return;
  }

  const backupDir = path.join(profileDir, `_backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(pkgPath, path.join(backupDir, 'package.json'));
  if (existsSync(patchPath)) copyFileSync(patchPath, path.join(backupDir, 'cordis.patch.yml'));

  mkdirSync(path.dirname(destDir), { recursive: true });
  cpSync(HERE, destDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.endsWith('install.mjs'),
  });
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  if (!hasRow) writeFileSync(patchPath, `${patch}${patch.endsWith('\n') ? '' : '\n'}${row}`, 'utf8');

  console.log('\n✅ 装好了');
  console.log('   备份：' + backupDir);
  console.log('   重启 DeepSeek Harness 生效；之后每次会话：');
  console.log('   - 每条用户消息第一步自动召回（结果注入上下文）');
  console.log('   - 会话结束自动记录成会话树（不播种）');
  console.log('   日志：~/.trees/dsh-plugin.log');
}

main();
