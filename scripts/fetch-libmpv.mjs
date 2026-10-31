// Gathers the native player's third-party files, which the bundle picks up
// (see src-tauri/tauri.windows.conf.json and tauri.macos.conf.json):
//
// - Windows: libmpv-2.dll into src-tauri/lib/, from the mpv-dev builds at
//   https://github.com/shinchiro/mpv-winbuild-cmake/releases
// - macOS: Homebrew's libmpv (`brew install mpv`) and every library it needs
//   into src-tauri/lib/, relinked to load from there and signed ad hoc. No
//   prebuilt macOS libmpv includes Lua, which ModernZ needs.
// - Both: the ModernZ player interface into src-tauri/mpv/ (mpv's config
//   directory), from https://github.com/Samillion/ModernZ/releases
//
// Runs before `npm run dev` and `npm run bundle`; does nothing on other
// platforms or for files that are already there. Each download pins a release
// and the SHA-256 of each file; a null hash skips the check, for trying a new
// release and reading its hash from the output or from src-tauri/lib/<name>.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    platform: 'win32',
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
    release: 'v0.3.3',
    installed: join(MPV, 'scripts', 'modernz.lua'),
    // src-tauri/mpv is laid out like an mpv config directory and holds only
    // this, so it starts from scratch (dropping any earlier interface).
    prepare: () => rmSync(MPV, { recursive: true, force: true }),
    assets: [
      {
        pattern: /^modernz\.lua$/,
        sha256: 'c36aef0152d3fdb0c769cefe7074648b457ed50ea4ddcc402b778bec23ca32c8',
        install: into(join(MPV, 'scripts')),
      },
      {
        pattern: /^modernz-icons\.ttf$/,
        sha256: '5033b84d569502538968c6f23b0859bda790eed85c10e419b0759537ec60a016',
        install: into(join(MPV, 'fonts')),
      },
    ],
  },
];

function into(dir) {
  return (file) => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, join(dir, basename(file)));
  };
}

const force = process.argv.includes('--force');
if (!['win32', 'darwin'].includes(process.platform) && !force) {
  process.exit(0);
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'infinite-iptv' };
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

for (const pkg of PACKAGES) {
  if ((!pkg.platform || pkg.platform === process.platform || force) && !existsSync(pkg.installed)) {
    await fetchPackage(pkg);
  }
}
if (process.platform === 'darwin' && !existsSync(join(LIB, 'libmpv.2.dylib'))) {
  bundleHomebrewLibmpv();
}

/** Copies Homebrew's libmpv and its dependencies into src-tauri/lib. */
function bundleHomebrewLibmpv() {
  let prefix;
  try {
    prefix = run('brew', ['--prefix']);
  } catch {
    console.warn('Homebrew not found: the app will use the webview player. See README.md.');
    return;
  }
  const entry = join(prefix, 'lib', 'libmpv.2.dylib');
  if (!existsSync(entry)) {
    console.warn('libmpv not found: run `brew install mpv`, or the app uses the webview player.');
    return;
  }
  const version = run('brew', ['list', '--versions', 'mpv']);
  console.log(`Bundling ${entry} (${version})…`);
  mkdirSync(LIB, { recursive: true });

  // Breadth-first over the dependency tree, by install name. Every library
  // lands in lib/ under the file name of its install name, and every
  // reference to it becomes @loader_path/<name>.
  const copied = new Map(); // file name in lib/ -> source path
  const queue = [{ name: 'libmpv.2.dylib', source: realpathSync(entry) }];
  while (queue.length) {
    const { name, source } = queue.shift();
    if (copied.has(name)) continue;
    copied.set(name, source);
    const target = join(LIB, name);
    copyFileSync(source, target);
    chmodSync(target, 0o644);
    const changes = ['-id', `@loader_path/${name}`];
    for (const dependency of linkedLibraries(source)) {
      if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/')) continue;
      const depName = basename(dependency);
      changes.push('-change', dependency, `@loader_path/${depName}`);
      queue.push({ name: depName, source: resolveLibrary(dependency, source, prefix) });
    }
    run('install_name_tool', [...changes, target]);
  }
  // install_name_tool invalidates signatures, and Apple Silicon only loads signed code.
  for (const name of copied.keys()) {
    run('codesign', ['--force', '--sign', '-', join(LIB, name)]);
  }
  const source = { source: 'homebrew', version, libraries: [...copied.keys()].sort() };
  writeFileSync(join(LIB, 'libmpv.json'), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Installed libmpv with ${copied.size - 1} libraries`);
}

/** The libraries `file` links against, as written in it (`otool -L`). */
function linkedLibraries(file) {
  return run('otool', ['-L', file])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/ \(compatibility version.*$/, ''))
    .filter((path) => path && path !== file);
}

/** The file an install name refers to, from the library `from` that links it. */
function resolveLibrary(dependency, from, prefix) {
  const name = basename(dependency);
  const candidates = dependency.startsWith('@')
    ? [join(dirname(from), name), join(prefix, 'lib', name)]
    : [dependency];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`${dependency} (linked from ${from}) not found`);
  }
  return realpathSync(found);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
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
