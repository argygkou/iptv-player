// Downloads libmpv-2.dll into src-tauri/lib/, where the Windows bundle picks it
// up (see src-tauri/tauri.windows.conf.json). Runs before `npm run dev` and
// `npm run bundle`; does nothing off Windows or when the DLL is already there.
//
// The DLL comes from the mpv-dev builds at
// https://github.com/shinchiro/mpv-winbuild-cmake/releases. RELEASE pins the
// build and SHA256 is the expected hash of its archive; MPV_RELEASE and
// MPV_SHA256 override both (an empty MPV_SHA256 skips the check, for trying a
// new release and reading its hash from the output).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sevenZip from '7zip-bin';

const REPO = 'shinchiro/mpv-winbuild-cmake';
const DLL = 'libmpv-2.dll';
// x86_64 builds without the `-v3` suffix run on any 64-bit CPU.
const ASSET = /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const RELEASE = null;
const SHA256 = null;

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

const tag = process.env.MPV_RELEASE ?? RELEASE;
const expectedHash = process.env.MPV_SHA256 ?? SHA256;
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
  const bytes = Buffer.from(await archive.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  console.log(`SHA-256 ${hash}`);
  if (expectedHash && hash !== expectedHash) {
    throw new Error(`${asset.name}: expected SHA-256 ${expectedHash}, got ${hash}`);
  }
  writeFileSync(file, bytes);
  execFileSync(sevenZip.path7za, ['e', file, `-o${work}`, DLL, '-y'], { stdio: 'ignore' });
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(work, DLL), target);
  // Records where the DLL came from, for pinning RELEASE and SHA256 above.
  const source = { release: tag_name, asset: asset.name, sha256: hash };
  writeFileSync(join(dirname(target), 'libmpv.json'), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Saved ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
