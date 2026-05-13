import { loadPackFromString, evaluatePacks } from './src/index.js';

const BASE_PACK_YAML = `
pack_id: tcpa-baseline
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
pack_name: TCPA Baseline
pack_description: Basic TCPA compliance rules for outbound SMS
tier: free
jurisdiction: ["US"]
missing_data_disposition: route_to_review
rules:
  - rule_id: tcpa-consent-check
    name: TCPA Consent Required
    description: Outbound SMS requires prior express written consent
    required_data:
      - consentRecordRef
    disposition_when_missing: block
    priority: 10
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "TCPA: prior express written consent required for SMS"
`;

const pack = loadPackFromString(BASE_PACK_YAML);
console.log('Rule disposition_when_missing:', pack.rules[0].disposition_when_missing);

const action = {
  requestId: 'test',
  proposedAt: new Date().toISOString(),
  tenantId: '11111111-1111-1111-1111-111111111111',
  actor: { id: 'agent-x', type: 'agent', label: 'Test' },
  actionKind: 'outbound.sms',
  payload: {},
  context: { vaultRefs: [], conversationRefs: [], projectRefs: [], meta: {} },
  reviewed: false,
};
const result = evaluatePacks([pack], action);
console.log('Decision:', result.decision, '| Reason:', result.reason);
