// Downloads the native player's third-party files, which the Windows bundle
// picks up (see src-tauri/tauri.windows.conf.json):
//
// - libmpv-2.dll into src-tauri/lib/, from the mpv-dev builds at
//   https://github.com/shinchiro/mpv-winbuild-cmake/releases
// - the ModernZ player interface into src-tauri/mpv/ (mpv's config directory),
//   from https://github.com/Samillion/ModernZ/releases
//
// Runs before `npm run dev` and `npm run bundle`; does nothing off Windows or
// for files that are already there. Each package pins a release and the
// SHA-256 of each file; a null hash skips the check, for trying a new release
// and reading its hash from the output or from src-tauri/lib/<name>.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sevenZip from '7zip-bin';

const TAURI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const LIB = join(TAURI, 'lib');

const MPV = join(TAURI, 'mpv');

const PACKAGES = [
  {
    name: 'libmpv',
    repo: 'shinchiro/mpv-winbuild-cmake',
    release: '20261021',
    installed: join(LIB, 'libmpv-2.dll'),
    assets: [
      {
        // x86_64 builds without the `-v3` suffix run on any 64-bit CPU.
        pattern: /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/,
        sha256: 'efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633',
        // Only the DLL, flattened into lib/.
        install: (file, work) => {
          execFileSync(sevenZip.path7za, ['e', file, `-o${work}`, 'libmpv-2.dll', '-y'], {
            stdio: 'ignore',
          });
          mkdirSync(LIB, { recursive: true });
          copyFileSync(join(work, 'libmpv-2.dll'), join(LIB, 'libmpv-2.dll'));
        },
      },
    ],
  },
  {
    name: 'modernz',
    repo: 'Samillion/ModernZ',
    release: null,
    installed: join(MPV, 'scripts', 'modernz.lua'),
    // src-tauri/mpv is laid out like an mpv config directory and holds only
    // this, so it starts from scratch (dropping any earlier interface).
    prepare: () => rmSync(MPV, { recursive: true, force: true }),
    assets: [
      { pattern: /^modernz\.lua$/, sha256: null, install: into(join(MPV, 'scripts')) },
      { pattern: /^fluent-system-icons\.ttf$/, sha256: null, install: into(join(MPV, 'fonts')) },
    ],
  },
];

function into(dir) {
  return (file) => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, join(dir, basename(file)));
  };
}

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

async function fetchPackage({ name, repo, release, prepare, assets }) {
  const path = release ? `tags/${release}` : 'latest';
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/${path}`;
  const response = await fetch(releaseUrl, { headers });
  if (!response.ok) {
    throw new Error(`${releaseUrl}: HTTP ${response.status}`);
  }
  const { tag_name, assets: available } = await response.json();
  prepare?.();

  const work = mkdtempSync(join(tmpdir(), `${name}-`));
  const hashes = {};
  try {
    for (const { pattern, sha256, install } of assets) {
      const asset = available.find((a) => pattern.test(a.name));
      if (!asset) {
        throw new Error(`No asset matching ${pattern} in ${repo} release ${tag_name}`);
      }
      console.log(`Downloading ${asset.name} (${repo} ${tag_name})…`);
      const download = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': headers['User-Agent'] },
      });
      if (!download.ok) {
        throw new Error(`${asset.browser_download_url}: HTTP ${download.status}`);
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      console.log(`SHA-256 ${hash}`);
      if (sha256 && hash !== sha256) {
        throw new Error(`${asset.name}: expected SHA-256 ${sha256}, got ${hash}`);
      }
      hashes[asset.name] = hash;
      const file = join(work, asset.name);
      writeFileSync(file, bytes);
      install(file, work);
    }
    // Records where the files came from, for pinning `release` and `sha256`.
    mkdirSync(LIB, { recursive: true });
    const source = { release: tag_name, sha256: hashes };
    writeFileSync(join(LIB, `${name}.json`), `${JSON.stringify(source, null, 2)}\n`);
    console.log(`Installed ${name}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
