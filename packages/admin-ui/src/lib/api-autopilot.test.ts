import { describe, it, expect } from 'vitest';
import { listAutopilotActions, dispatchAutopilotActions, getAutopilotSettings, updateAutopilotSettings } from './api';

describe('Autopilot API functions', () => {
  it('should export all required autopilot functions', () => {
    expect(listAutopilotActions).toBeDefined();
    expect(typeof listAutopilotActions).toBe('function');
    
    expect(dispatchAutopilotActions).toBeDefined();
    expect(typeof dispatchAutopilotActions).toBe('function');
    
    expect(getAutopilotSettings).toBeDefined();
    expect(typeof getAutopilotSettings).toBe('function');
    
    expect(updateAutopilotSettings).toBeDefined();
    expect(typeof updateAutopilotSettings).toBe('function');
  });
});