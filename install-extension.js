import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';

const SOURCE = fileURLToPath(new URL('./extension', import.meta.url));
const OPEN_URL = 'chrome://extensions';

const MESSAGES = {
  en: {
    tip: {
      mac: 'Tip: press ⌘⇧G in the file picker and paste the path.',
      win: 'Tip: paste the path into the address bar at the top of the dialog (Ctrl+V).',
      linux: 'Tip: press Ctrl+L in the file picker and paste the path.',
    },
    replaceFailed: (dest, reason) => `❌ Couldn't replace ${dest} (${reason}).`,
    replaceHint: '   Close your browser (it may be holding the files) or delete that folder by hand, then run this again.',
    unknownBrowser: (value, list) => `❌ Unknown --browser "${value}". Use one of: ${list}`,
    sourceMissing: (src) => `❌ Extension files not found at ${src}`,
    sameFolder: (dest) => `❌ Source and destination are the same folder: ${dest}`,
    done: (isUpdate, dest) => `✅ Kibana Log Bridge extension ${isUpdate ? 'updated' : 'installed'} at:\n\n   ${dest}\n`,
    copied: '📋 Path copied to your clipboard.\n',
    browsers: 'The extension works in Chrome, Edge, Brave, Arc, Vivaldi and other Chromium browsers (not Firefox or Safari).',
    oneBrowser: `Load it in the browser where you're logged into your dashboard (one browser only).\n`,
    openGeneric: 'Open the extensions page of your Chromium browser (e.g. chrome://extensions, edge://extensions, brave://extensions).',
    shouldShow: (name, url) => `${name} should now show ${url}.`,
    openIn: (name, url) => `Open ${url} in ${name}.`,
    nextSteps: 'Next steps:',
    reload: '  2. Click the reload ↻ icon on "Kibana Log Bridge".',
    devMode: (edge) => `  2. Turn on Developer mode (${edge ? 'left sidebar' : 'top right'}).`,
    loadUnpacked: '  3. Click Load unpacked and select the folder above.',
  },
  tr: {
    tip: {
      mac: 'İpucu: dosya seçicide ⌘⇧G tuşlarına basıp yolu yapıştırın.',
      win: 'İpucu: yolu pencerenin üstündeki adres çubuğuna yapıştırın (Ctrl+V).',
      linux: 'İpucu: dosya seçicide Ctrl+L tuşlarına basıp yolu yapıştırın.',
    },
    replaceFailed: (dest, reason) => `❌ ${dest} güncellenemedi (${reason}).`,
    replaceHint: '   Tarayıcınızı kapatın (dosyaları kullanıyor olabilir) ya da klasörü elle silin, sonra komutu tekrar çalıştırın.',
    unknownBrowser: (value, list) => `❌ Bilinmeyen --browser değeri: "${value}". Şunlardan birini kullanın: ${list}`,
    sourceMissing: (src) => `❌ Uzantı dosyaları bulunamadı: ${src}`,
    sameFolder: (dest) => `❌ Kaynak ve hedef aynı klasör: ${dest}`,
    done: (isUpdate, dest) => `✅ Kibana Log Bridge uzantısı ${isUpdate ? 'güncellendi' : 'kuruldu'}:\n\n   ${dest}\n`,
    copied: '📋 Yol panoya kopyalandı.\n',
    browsers: 'Uzantı Chrome, Edge, Brave, Arc, Vivaldi ve diğer Chromium tabanlı tarayıcılarda çalışır (Firefox ve Safari desteklenmez).',
    oneBrowser: 'Uzantıyı, dashboard\'unuza giriş yaptığınız tarayıcıya yükleyin (tek bir tarayıcı yeterli).\n',
    openGeneric: 'Chromium tarayıcınızın uzantılar sayfasını açın (ör. chrome://extensions, edge://extensions, brave://extensions).',
    shouldShow: (name, url) => `${name} şu anda ${url} sayfasını göstermeli.`,
    openIn: (name, url) => `${name} tarayıcısında ${url} adresini açın.`,
    nextSteps: 'Sonraki adımlar:',
    reload: '  2. "Kibana Log Bridge" üzerindeki yeniden yükle ↻ simgesine tıklayın.',
    devMode: (edge) => `  2. Geliştirici modu seçeneğini açın (${edge ? 'sol kenar çubuğunda' : 'sağ üstte'}).`,
    loadUnpacked: '  3. Paketlenmemiş öğe yükle düğmesine tıklayın ve yukarıdaki klasörü seçin.',
  },
};

