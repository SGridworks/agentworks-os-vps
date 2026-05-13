// Simple type check for the new provenance types
import { ProvenanceMeta, getMemoryProvenance } from './src/lib/api';

// Test that the types are correctly imported
const testProvenance: ProvenanceMeta = {
  path: 'test/path',
  authoringAgent: 'agent-123',
  lastUpdatedBy: 'agent-456',
  lastUpdatedAt: '2024-01-01T00:00:00.000Z',
  lastUsedBy: ['agent-789'],
  readWindowDays: 30
};

console.log('Types imported successfully');