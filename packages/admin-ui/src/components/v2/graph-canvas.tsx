'use client';

import { useMemo, useRef } from 'react';

export interface GraphNode {
  id: string;
  title: string;
  dir: string;
  kind: string;
  tags: string[];
  chars: number;
  edited: string;
  outgoing: number;
  backlinks: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface NodeKindMeta {
  color: string;
  icon: string;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  nodeKindMeta: Record<string, NodeKindMeta>;
  width?: number;
  height?: number;
  className?: string;
}

function topDir(dir: string): string {
  if (!dir) return '(root)';
  return dir.split('/')[0] ?? '(root)';
}

export default function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelectNode,
  nodeKindMeta,
  width = 1000,
  height = 700,
  className,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Cluster layout: nodes are positioned in clusters by top-level directory.
  // Each cluster gets a slot on a ring; nodes inside spread radially.
  const positions = useMemo(() => {
    const byTop = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const top = topDir(node.dir);
      const arr = byTop.get(top) ?? [];
      arr.push(node);
      byTop.set(top, arr);
    }
    
    const tops = Array.from(byTop.keys()).sort();
    const R = Math.min(width, height) / 2 - 80;
    const cx = width / 2;
    const cy = height / 2;
    const pos = new Map<string, { x: number; y: number; cluster: string; hue: number }>();
    
    tops.forEach((top, i) => {
      const angle = (i / tops.length) * Math.PI * 2 - Math.PI / 2;
      const clusterX = cx + Math.cos(angle) * R * 0.55;
      const clusterY = cy + Math.sin(angle) * R * 0.55;
      const items = byTop.get(top) ?? [];
      const hue = (i * 137.508) % 360;
      const ringR = Math.min(140, 14 + Math.sqrt(items.length) * 12);
      
      items.forEach((node, j) => {
        const a = (j / Math.max(items.length, 1)) * Math.PI * 2;
        pos.set(node.id, {
          x: clusterX + Math.cos(a) * ringR * (0.6 + 0.4 * (((node.id.length * 17) % 100) / 100)),
          y: clusterY + Math.sin(a) * ringR * (0.6 + 0.4 * (((node.id.length * 31) % 100) / 100)),
          cluster: top,
          hue,
        });
      });
    });
    
    return pos;
  }, [nodes, width, height]);

  const visibleEdges = useMemo(() => 
    edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)), 
    [edges, positions]
  );
  
  const selectedEdges = useMemo(() => 
    selectedId ? visibleEdges.filter((e) => e.from === selectedId || e.to === selectedId) : [],
    [visibleEdges, selectedId]
  );

  return (
    <div 
      className={className}
      style={{ 
        position: 'relative', 
        background: 'var(--bg)', 
        overflow: 'hidden', 
        display: 'flex', 
        flexDirection: 'column', 
        minWidth: 0 
      }}
    >
      <div className="bg-grid" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <svg 
        ref={svgRef} 
        viewBox={`0 0 ${width} ${height}`} 
        preserveAspectRatio="xMidYMid meet" 
        style={{ flex: 1, width: '100%', height: '100%', minHeight: 0 }}
      >
        <g opacity={0.18}>
          {visibleEdges.map((edge, i) => {
            const fromPos = positions.get(edge.from)!;
            const toPos = positions.get(edge.to)!;
            return (
              <line 
                key={i} 
                x1={fromPos.x} 
                y1={fromPos.y} 
                x2={toPos.x} 
                y2={toPos.y} 
                stroke="var(--ink-3)" 
                strokeWidth={0.4} 
              />
            );
          })}
        </g>
        {selectedId && (
          <g opacity={0.95}>
            {selectedEdges.map((edge, i) => {
              const fromPos = positions.get(edge.from)!;
              const toPos = positions.get(edge.to)!;
              const isOut = edge.from === selectedId;
              return (
                <line 
                  key={i} 
                  x1={fromPos.x} 
                  y1={fromPos.y} 
                  x2={toPos.x} 
                  y2={toPos.y}
                  stroke={isOut ? 'var(--accent)' : 'var(--warn)'} 
                  strokeWidth={1.2} 
                />
              );
            })}
          </g>
        )}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          
          const meta = nodeKindMeta[node.kind] ?? nodeKindMeta.note ?? { color: 'var(--ink-3)', icon: 'NTE' };
          const radius = 2.5 + Math.min(6, Math.sqrt(node.backlinks + node.outgoing));
          const active = selectedId === node.id;
          
          return (
            <g key={node.id} onClick={() => onSelectNode(node.id)} style={{ cursor: 'pointer' }}>
              <circle 
                cx={pos.x} 
                cy={pos.y} 
                r={radius} 
                fill={meta.color} 
                opacity={active ? 1 : 0.85}
                stroke={active ? 'var(--ink)' : 'transparent'} 
                strokeWidth={active ? 1.5 : 0} 
              />
              {active && (
                <text 
                  x={pos.x + radius + 4} 
                  y={pos.y + 3} 
                  fontSize={10} 
                  fill="var(--ink)" 
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {node.title.slice(0, 40)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}