export const BROWSERS = {
  chrome: { name: 'Google Chrome', url: 'chrome://extensions', mac: ['com.google.chrome', 'com.google.chrome.canary'], win: ['ChromeHTML'], winExe: 'chrome', linux: ['google-chrome', 'google-chrome-stable'] },
  brave: { name: 'Brave', url: 'brave://extensions', mac: ['com.brave.browser'], win: ['BraveHTML'], winExe: 'brave', linux: ['brave-browser', 'brave'] },
  edge: { name: 'Microsoft Edge', url: 'edge://extensions', mac: ['com.microsoft.edgemac'], win: ['MSEdgeHTM'], winExe: 'msedge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  arc: { name: 'Arc', url: 'chrome://extensions', mac: ['company.thebrowser.browser'], win: [], winExe: null, linux: [] },
  vivaldi: { name: 'Vivaldi', url: 'vivaldi://extensions', mac: ['com.vivaldi.vivaldi'], win: ['VivaldiHTM'], winExe: 'vivaldi', linux: ['vivaldi-stable', 'vivaldi'] },
  opera: { name: 'Opera', url: 'opera://extensions', mac: ['com.operasoftware.opera'], win: ['OperaStable'], winExe: 'opera', linux: ['opera'] },
  chromium: { name: 'Chromium', url: 'chrome://extensions', mac: ['org.chromium.chromium'], win: ['ChromiumHTM'], winExe: 'chromium', linux: ['chromium', 'chromium-browser'] },
};

export function extensionDir(home = os.homedir()) {
  return path.join(home, '.kibana-bridge', 'extension');
}

export function parseMacDefault(plistJson) {
  try {
    const { LSHandlers = [] } = JSON.parse(plistJson);
    const handler = LSHandlers.find(h => h.LSHandlerURLScheme === 'https') || LSHandlers.find(h => h.LSHandlerURLScheme === 'http');
    return handler?.LSHandlerRoleAll?.toLowerCase() || null;
  } catch (e) {
    return null;
  }
}

export function parseWindowsProgId(regOutput) {
  return regOutput.match(/ProgId\s+REG_SZ\s+(\S+)/i)?.[1] || null;
}

export function browserFromDefault(platform, id) {
  if (!id) return null;
  const lower = id.toLowerCase();
  const match = {
    darwin: (b) => b.mac.includes(lower),
    win32: (b) => b.win.some(p => lower.startsWith(p.toLowerCase())),
  }[platform] || ((b) => b.linux.includes(lower.replace(/\.desktop$/, '')));
  return Object.keys(BROWSERS).find(k => match(BROWSERS[k])) || null;
}

export function clipboardCommands(platform, text) {
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [], input: text }];
  if (platform === 'win32') {
    return [
      { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:KB_PATH'], env: { KB_PATH: text } },
      { cmd: 'clip', args: [], input: text },
    ];
  }
  return [
    { cmd: 'wl-copy', args: [], input: text },
    { cmd: 'xclip', args: ['-selection', 'clipboard'], input: text },
  ];
}

export function openCommands(platform, key, bundleId) {
  const browser = BROWSERS[key];
  if (platform === 'darwin') {
    return (bundleId ? [bundleId] : browser.mac).map(id => ({ cmd: 'open', args: ['-b', id, OPEN_URL], wait: true }));
  }
  if (platform === 'win32') {
    if (!browser.winExe) return [];
    return [{ cmd: 'cmd', args: ['/c', 'start', '""', browser.winExe, OPEN_URL], options: { windowsVerbatimArguments: true } }];
  }
  return browser.linux.map(cmd => ({ cmd, args: [OPEN_URL] }));
}

