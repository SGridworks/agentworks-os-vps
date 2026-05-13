import type { AdapterEnvelope, AdapterResult, AgentAdapter, AdapterMetadata } from './base';

export class ClaudeLocalAdapter implements AgentAdapter {
  readonly metadata: AdapterMetadata = {
    key: 'claude_local',
    label: 'Claude (local)',
    capabilities: ['shell.run', 'vault.read', 'vault.write'],
  };

  async execute(envelope: AdapterEnvelope): Promise<AdapterResult> {
    return {
      success: true,
      data: { message: `Executed ${envelope.actionKind} via ClaudeLocal` },
    };
  }
}
