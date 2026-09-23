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
