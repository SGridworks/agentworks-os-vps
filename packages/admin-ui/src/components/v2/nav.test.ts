import { describe, it, expect } from 'vitest';
import { NAV_TO_PATH, type NavKey } from './nav';

describe('Navigation configuration', () => {
  it('should include autopilot in navigation paths', () => {
    expect(NAV_TO_PATH).toHaveProperty('autopilot');
    expect(NAV_TO_PATH.autopilot).toBe('/autopilot');
  });

  it('should include autopilot in NavKey type', () => {
    // This test verifies that the type system accepts 'autopilot' as a valid NavKey
    const testNavKey: NavKey = 'autopilot';
    expect(testNavKey).toBe('autopilot');
  });
});