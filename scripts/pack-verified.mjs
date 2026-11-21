import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--out'), '用法：npm run pack:verified -- [--out 输出目录]');
const output = resolve(root, args[1] || 'dist');
try {
  assert.equal((await readdir(output)).length, 0, 'EEXIST: 输出目录必须为空，请选择空目录');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const npmCli = process.env.npm_execpath;
assert(npmCli && isAbsolute(npmCli), '请通过 npm run pack:verified 运行此命令');
const npm = (argv, cwd) => execFileSync(process.execPath, [npmCli, ...argv], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc') },
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = [
  'package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml',
  'install.ps1', 'enable.ps1', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'locale/zh.json', 'locale/en.json', 'icon.svg',
  'test/config.test.mjs', 'test/hub-fetch.test.mjs',
  'scripts/pack-verified.mjs',
];
const allowed = name => required.includes(name) || ['lib/', 'test/', 'locale/'].some(prefix => name.startsWith(prefix));
const tempParent = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempParent, 'dsh-hub-package-'));
try {
  await writeFile(join(scratch, 'npmrc'), '');
  const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.name, 'dsh-hub-status');
  assert.match(sourcePackage.version, /^[0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9_.-]+)?$/);
  assert.equal(Object.keys(sourcePackage.dependencies || {}).length, 0, '离线安装要求没有运行时依赖');
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root));
  const filename = sourcePackage.name + '-' + sourcePackage.version + '.tgz';
  assert.equal(packed.filename, filename);
  assert.equal(packed.name, sourcePackage.name);
  assert.equal(packed.version, sourcePackage.version);
  const archive = join(scratch, filename);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000 })
    .split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean);
  assert.equal(new Set(entries).size, entries.length, '压缩包中存在重复条目');
  const names = entries.map(entry => {
    assert(entry.startsWith('package/'), '压缩包的根目录不符合预期');
    const name = entry.slice('package/'.length);
    assert(!name.includes(String.fromCharCode(92)) && !name.split('/').some(p => p === '..' || p === '.' || p === ''), '压缩包内存在不安全的路径');
    assert(allowed(name), '压缩包中存在未允许的文件：' + name);
    return name;
  });
  for (const name of required) assert(names.includes(name), '压缩包缺少必需文件：' + name);
  assert.deepEqual([...names].sort(), packed.files.map(file => file.path).sort());
  const unpacked = join(scratch, 'unpacked');
  await mkdir(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked], { timeout: 30000 });
  const files = [];
  for (const name of names.sort()) {
    const source = join(root, name);
    assert((await lstat(source)).isFile(), '源码路径不是普通文件：' + name);
    const bytes = await readFile(source);
    assert.deepEqual(await readFile(join(unpacked, 'package', name)), bytes, '压缩包内容与源码不一致：' + name);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const name of ['install.ps1', 'enable.ps1']) {
    assert.equal((await readFile(join(unpacked, 'package', name))).subarray(0, 3).toString('hex'), 'efbbbf', name + ' 必须使用带 BOM 的 UTF-8 编码');
  }
  const clean = join(scratch, 'clean');
  await mkdir(clean);
  await writeFile(join(clean, 'package.json'), JSON.stringify({ name: 'package-smoke', version: '1.0.0', private: true }));
  // 仅在该隔离目录安装，不修改 DSH 配置，也不安装对等依赖包。
  npm(['install', '--prefix', clean, '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
    '--package-lock=false', archive], clean);
  const installed = join(clean, 'node_modules', sourcePackage.name);
  for (const file of files) {
    assert.equal(hash(await readFile(join(installed, file.path))), file.sha256, '安装后的文件内容不一致：' + file.path);
  }
  for (const name of ['lib/index.js', 'lib/client.js']) {
    execFileSync(process.execPath, ['--check', join(installed, name)], { timeout: 30000 });
  }
  const testOutput = execFileSync(process.execPath, [join(installed, 'test/config.test.mjs')], {
    cwd: clean, encoding: 'utf8', timeout: 30000,
  });
  assert.match(testOutput, /PASS/);
  const archiveBytes = await readFile(archive);
  const digest = hash(archiveBytes);
  const manifest = {
    name: sourcePackage.name, version: sourcePackage.version, filename, bytes: archiveBytes.length, sha256: digest,
    sourceRevision: process.env.GITHUB_SHA || null, sourceRef: process.env.GITHUB_REF || null, files,
  };
  await mkdir(output, { recursive: true });
  await copyFile(archive, join(output, filename), constants.COPYFILE_EXCL);
  await writeFile(join(output, filename + '.sha256'), digest + '  ' + filename + String.fromCharCode(10), { flag: 'wx' });
  await writeFile(join(output, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + String.fromCharCode(10), { flag: 'wx' });
  console.log(testOutput.trim());
  console.log('PASS  已打包 ' + files.length + ' 个文件，内容与源码一致；干净离线安装及安装后的配置回归检查通过');
  console.log(filename + '  SHA256=' + digest);
  console.log('候选包输出目录：' + output);
} finally {
  const actual = await realpath(scratch);
  assert.equal(dirname(actual), tempParent);
  assert(relative(tempParent, actual).startsWith('dsh-hub-package-') && !relative(tempParent, actual).includes(sep));
  await rm(actual, { recursive: true, force: true });
}
