import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execAsync = promisify(exec);

describe('installer help (dry‑run sanity)', () => {
  it('agentworks installer --help exits 0 and shows usage', async () => {
    const { stdout, stderr } = await execAsync('bash apps/installer/src/agentworks.sh --help', { timeout: 30000 });
    expect(stderr).toBe('');
    expect(stdout).toContain('agentworks install');
  });
});
