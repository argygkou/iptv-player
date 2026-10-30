// Downloads the native player's third-party files, which the Windows bundle
// picks up (see src-tauri/tauri.windows.conf.json):
//
// - libmpv-2.dll into src-tauri/lib/, from the mpv-dev builds at
//   https://github.com/shinchiro/mpv-winbuild-cmake/releases
// - the uosc player interface into src-tauri/mpv/ (mpv's config directory),
//   from https://github.com/tomasklaen/uosc/releases
//
// Runs before `npm run dev` and `npm run bundle`; does nothing off Windows or
// for files that are already there. Each package pins a release and the
// SHA-256 of its archive; a null hash skips the check, for trying a new release
// and reading its hash from the output or from src-tauri/lib/<name>.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sevenZip from '7zip-bin';

const TAURI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const LIB = join(TAURI, 'lib');

const PACKAGES = [
  {
    name: 'libmpv',
    repo: 'shinchiro/mpv-winbuild-cmake',
    // x86_64 builds without the `-v3` suffix run on any 64-bit CPU.
    asset: /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/,
    release: '20261021',
    sha256: 'efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633',
    installed: join(LIB, 'libmpv-2.dll'),
    // Only the DLL, flattened into lib/.
    extract: (archive, work) => {
      execFileSync(sevenZip.path7za, ['e', archive, `-o${work}`, 'libmpv-2.dll', '-y'], {
        stdio: 'ignore',
      });
      mkdirSync(LIB, { recursive: true });
      copyFileSync(join(work, 'libmpv-2.dll'), join(LIB, 'libmpv-2.dll'));
    },
  },
  {
    name: 'uosc',
    repo: 'tomasklaen/uosc',
    asset: /^uosc\.zip$/,
    release: '5.13.0',
    sha256: '4be9da3289285300fa374496c3f1bfd7bb20ac08e890d25bd5a06b28eebe4882',
    installed: join(TAURI, 'mpv', 'scripts', 'uosc', 'main.lua'),
    // The zip holds scripts/ and fonts/, laid out like an mpv config directory.
    extract: (archive) => {
      execFileSync(sevenZip.path7za, ['x', archive, `-o${join(TAURI, 'mpv')}`, '-y'], {
        stdio: 'ignore',
      });
      // Its helper ships for every platform; the Windows bundle needs only its own.
      const bin = join(TAURI, 'mpv', 'scripts', 'uosc', 'bin');
      for (const file of readdirSync(bin).filter((f) => !f.endsWith('.exe'))) {
        rmSync(join(bin, file), { force: true });
      }
    },
  },
];

if (process.platform !== 'win32' && !process.argv.includes('--force')) {
  process.exit(0);
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'infinite-iptv' };
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

for (const pkg of PACKAGES) {
  if (!existsSync(pkg.installed)) {
    await fetchPackage(pkg);
  }
}

async function fetchPackage({ name, repo, asset: pattern, release, sha256, extract }) {
  const path = release ? `tags/${release}` : 'latest';
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/${path}`;
  const response = await fetch(releaseUrl, { headers });
  if (!response.ok) {
    throw new Error(`${releaseUrl}: HTTP ${response.status}`);
  }
  const { tag_name, assets } = await response.json();
  const asset = assets.find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(`No ${name} archive in ${repo} release ${tag_name}`);
  }

  console.log(`Downloading ${asset.name} (${repo} ${tag_name})…`);
  const archive = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': headers['User-Agent'] },
  });
  if (!archive.ok) {
    throw new Error(`${asset.browser_download_url}: HTTP ${archive.status}`);
  }
  const bytes = Buffer.from(await archive.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  console.log(`SHA-256 ${hash}`);
  if (sha256 && hash !== sha256) {
    throw new Error(`${asset.name}: expected SHA-256 ${sha256}, got ${hash}`);
  }

  const work = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    const file = join(work, asset.name);
    writeFileSync(file, bytes);
    extract(file, work);
    // Records where the files came from, for pinning `release` and `sha256`.
    mkdirSync(LIB, { recursive: true });
    const source = { release: tag_name, asset: asset.name, sha256: hash };
    writeFileSync(join(LIB, `${name}.json`), `${JSON.stringify(source, null, 2)}\n`);
    console.log(`Installed ${name}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
