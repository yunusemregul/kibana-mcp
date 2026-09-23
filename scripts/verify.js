import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

const jsFiles = ['.', 'extension', 'scripts'].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(root, dir, f)));
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax error in ${path.relative(root, file)}\n${r.stderr}`);
}
ok(`syntax of ${jsFiles.length} files`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
ok(`extension version matches package (${pkg.version})`);

const extDir = path.join(root, 'extension');
const locales = Object.fromEntries(['en', 'tr'].map(l => {
  const file = path.join(extDir, '_locales', l, 'messages.json');
  try { return [l, JSON.parse(fs.readFileSync(file, 'utf8'))]; } catch (e) { fail(`cannot parse _locales/${l}/messages.json: ${e.message}`); }
}));
const enKeys = Object.keys(locales.en).sort();
const trKeys = Object.keys(locales.tr).sort();
const missingTr = enKeys.filter(k => !locales.tr[k]);
const extraTr = trKeys.filter(k => !locales.en[k]);
if (missingTr.length || extraTr.length) fail(`en/tr messages differ. Missing in tr: ${missingTr.join(', ') || '-'}; only in tr: ${extraTr.join(', ') || '-'}`);
for (const l of ['en', 'tr']) {
  const empty = Object.entries(locales[l]).filter(([, v]) => typeof v?.message !== 'string' || !v.message).map(([k]) => k);
  if (empty.length) fail(`_locales/${l} has keys without a message: ${empty.join(', ')}`);
}
if (manifest.default_locale !== 'en') fail('manifest.json default_locale must be "en"');
const used = new Set();
for (const f of fs.readdirSync(extDir).filter(f => /\.(js|html|json)$/.test(f))) {
  const src = fs.readFileSync(path.join(extDir, f), 'utf8');
  const patterns = [
    /getMessage\(\s*["'](\w+)["']/g,
    /\b(?:t|msg)\(\s*["'](\w+)["']/g,
    /data-i18n(?:-placeholder|-title)?="(\w+)"/g,
    /__MSG_(\w+)__/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) used.add(m[1]);
}
const undefinedKeys = [...used].filter(k => !locales.en[k]);
if (undefinedKeys.length) fail(`message keys used but not defined: ${undefinedKeys.join(', ')}`);
ok(`i18n: en and tr have the same ${enKeys.length} keys, all ${used.size} referenced keys exist`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-verify-'));
const install = spawnSync(process.execPath, [path.join(root, 'server.js'), 'install-extension', '--no-open'], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home },
});
const installed = path.join(home, '.kibana-bridge', 'extension', 'manifest.json');
if (install.status !== 0 || !fs.existsSync(installed)) fail(`install-extension failed\n${install.stdout}${install.stderr}`);
ok('install-extension copies the extension');

const mcpPort = 40000 + Math.floor(Math.random() * 10000);
const server = spawn(process.execPath, [path.join(root, 'server.js'), '--stdio'], {
  env: { ...process.env, MCP_PORT: String(mcpPort), WS_PORT: String(mcpPort + 1) },
  stdio: ['pipe', 'ignore', 'ignore'],
});
let health = null;
for (let i = 0; i < 40 && !health; i++) {
  await new Promise(r => setTimeout(r, 250));
  try {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    if (res.ok) health = await res.json();
  } catch (e) { /* not up yet */ }
}
server.kill();
if (health?.name !== 'kibana-bridge-mcp' || health.version !== pkg.version) fail(`server /health did not respond correctly: ${JSON.stringify(health)}`);
ok('server starts and answers /health');
process.exit(0);
