// apps/api/src/testmind/adapters/playwright-ts/runner.ts
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';


function onelineCopyLog(line: string, onLine: (s: string) => void) {
  onLine(line.endsWith('\n') ? line : line + '\n');
}

function exists(p: string) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrfSync(p: string) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// robust recursive copy (Node 18+ has fs.cpSync but we’ll keep this portable)
function copyRecursiveSync(src: string, dest: string) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function pickSpecSource(cwd: string, onLine: (s: string) => void) {
  const mode = (process.env.TM_SPECS_MODE || 'auto').toLowerCase();

  // Common defaults for a monorepo: running from apps/web; repo specs live at apps/api/testmind-generated/playwright-ts
  const repoDefaultCandidates = [
    path.resolve(cwd, '..', 'api', 'testmind-generated', 'playwright-ts'),
    path.resolve(cwd, 'testmind-generated', 'playwright-ts'),
    path.resolve(cwd, '..', 'testmind-generated', 'playwright-ts'),
    path.resolve(cwd, '..', '..', 'testmind-generated', 'playwright-ts'),
  ];

  const local = process.env.TM_LOCAL_SPECS && exists(process.env.TM_LOCAL_SPECS)
    ? process.env.TM_LOCAL_SPECS
    : null;

  const repo = repoDefaultCandidates.find(exists) || null;

  let src: string | null = null;
  if (mode === 'local') src = local;
  else if (mode === 'repo') src = repo;
  else /* auto */ src = local || repo;

  if (!src) {
    const msg =
      `[runner] No spec source found. TM_SPECS_MODE=${mode}, ` +
      `TM_LOCAL_SPECS=${process.env.TM_LOCAL_SPECS || '<unset>'}, ` +
      `repoCandidates=${repoDefaultCandidates.join(' | ')}`;
    throw new Error(msg);
  }

  onelineCopyLog(`[runner] specs mode=${mode} src=${src}`, onLine);
  return src;
}

function findOrWriteConfig(cwd: string, destTestDir: string, onLine: (s: string) => void) {
  const candidates = [
    'tm-ci.playwright.config.ts',
    'tm-ci.playwright.config.mjs',
    'tm-ci.playwright.config.js',
    'playwright.config.ts',
    'playwright.config.mjs',
    'playwright.config.js',
    'playwright.config.cjs',
  ].map(f => path.join(cwd, f));

  for (const c of candidates) {
    if (exists(c)) {
      onelineCopyLog(`[runner] using existing Playwright config: ${c}`, onLine);
      return c;
    }
  }

  // Write a minimal CI config that points to our dest test directory.
  const cfgPath = path.join(cwd, 'tm-ci.playwright.config.ts');
  const testGlob = process.env.TM_TEST_GLOB || '**/*.spec.ts';
  const cfg = `
    import { defineConfig } from '@playwright/test';
    export default defineConfig({
      reporter: [['json']],
      use: { baseURL: process.env.PW_BASE_URL || process.env.TM_BASE_URL || 'http://localhost:4173' },
      webServer: { command: 'vite preview --port 4173', port: 4173, reuseExistingServer: true },
      projects: [{
        name: 'generated',
        testDir: ${JSON.stringify(destTestDir)},
        testMatch: [${JSON.stringify(testGlob)}, '**/*.test.ts'],
        testIgnore: ['**/node_modules/**','**/dist/**','**/build/**','**/.*/**'],
        timeout: 30_000
      }]
    });
  `.trim() + '\n';
  fs.writeFileSync(cfgPath, cfg, 'utf8');
  onelineCopyLog(`[runner] wrote CI Playwright config: ${cfgPath}`, onLine);
  return cfgPath;
}

export const playwrightTSRunner = {
  id: 'playwright-ts',

  async install(cwd: string) {
    // optional preinstall hook; noop
  },

  async run(cwd: string, env: Record<string, string>, onLine: (s: string) => void) {
    // 0) Best-effort deps
    if (!exists(path.join(cwd, 'node_modules'))) {
      try {
        await execa(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['i'], { cwd });
      } catch {}
      try {
        await execa(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', '--with-deps'], { cwd });
      } catch {}
    }

    // 1) Decide source → destination for generated specs
    const src = pickSpecSource(cwd, onLine);
    const dest = path.join(cwd, 'testmind-generated', 'playwright-ts');

    if ((process.env.TM_CLEAN_DEST ?? '1') === '1') {
      rmrfSync(dest);
      onelineCopyLog(`[runner] cleaned dest: ${dest}`, onLine);
    }
    ensureDir(dest);
    copyRecursiveSync(src, dest);
    onelineCopyLog(`[runner] copied specs → dest: ${dest}`, onLine);

    if (process.env.TM_LOG_SPECS === '1') {
      const walk = (dir: string, out: string[] = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, out);
          else if (/\.(spec|test)\.(t|j)sx?$/i.test(e.name)) out.push(p);
        }
        return out;
      };
      const files = walk(dest);
      onelineCopyLog(`[runner] dest spec count=${files.length}`, onLine);
      for (const f of files) onelineCopyLog(` - ${f}`, onLine);
    }

    // 2) Find or write a Playwright config pointing to our dest
    const configPath = findOrWriteConfig(cwd, dest, onLine);

    // 3) Kick off Playwright
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const childEnv = { ...process.env, ...env };

    // keep logs readable
    onelineCopyLog(`[runner] invoking: ${cmd} playwright test -c ${configPath}`, onLine);

    const proc = execa(cmd, ['playwright', 'test', '-c', configPath], { cwd, env: childEnv });
    proc.stdout?.on('data', d => onLine(d.toString()));
    proc.stderr?.on('data', d => onLine(d.toString()));
    const { exitCode } = await proc;
    return exitCode ?? 1;
  },
};

