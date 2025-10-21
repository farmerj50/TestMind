// apps/api/src/testmind/adapters/playwright-ts/runner.ts
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';

export const playwrightTSRunner = {
  id: 'playwright-ts',
  async install(cwd: string){ /* optional: pre-install here if you want */ },
  async run(cwd: string, env: Record<string,string>, onLine: (s:string)=>void){
    // ensure deps are present (best effort)
    if (!fs.existsSync(path.join(cwd,'node_modules'))) {
      try { await execa(process.platform==='win32'?'npm.cmd':'npm',['i'],{cwd}); } catch {}
      try { await execa(process.platform==='win32'?'npx.cmd':'npx',['playwright','install','--with-deps'],{cwd}); } catch {}
    }
    const cmd = process.platform==='win32'?'npx.cmd':'npx';
    const proc = execa(cmd, ['playwright','test','-c','playwright.config.ts'], { cwd, env: { ...process.env, ...env }});
    proc.stdout?.on('data', d=>onLine(d.toString()));
    proc.stderr?.on('data', d=>onLine(d.toString()));
    const { exitCode } = await proc;
    return exitCode ?? 1;
  }
};
