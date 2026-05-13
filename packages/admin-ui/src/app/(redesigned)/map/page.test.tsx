import { describe, it, expect } from 'vitest';
import MapPage from './page';

describe('MapPage', () => {
  it('should export a default component', () => {
    expect(MapPage).toBeDefined();
    expect(typeof MapPage).toBe('function');
  });
});