export function pickerTip(platform, lang = 'en') {
  const tip = MESSAGES[lang]?.tip || MESSAGES.en.tip;
  if (platform === 'darwin') return tip.mac;
  if (platform === 'win32') return tip.win;
  return tip.linux;
}

export function detectLang(argv = [], env = process.env, intlLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const flag = optionValue(argv, '--lang')?.toLowerCase();
  if (flag && MESSAGES[flag]) return flag;
  const posix = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(v => v && v !== 'C' && v !== 'POSIX');
  const locale = posix || intlLocale || '';
  return locale.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

function capture(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch (e) {
      resolve('');
    }
  });
}

function run({ cmd, args, input, env }) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      if (input !== undefined) child.stdin.end(input);
    } catch (e) {
      resolve(false);
    }
  });
}

function launch({ cmd, args, options }) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...options });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

async function copyToClipboard(text) {
  for (const command of clipboardCommands(process.platform, text)) {
    if (await run(command)) return true;
  }
  return false;
}

async function detectDefaultBrowser() {
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
    const bundleId = parseMacDefault(await capture('plutil', ['-convert', 'json', '-o', '-', plist]));
    return { key: browserFromDefault('darwin', bundleId), bundleId };
  }
  if (process.platform === 'win32') {
    const out = await capture('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
    return { key: browserFromDefault('win32', parseWindowsProgId(out)) };
  }
  const desktop = (await capture('xdg-settings', ['get', 'default-web-browser'])).trim();
  return { key: browserFromDefault(process.platform, desktop) };
}

async function isInstalled(key) {
  if (process.platform !== 'win32') return true;
  for (const hive of ['HKCU', 'HKLM']) {
    if (await capture('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${BROWSERS[key].winExe}.exe`, '/ve'])) return true;
  }
  return false;
}

async function openExtensionsPage(key, bundleId) {
  for (const command of openCommands(process.platform, key, bundleId)) {
    if (await (command.wait ? run(command) : launch(command))) return true;
  }
  return false;
}

function optionValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function copyExtension(dest, t) {
  try {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(SOURCE, dest, { recursive: true });
  } catch (err) {
    console.error(t.replaceFailed(dest, err.code || err.message));
    console.error(t.replaceHint);
    process.exit(1);
  }
}

export default async function installExtension(argv = []) {
  const lang = detectLang(argv);
  const t = MESSAGES[lang];
  const override = optionValue(argv, '--browser')?.toLowerCase();
  if (override !== undefined && !BROWSERS[override]) {
    console.error(t.unknownBrowser(override, Object.keys(BROWSERS).join(', ')));
    process.exit(1);
  }
  const dest = extensionDir();
  if (!fs.existsSync(path.join(SOURCE, 'manifest.json'))) {
    console.error(t.sourceMissing(SOURCE));
    process.exit(1);
  }
  if (path.resolve(SOURCE) === path.resolve(dest)) {
    console.error(t.sameFolder(dest));
    process.exit(1);
  }

  const isUpdate = fs.existsSync(dest);
  copyExtension(dest, t);

  const copied = await copyToClipboard(dest);

  const detected = override ? { key: override } : await detectDefaultBrowser();
  let key = detected.key;
  let opened = false;
  if (!argv.includes('--no-open')) {
    if (key) opened = await openExtensionsPage(key, detected.bundleId);
    if (!opened && !override && key !== 'chrome' && await isInstalled('chrome')) {
      opened = await openExtensionsPage('chrome');
      if (opened) key = 'chrome';
    }
  }
  const browser = BROWSERS[key];

  console.log(t.done(isUpdate, dest));
  if (copied) console.log(t.copied);
  if (!browser) console.log(t.browsers);
  console.log(t.oneBrowser);

  const step1 = !browser
    ? t.openGeneric
    : opened ? t.shouldShow(browser.name, browser.url) : t.openIn(browser.name, browser.url);
  console.log(t.nextSteps);
  console.log(`  1. ${step1}`);
  if (isUpdate) {
    console.log(t.reload);
  } else {
    console.log(t.devMode(key === 'edge'));
    console.log(t.loadUnpacked);
    console.log(`     ${pickerTip(process.platform, lang)}`);
  }
}
