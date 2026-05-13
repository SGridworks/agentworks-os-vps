import { describe, it, expect } from 'vitest';
import { validateYaml } from './yaml-schema';

describe('validateYaml', () => {
  it('returns valid for a well-formed minimal rule pack', () => {
    // Schema requires rules: minItems 1 — a pack with zero rules is meaningless.
    const yaml = [
      'pack_id: test-pack',
      'pack_version: "1.0.0"',
      'schema_version: "awcp/v1.0"',
      'rules:',
      '  - rule_id: r1',
      '    name: n',
      '    description: d',
      '    required_data: ["x"]',
      '    conditions:',
      '      - when: {}',
      '        then:',
      '          decision: allow',
      '          reason: ok',
    ].join('\n');

    const result = validateYaml(yaml);
    expect(result.valid).toBe(true);
    expect(result.markers).toHaveLength(0);
    expect(result.parseError).toBeNull();
  });

  it('returns invalid with markers when pack_id is missing (required field)', () => {
    const yaml = [
      'pack_version: "1.0.0"',
      'schema_version: "awcp/v1.0"',
      'rules: []',
    ].join('\n');

    const result = validateYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.markers.length).toBeGreaterThan(0);
    // Required field error should reference pack_id
    const msg = result.markers[0]?.message ?? '';
    expect(msg).toContain('pack_id');
  });

  it('returns a parse error marker for malformed YAML syntax', () => {
    // Use a tab-indent + flow-mode mismatch the YAML parser actually rejects.
    const yaml = [
      'pack_id: test',
      'pack_version: [unterminated',
    ].join('\n');

    const result = validateYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.parseError).not.toBeNull();
    expect(result.markers[0]?.severity).toBe(8); // SEVERITY_ERROR
  });

  it('returns an error marker for an unknown property', () => {
    const yaml = [
      'pack_id: test-pack',
      'pack_version: "1.0.0"',
      'schema_version: "awcp/v1.0"',
      'unknown_field: true',
      'rules:',   // empty rules will be caught by minItems
      '  - rule_id: r1',
      '    name: n',
      '    description: d',
      '    required_data: []',
      '    conditions: []',
    ].join('\n');

    const result = validateYaml(yaml);
    // Should reject due to unknown_field (additionalProperties)
    const hasUnknown = result.markers.some(m => m.message.includes('unknown_field'));
    expect(hasUnknown).toBe(true);
  });

  it('returns empty markers for blank input', () => {
    const result = validateYaml('');
    expect(result.valid).toBe(true);
    expect(result.markers).toHaveLength(0);
    expect(result.parseError).toBeNull();
  });

  it('severity is 8 (error) for required-field violations', () => {
    const yaml = 'pack_version: "1.0.0"\nschema_version: "awcp/v1.0"\nrules: []';
    const result = validateYaml(yaml);
    expect(result.markers[0]?.severity).toBe(8);
  });

  it('marks non-required-field schema violations as warning (severity 4)', () => {
    const yaml = [
      'pack_id: test',
      'pack_version: "not-a-version" invalid', // invalid semver format
      'schema_version: "awcp/v1.0"',
      'rules: []',
    ].join('\n');
    const result = validateYaml(yaml);
    expect(result.markers.length).toBeGreaterThan(0);
    expect(result.markers[0]?.severity).toBe(8);
  });
});
