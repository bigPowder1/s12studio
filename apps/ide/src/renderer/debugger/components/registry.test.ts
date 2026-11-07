import { describe, expect, it } from 'vitest';
import { COMPONENTS, findComponent } from './registry';

describe('component registry', () => {
  it('has every milestone component, found case-insensitively by hiwave name', () => {
    expect(COMPONENTS.map((c) => c.name)).toEqual(['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command', 'Terminal', 'ME305 Board', 'VisualizationTool']);
    expect(findComponent('source')?.name).toBe('Source');
    expect(findComponent('ME305 Board')?.name).toBe('ME305 Board');
    expect(findComponent('me305')?.name).toBe('ME305 Board');
    expect(findComponent('visualizationtool')?.name).toBe('VisualizationTool');
    expect(findComponent('coverage')).toBeUndefined();
  });
});
