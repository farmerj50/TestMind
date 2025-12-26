import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { execa } from 'execa';
import { redis } from './redis.js';
import type { AllureGeneratePayload } from './queue.js';

const stripAnsi = (value?: string | null) =>
  typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/g, '') : value ?? null;

export const allureWorker = new Worker(
  'allure-generate',
  async (job: Job) => {
    const payload = job.data as AllureGeneratePayload;
    const {
      runId,
      cwd,
      allureResultsDir,
      allureReportDir,
      timeoutMs,
      stdoutPath,
      stderrPath,
    } = payload;

    try {
      const npxBin = process.platform.startsWith('win') ? 'npx.cmd' : 'npx';
      const binDir = path.join(cwd, 'node_modules', '.bin');
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      };

      const proc = await execa(
        npxBin,
        ['allure', 'generate', allureResultsDir, '--clean', '-o', allureReportDir],
        { cwd, stdio: 'pipe', timeout: timeoutMs, reject: false, env }
      );

      if (proc.timedOut) {
        await fs.writeFile(
          stderrPath,
          `[runner] allure generate timed out after ${timeoutMs}ms\n`,
          { flag: 'a' }
        );
        return;
      }
      if (proc.exitCode !== 0) {
        await fs.writeFile(
          stderrPath,
          `[runner] allure generate failed (exit ${proc.exitCode}): ${stripAnsi(proc.stderr) ?? ''}\n`,
          { flag: 'a' }
        );
        return;
      }

      await fs.writeFile(
        stdoutPath,
        `[runner] allure generate completed for run ${runId}\n`,
        { flag: 'a' }
      );
    } catch (err: any) {
      await fs.writeFile(
        stderrPath,
        `[runner] allure generate failed: ${stripAnsi(err?.message ?? String(err))}\n`,
        { flag: 'a' }
      );
    }
  },
  { connection: redis }
);

allureWorker.on('failed', (job, err) => {
  console.error(`[allure] job ${job?.id} failed:`, err);
});

allureWorker.on('completed', (job) => {
  console.log(`[allure] job ${job?.id} completed`);
});
