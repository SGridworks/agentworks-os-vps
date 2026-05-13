import { describe, it, expect } from 'vitest';
import AutopilotPage from './page';

describe('AutopilotPage', () => {
  it('should export a default component', () => {
    expect(AutopilotPage).toBeDefined();
    expect(typeof AutopilotPage).toBe('function');
  });
});