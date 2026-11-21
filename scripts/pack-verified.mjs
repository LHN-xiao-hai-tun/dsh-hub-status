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
assert(args.length === 0 || (args.length === 2 && args[0] === '--out'), 'Usage: npm run pack:verified -- [--out directory]');
const output = resolve(root, args[1] || 'dist');
try {
  assert.equal((await readdir(output)).length, 0, 'EEXIST: output directory must be empty');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const npmCli = process.env.npm_execpath;
assert(npmCli && isAbsolute(npmCli), 'Run this command through npm run pack:verified');
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
  assert.equal(Object.keys(sourcePackage.dependencies || {}).length, 0, 'Offline install expects zero runtime dependencies');
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root));
  const filename = sourcePackage.name + '-' + sourcePackage.version + '.tgz';
  assert.equal(packed.filename, filename);
  assert.equal(packed.name, sourcePackage.name);
  assert.equal(packed.version, sourcePackage.version);
  const archive = join(scratch, filename);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000 })
    .split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean);
  assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries');
  const names = entries.map(entry => {
    assert(entry.startsWith('package/'), 'Unexpected archive root');
    const name = entry.slice('package/'.length);
    assert(!name.includes(String.fromCharCode(92)) && !name.split('/').some(p => p === '..' || p === '.' || p === ''), 'Unsafe archive path');
    assert(allowed(name), 'Unexpected packed file: ' + name);
    return name;
  });
  for (const name of required) assert(names.includes(name), 'Missing package file: ' + name);
  assert.deepEqual([...names].sort(), packed.files.map(file => file.path).sort());
  const unpacked = join(scratch, 'unpacked');
  await mkdir(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked], { timeout: 30000 });
  const files = [];
  for (const name of names.sort()) {
    const source = join(root, name);
    assert((await lstat(source)).isFile(), 'Source is not a regular file: ' + name);
    const bytes = await readFile(source);
    assert.deepEqual(await readFile(join(unpacked, 'package', name)), bytes, 'Archive differs from source: ' + name);
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const name of ['install.ps1', 'enable.ps1']) {
    assert.equal((await readFile(join(unpacked, 'package', name))).subarray(0, 3).toString('hex'), 'efbbbf', name + ' requires UTF-8 BOM');
  }
  const clean = join(scratch, 'clean');
  await mkdir(clean);
  await writeFile(join(clean, 'package.json'), JSON.stringify({ name: 'package-smoke', version: '1.0.0', private: true }));
  // Only this isolated directory is installed; DSH profiles and peer packages are untouched.
  npm(['install', '--prefix', clean, '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
    '--package-lock=false', archive], clean);
  const installed = join(clean, 'node_modules', sourcePackage.name);
  for (const file of files) {
    assert.equal(hash(await readFile(join(installed, file.path))), file.sha256, 'Installed file differs: ' + file.path);
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
  console.log('PASS  Packed ' + files.length + ' files, source bytes match, clean offline install and installed config regression passed');
  console.log(filename + '  SHA256=' + digest);
  console.log('Candidate artifacts: ' + output);
} finally {
  const actual = await realpath(scratch);
  assert.equal(dirname(actual), tempParent);
  assert(relative(tempParent, actual).startsWith('dsh-hub-package-') && !relative(tempParent, actual).includes(sep));
  await rm(actual, { recursive: true, force: true });
}
