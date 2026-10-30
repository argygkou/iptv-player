// Downloads libmpv-2.dll into src-tauri/lib/, where the Windows bundle picks it
// up (see src-tauri/tauri.windows.conf.json). Runs before `npm run dev` and
// `npm run bundle`; does nothing off Windows or when the DLL is already there.
//
// The DLL comes from the mpv-dev builds at
// https://github.com/shinchiro/mpv-winbuild-cmake/releases. Set MPV_RELEASE to a
// release tag to pin one; the latest release is used otherwise.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sevenZip from '7zip-bin';

const REPO = 'shinchiro/mpv-winbuild-cmake';
const DLL = 'libmpv-2.dll';
// x86_64 builds without the `-v3` suffix run on any 64-bit CPU.
const ASSET = /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'lib', DLL);

if (process.platform !== 'win32' && !process.argv.includes('--force')) {
  process.exit(0);
}
if (existsSync(target)) {
  process.exit(0);
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'infinite-iptv' };
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const tag = process.env.MPV_RELEASE;
const releaseUrl = `https://api.github.com/repos/${REPO}/releases/${tag ? `tags/${tag}` : 'latest'}`;
const release = await fetch(releaseUrl, { headers });
if (!release.ok) {
  throw new Error(`${releaseUrl}: HTTP ${release.status}`);
}
const { tag_name, assets } = await release.json();
const asset = assets.find((a) => ASSET.test(a.name));
if (!asset) {
  throw new Error(`No mpv-dev x86_64 archive in release ${tag_name}`);
}

console.log(`Downloading ${asset.name} (${tag_name})…`);
const archive = await fetch(asset.browser_download_url, {
  headers: { 'User-Agent': headers['User-Agent'] },
});
if (!archive.ok) {
  throw new Error(`${asset.browser_download_url}: HTTP ${archive.status}`);
}

const work = mkdtempSync(join(tmpdir(), 'libmpv-'));
try {
  const file = join(work, asset.name);
  writeFileSync(file, Buffer.from(await archive.arrayBuffer()));
  execFileSync(sevenZip.path7za, ['e', file, `-o${work}`, DLL, '-y'], { stdio: 'ignore' });
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(work, DLL), target);
  console.log(`Saved ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
