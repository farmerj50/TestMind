/**
 * Capability dispatcher — routes a step to the correct executor.
 *
 * Usage:
 *   const output = await dispatch('api', { action: 'get', target: 'https://...' }, ctx);
 */

import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';
import { runApiCapability } from './api-cap.js';
import { runBrowserCapability } from './browser-cap.js';
import { runTerminalCapability } from './terminal-cap.js';
import { runGitCapability } from './git-cap.js';
import { runFilesystemCapability } from './filesystem-cap.js';

export type { CapabilityInput, CapabilityOutput, ExecutionContext };
export { GIT_WRITE_ACTIONS } from './git-cap.js';

export type CapabilityName = 'api' | 'browser' | 'terminal' | 'git' | 'filesystem' | 'security';

export async function dispatch(
  capability: CapabilityName,
  input: CapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  switch (capability) {
    case 'api':
      return runApiCapability(input, ctx);
    case 'browser':
      return runBrowserCapability(input, ctx);
    case 'terminal':
      return runTerminalCapability(input, ctx);
    case 'git':
      return runGitCapability(input, ctx);
    case 'filesystem':
      return runFilesystemCapability(input, ctx);
    case 'security':
      // Security capability requires explicit approval for every action.
      // Execution logic is reserved for Sprint 4.
      return { success: false, error: 'security capability is not yet implemented; request approval first' };
    default:
      return { success: false, error: `Unknown capability: ${capability}` };
  }
}
