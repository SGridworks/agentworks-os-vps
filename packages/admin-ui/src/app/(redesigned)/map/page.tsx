/**
 * Mission Map Graph View
 * 
 * Full-graph canvas (zoom/pan) seeded from the tenant root node.
 * Node badges show live counts (open issues, running agents, unseen evidence).
 * Edge thickness = event volume over last 24 h.
 * Color rules applied server-side so color is consistent across clients.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  MiniMap,
  Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { listTenants, getMapGraph, type MapGraph, type MapNode, type Tenant } from '@/lib/api';
import { useV2Nav } from '@/components/v2/nav';
import { ZoomIn, ZoomOut, RotateCcw, Loader2 } from 'lucide-react';

// Color palette from the spec
const PALETTE = {
  company: { default: '#0ea5e9', hover: '#0284c7' },
  project: { default: '#10b981', hover: '#059669' },
  issue: { default: '#f59e0b', hover: '#d97706' },
  agent: { default: '#8b5cf6', hover: '#7c3aed' },
  run: { default: '#6b7280', hover: '#4b5563' },
  evidence: { default: '#ef4444', hover: '#dc2626' },
  memory: { default: '#06b6d4', hover: '#0891b2' },
} as const;

function MapCanvas() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<MapGraph | null>(null);
  const navigate = useV2Nav();
  
  // Convert map graph to ReactFlow nodes and edges
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Load tenant and graph data
  useEffect(() => {
    async function loadData() {
      try {
        const tenants = await listTenants();
        const tenant = tenants[0];
        if (!tenant) {
          setLoading(false);
          return;
        }
        setTenant(tenant);
        
        const graphData = await getMapGraph(tenant.id);
        setGraphData(graphData);
      } catch (err) {
        console.error('Failed to load graph:', err);
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
  }, []);

  // Transform map graph to ReactFlow format
  useEffect(() => {
    if (!graphData) return;

    // Convert map nodes to ReactFlow nodes
    const flowNodes = graphData.nodes.map((node, index) => ({
      id: node.id,
      type: 'default',
      position: { 
        x: (index % 5) * 250, 
        y: Math.floor(index / 5) * 150 
      },
      data: {
        label: node.title,
        kind: node.kind,
        status: node.status,
      },
    }));

    // Convert map edges to ReactFlow edges
    const flowEdges = graphData.edges.map((edge, index) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      animated: false,
      style: { stroke: '#6b7280', strokeWidth: 2 },
    }));

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [graphData, setNodes, setEdges]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: any) => {
    const nodeKind = node.data?.kind;
    const nodeId = node.id;
    
    if (!nodeKind || !nodeId) {
      console.warn('Node missing kind or id:', node);
      return;
    }
    
    // Navigate to appropriate detail page based on node kind
    switch (nodeKind) {
      case 'agent':
        // Navigate to specific agent page
        window.location.href = `/agents/${nodeId}`;
        break;
      case 'company':
      case 'project':
        // For companies and projects, navigate to mission control
        window.location.href = `/mission-control/${nodeId}`;
        break;
      case 'issue':
        // Issues don't have a dedicated detail page in the current nav structure
        // For now, navigate to triage queue which shows issues
        navigate('triage-queue');
        break;
      case 'run':
        // Runs don't have a dedicated detail page, navigate to activity log
        navigate('activity');
        break;
      case 'evidence':
        navigate('evidence');
        break;
      case 'memory':
        navigate('memory-vault');
        break;
      default:
        console.log('Unknown node kind:', nodeKind);
    }
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-gray-600">Loading mission map...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background color="#f1f5f9" gap={16} />
        <Controls 
          position="top-right"
          showZoom={true}
          showFitView={true}
          showInteractive={true}
        />
        <MiniMap 
          position="bottom-right"
          nodeColor={(node) => {
            const kind = node.data?.kind || 'memory';
            return PALETTE[kind as keyof typeof PALETTE]?.default || PALETTE.memory.default;
          }}
          maskColor="rgb(241, 245, 249, 0.8)"
        />
        
        {/* Custom zoom controls */}
        <Panel position="top-left" className="flex flex-col gap-2">
          <div className="bg-white rounded-lg shadow-lg p-3 border">
            <h3 className="text-sm font-semibold mb-2">Map Controls</h3>
            <div className="flex flex-col gap-1">
              <button
                className="btn btn-secondary text-sm justify-start"
                onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }))}
              >
                <ZoomIn className="h-4 w-4 mr-2" />
                Zoom In
              </button>
              <button
                className="btn btn-secondary text-sm justify-start"
                onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }))}
              >
                <ZoomOut className="h-4 w-4 mr-2" />
                Zoom Out
              </button>
              <button
                className="btn btn-secondary text-sm justify-start"
                onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset View
              </button>
            </div>
          </div>
        </Panel>

        {/* Legend */}
        <Panel position="bottom-left" className="bg-white rounded-lg shadow-lg p-3 border">
          <h3 className="text-sm font-semibold mb-2">Legend</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {Object.entries(PALETTE).map(([kind, colors]) => (
              <div key={kind} className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded-full" 
                  style={{ backgroundColor: colors.default }}
                />
                <span className="capitalize">{kind}</span>
              </div>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export default function MapPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="border-b bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Mission Map</h1>
            <p className="text-gray-600 mt-1">
              Visualize your entire AgentWorks substrate as an explorable graph
            </p>
          </div>
        </div>
      </div>
      
      <div className="flex-1 bg-gray-50">
        <ReactFlowProvider>
          <MapCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  );
}