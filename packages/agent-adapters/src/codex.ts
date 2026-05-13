import type { AdapterEnvelope, AdapterResult, AgentAdapter, AdapterMetadata } from './base';

export class CodexAdapter implements AgentAdapter {
  readonly metadata: AdapterMetadata = {
    key: 'codex',
    label: 'Codex',
    capabilities: ['shell.run', 'code.write'],
  };

  async execute(envelope: AdapterEnvelope): Promise<AdapterResult> {
    return {
      success: true,
      data: { message: `Executed ${envelope.actionKind} via Codex` },
    };
  }
}
