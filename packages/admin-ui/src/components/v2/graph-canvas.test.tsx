import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import GraphCanvas from './graph-canvas';

describe('GraphCanvas', () => {
  it('renders without crashing', () => {
    const nodes = [
      {
        id: '1',
        title: 'Test Node',
        dir: 'test',
        kind: 'note',
        tags: [],
        chars: 100,
        edited: '2024-01-01T00:00:00Z',
        outgoing: 0,
        backlinks: 0,
      },
    ];
    
    const edges = [];
    const nodeKindMeta = {
      note: { color: '#000000', icon: 'NTE' },
    };

    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        selectedId={null}
        onSelectNode={() => {}}
        nodeKindMeta={nodeKindMeta}
      />
    );
    
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders nodes and edges correctly', () => {
    const nodes = [
      {
        id: '1',
        title: 'Node 1',
        dir: 'test',
        kind: 'note',
        tags: [],
        chars: 100,
        edited: '2024-01-01T00:00:00Z',
        outgoing: 1,
        backlinks: 0,
      },
      {
        id: '2',
        title: 'Node 2',
        dir: 'test',
        kind: 'policy',
        tags: [],
        chars: 200,
        edited: '2024-01-01T00:00:00Z',
        outgoing: 0,
        backlinks: 1,
      },
    ];
    
    const edges = [
      { from: '1', to: '2' },
    ];
    
    const nodeKindMeta = {
      note: { color: '#000000', icon: 'NTE' },
      policy: { color: '#ff0000', icon: 'POL' },
    };

    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        selectedId={null}
        onSelectNode={() => {}}
        nodeKindMeta={nodeKindMeta}
      />
    );
    
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    
    // Check that circles (nodes) are rendered
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(2);
    
    // Check that lines (edges) are rendered
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBeGreaterThan(0);
  });
});