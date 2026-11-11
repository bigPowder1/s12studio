import { describe, expect, it } from 'vitest';
import { COMPONENTS, findComponent } from './registry';

describe('component registry', () => {
  it('has every milestone component, found case-insensitively by hiwave name', () => {
    expect(COMPONENTS.map((c) => c.name)).toEqual(['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command', 'Terminal', 'ME3305 Board', 'VisualizationTool']);
    expect(findComponent('source')?.name).toBe('Source');
    expect(findComponent('ME3305 Board')?.name).toBe('ME3305 Board');
    expect(findComponent('me3305')?.name).toBe('ME3305 Board');
    // old name (course renumbered ME 305 -> ME 3305), e.g. in a layout saved by 0.1.x
    expect(findComponent('ME305 Board')?.name).toBe('ME3305 Board');
    expect(findComponent('me305')?.name).toBe('ME3305 Board');
    expect(findComponent('visualizationtool')?.name).toBe('VisualizationTool');
    expect(findComponent('coverage')).toBeUndefined();
  });
});
