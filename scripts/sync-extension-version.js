import { readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const manifestUrl = new URL('../extension/manifest.json', import.meta.url);
const manifest = readFileSync(manifestUrl, 'utf8');
writeFileSync(manifestUrl, manifest.replace(/"version":\s*"[^"]*"/, `"version": "${pkg.version}"`));
console.log(`extension/manifest.json -> ${pkg.version}`);
