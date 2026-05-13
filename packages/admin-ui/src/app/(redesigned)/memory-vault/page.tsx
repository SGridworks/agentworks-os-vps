'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { getMemoryGraph, getMemoryProvenance, type VaultGraph, type VaultGraphNote, type ProvenanceMeta } from '@/lib/api';
import { useActiveTenant } from '@/lib/use-active-tenant';
import { ChevronDown, ChevronRight, Folder, X } from 'lucide-react';
import GraphCanvas from '@/components/v2/graph-canvas';

const KIND_META: Record<string, { c: string; ic: string }> = {
  policy:   { c: 'var(--info)',   ic: 'POL' },
  runbook:  { c: 'var(--warn)',   ic: 'RUN' },
  template: { c: 'var(--accent)', ic: 'TPL' },
  evidence: { c: 'var(--ok)',     ic: 'EVD' },
  schema:   { c: '#7A6BD3',       ic: 'SCH' },
  log:      { c: 'var(--ink-3)',  ic: 'LOG' },
  note:     { c: 'var(--ink-3)',  ic: 'NTE' },
};

function topDir(dir: string): string {
  if (!dir) return '(root)';
  return dir.split('/')[0] ?? '(root)';
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

export default function MemoryVaultV2() {
  const navigate = useV2Nav();
  const { tenant } = useActiveTenant();
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [filterDir, setFilterDir] = useState<string | null>(null);
  const [filterKinds, setFilterKinds] = useState<Set<string>>(new Set(Object.keys(KIND_META)));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!tenant) return;
    setSelectedId(null);
    getMemoryGraph(tenant.id).then(setGraph).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [tenant]);

  const filteredNotes = useMemo(() => (graph?.notes ?? []).filter((n) =>
    (!filterDir || (filterDir === '(root)' ? n.dir === '' : n.dir.startsWith(filterDir))) &&
    filterKinds.has(n.kind) &&
    (!filterText || n.title.toLowerCase().includes(filterText.toLowerCase()) || n.id.toLowerCase().includes(filterText.toLowerCase()))
  ), [graph, filterDir, filterKinds, filterText]);

  return (
    <V2Shell active="memory-vault" onNav={navigate}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <Header
          tenantName={tenant?.name ?? '—'}
          filterText={filterText} setFilterText={setFilterText}
          filteredCount={filteredNotes.length}
          totalCount={graph?.notes.length ?? 0}
          edgeCount={graph?.edges.length ?? 0}
          generatedAt={graph?.generatedAt}
        />
        {error && <div style={{ padding: '8px 24px', fontSize: 12, color: 'var(--err)' }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 380px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <StructureRail
            graph={graph}
            filterDir={filterDir} setFilterDir={setFilterDir}
            filterKinds={filterKinds} setFilterKinds={setFilterKinds}
            selectedId={selectedId} setSelectedId={setSelectedId}
            filteredNotes={filteredNotes}
          />
          <Canvas notes={filteredNotes} edges={graph?.edges ?? []} selectedId={selectedId} onSelect={setSelectedId} />
          <DetailPanel id={selectedId} setId={setSelectedId} graph={graph} tenantId={tenant?.id ?? null} />
        </div>
      </div>
    </V2Shell>
  );
}

function Header({ tenantName, filterText, setFilterText, filteredCount, totalCount, edgeCount, generatedAt }:
  { tenantName: string; filterText: string; setFilterText: (s: string) => void; filteredCount: number; totalCount: number; edgeCount: number; generatedAt?: string }) {
  return (
    <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--rule)', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span className="eyebrow">MEMORY VAULT</span>
        <span className="serif" style={{ fontSize: 22, letterSpacing: '-0.018em', marginTop: 2, lineHeight: 1.1 }}>Knowledge graph · {tenantName}</span>
      </div>
      <input className="form-input" value={filterText} onChange={(e) => setFilterText(e.target.value)}
        placeholder="title, key, tag…" style={{ width: 280, height: 30, fontSize: 12, marginLeft: 8 }} />
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em' }}>
        <span><b style={{ color: 'var(--ink)' }} className="tabular">{filteredCount}</b><span style={{ color: 'var(--ink-4)' }}>/{totalCount}</span> notes</span>
        <span><b style={{ color: 'var(--ink)' }} className="tabular">{edgeCount}</b> edges</span>
        {generatedAt && <span>indexed {relTime(generatedAt)}</span>}
      </div>
    </div>
  );
}

function StructureRail({ graph, filterDir, setFilterDir, filterKinds, setFilterKinds, selectedId, setSelectedId, filteredNotes }:
  { graph: VaultGraph | null; filterDir: string | null; setFilterDir: (s: string | null) => void;
    filterKinds: Set<string>; setFilterKinds: (s: Set<string>) => void;
    selectedId: string | null; setSelectedId: (s: string) => void; filteredNotes: VaultGraphNote[] }) {

  const tree = useMemo(() => {
    const groups: Record<string, Record<string, number>> = {};
    for (const n of graph?.notes ?? []) {
      const top = topDir(n.dir);
      const sub = n.dir === '' ? '' : (n.dir.split('/').slice(1).join('/') || '');
      groups[top] = groups[top] || {};
      groups[top][sub] = (groups[top][sub] ?? 0) + 1;
    }
    return groups;
  }, [graph]);

  const [openTop, setOpenTop] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const k of Object.keys(tree)) next[k] = true;
    setOpenTop(next);
  }, [tree]);

  const kindFreq = useMemo(() => {
    const f: Record<string, number> = {};
    for (const n of graph?.notes ?? []) f[n.kind] = (f[n.kind] ?? 0) + 1;
    return f;
  }, [graph]);

  return (
    <aside style={{ borderRight: '1px solid var(--rule)', background: 'var(--bg-card)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Block title="DIRECTORY">
        <div style={{ display: 'grid', gap: 1 }}>
          <RailRow label="all vault" count={graph?.notes.length ?? 0} active={!filterDir} onClick={() => setFilterDir(null)} />
          {Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)).map(([top, subs]) => {
            const total = Object.values(subs).reduce((s, x) => s + x, 0);
            const open = openTop[top];
            const topActive = filterDir === top;
            return (
              <div key={top}>
                <RailRow
                  label={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button onClick={(e) => { e.stopPropagation(); setOpenTop({ ...openTop, [top]: !open }); }}
                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ink-3)', cursor: 'pointer', display: 'inline-flex' }}>
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                      <Folder size={12} />{top}
                    </span>
                  }
                  count={total} active={topActive} onClick={() => setFilterDir(topActive ? null : top)} />
                {open && Object.entries(subs).filter(([s]) => s !== '').sort(([a], [b]) => a.localeCompare(b)).map(([sub, n]) => {
                  const fullDir = `${top}/${sub}`;
                  const active = filterDir === fullDir;
                  return (
                    <RailRow key={fullDir} indent={20}
                      label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{sub}</span>}
                      count={n} active={active} onClick={() => setFilterDir(active ? null : fullDir)} />
                  );
                })}
              </div>
            );
          })}
        </div>
      </Block>

      <Block title="KIND">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(KIND_META).map(([k, m]) => {
            const on = filterKinds.has(k);
            const count = kindFreq[k] ?? 0;
            return (
              <button key={k} onClick={() => {
                const next = new Set(filterKinds);
                if (next.has(k)) next.delete(k); else next.add(k);
                setFilterKinds(next);
              }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', height: 22,
                  border: `1px solid ${on ? m.c : 'var(--rule-2)'}`, color: on ? m.c : 'var(--ink-3)',
                  background: on ? 'var(--bg-card)' : 'transparent', borderRadius: 2,
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '.06em', cursor: 'pointer' }}>
                {m.ic}<span className="tabular" style={{ opacity: .7 }}>{count}</span>
              </button>
            );
          })}
        </div>
      </Block>

      <Block title={`MATCHES · ${filteredNotes.length}`} flush>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 360, overflowY: 'auto' }}>
          {filteredNotes.slice(0, 100).map((n) => {
            const m = KIND_META[n.kind] ?? KIND_META.note!;
            const active = selectedId === n.id;
            return (
              <li key={n.id} onClick={() => setSelectedId(n.id)}
                style={{ padding: '8px 12px', borderTop: '1px solid var(--rule)', cursor: 'pointer',
                  background: active ? 'var(--bg-2)' : 'transparent',
                  borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="mono" style={{ fontSize: 9, padding: '1px 4px', color: m.c, border: `1px solid ${m.c}`, borderRadius: 2, letterSpacing: '.05em' }}>{m.ic}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{n.title}</span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 3, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{n.dir || '(root)'}</span>
                  <span className="tabular">↘{n.outgoing} ↙{n.backlinks}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </Block>
    </aside>
  );
}

function Block({ title, children, flush }: { title: string; children: React.ReactNode; flush?: boolean }) {
  return (
    <section style={{ padding: flush ? '14px 0 0' : '14px 14px', borderBottom: '1px solid var(--rule)' }}>
      <div className="eyebrow" style={{ padding: flush ? '0 14px 8px' : '0 0 8px' }}>{title}</div>
      <div>{children}</div>
    </section>
  );
}

function RailRow({ label, count, active, onClick, indent = 0 }:
  { label: React.ReactNode; count: number; active?: boolean; onClick: () => void; indent?: number }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: `5px 10px 5px ${10 + indent}px`,
      background: active ? 'var(--bg-2)' : 'transparent',
      border: 'none', borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
      color: active ? 'var(--ink)' : 'var(--ink-2)',
      fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '.02em',
      cursor: 'pointer', width: '100%', textAlign: 'left',
      fontWeight: active ? 600 : 400,
    }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="tabular" style={{ color: 'var(--ink-4)', fontSize: 10 }}>{count}</span>
    </button>
  );
}

function Canvas({ notes, edges, selectedId, onSelect }:
  { notes: VaultGraphNote[]; edges: [string, string][]; selectedId: string | null; onSelect: (id: string) => void }) {

  // Convert VaultGraphNote to GraphNode format
  const graphNodes = useMemo(() => notes.map(note => ({
    id: note.id,
    title: note.title,
    dir: note.dir,
    kind: note.kind,
    tags: note.tags,
    chars: note.chars,
    edited: note.edited,
    outgoing: note.outgoing,
    backlinks: note.backlinks,
  })), [notes]);

  // Convert edges to GraphEdge format
  const graphEdges = useMemo(() => edges.map(([from, to]) => ({ from, to })), [edges]);

  // Convert KIND_META to nodeKindMeta format
  const nodeKindMeta = useMemo(() => {
    const meta: Record<string, { color: string; icon: string }> = {};
    for (const [kind, data] of Object.entries(KIND_META)) {
      meta[kind] = { color: data.c, icon: data.ic };
    }
    return meta;
  }, []);

  return (
    <div style={{ position: 'relative', background: 'var(--bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="bg-grid" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <GraphCanvas
        nodes={graphNodes}
        edges={graphEdges}
        selectedId={selectedId}
        onSelectNode={onSelect}
        nodeKindMeta={nodeKindMeta}
        width={1000}
        height={700}
      />
      <div style={{ borderTop: '1px solid var(--rule)', background: 'var(--bg-card)', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 14, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '.06em', color: 'var(--ink-3)' }}>
        <span>VIEW · <b style={{ color: 'var(--ink-2)' }}>CLUSTER</b></span>
        <span style={{ width: 1, height: 12, background: 'var(--rule-2)' }} />
        <span>NODES · <b style={{ color: 'var(--ink-2)' }} className="tabular">{notes.length}</b></span>
        <span style={{ width: 1, height: 12, background: 'var(--rule-2)' }} />
        <span>EDGES · <b style={{ color: 'var(--ink-2)' }} className="tabular">{graphEdges.filter(edge => 
          notes.some(n => n.id === edge.from) && notes.some(n => n.id === edge.to)
        ).length}</b></span>
        <span style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}>click a node to inspect</span>
      </div>
    </div>
  );
}

function ProvenanceTab({ provenance }: { provenance: ProvenanceMeta | null }) {
  if (!provenance) {
    return (
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ padding: '14px 16px', fontSize: 11, color: 'var(--ink-4)', fontStyle: 'italic', background: 'var(--bg-2)', borderRadius: 2 }}>
          No provenance data available.
        </div>
      </div>
    );
  }

  const isStale = provenance.lastUpdatedAt && 
    (Date.now() - new Date(provenance.lastUpdatedAt).getTime()) > (30 * 24 * 60 * 60 * 1000);

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>AUTHOR</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {provenance.authoringAgent ? (
            <>
              <span className="mono" style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-2)', color: 'var(--ink)', borderRadius: 2 }}>
                {provenance.authoringAgent.slice(0, 8)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>Agent</span>
            </>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>—</span>
          )}
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>LAST UPDATED</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {provenance.lastUpdatedBy ? (
            <>
              <span className="mono" style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-2)', color: 'var(--ink)', borderRadius: 2 }}>
                {provenance.lastUpdatedBy.slice(0, 8)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>Agent</span>
              {provenance.lastUpdatedAt && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                  {relTime(provenance.lastUpdatedAt)}
                </span>
              )}
            </>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>—</span>
          )}
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>LAST READERS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {provenance.lastUsedBy.length > 0 ? (
            provenance.lastUsedBy.map((readerId, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-2)', color: 'var(--ink)', borderRadius: 2 }}>
                  {readerId.slice(0, 8)}
                </span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>Agent</span>
              </div>
            ))
          ) : (
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>No recent readers</span>
          )}
        </div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 4 }}>
          Tracking window: {provenance.readWindowDays} days
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>STALE RISK</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isStale ? (
            <>
              <span className="mono" style={{ fontSize: 10, padding: '2px 6px', background: 'var(--warn)', color: 'var(--bg)', borderRadius: 2, fontWeight: 600 }}>
                STALE
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                Last updated &gt;30 days ago
              </span>
            </>
          ) : (
            <span className="mono" style={{ fontSize: 10, padding: '2px 6px', background: 'var(--ok)', color: 'var(--bg)', borderRadius: 2, fontWeight: 600 }}>
              FRESH
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>DECISIONS INFLUENCED</div>
        <div style={{ padding: '12px 14px', background: 'var(--bg-2)', borderRadius: 2, border: '1px solid var(--rule)' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>
            No decision influence data available
          </span>
        </div>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>CONFLICTS</div>
        <div style={{ padding: '12px 14px', background: 'var(--bg-2)', borderRadius: 2, border: '1px solid var(--rule)' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>
            No conflict data available
          </span>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ id, setId, graph, tenantId }:
  { id: string | null; setId: (s: string | null) => void; graph: VaultGraph | null; tenantId: string | null }) {

  const [body, setBody] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ProvenanceMeta | null>(null);
  const [tab, setTab] = useState<'overview' | 'source' | 'links' | 'provenance'>('overview');

  const note = id ? (graph?.notes ?? []).find((n) => n.id === id) ?? null : null;

  useEffect(() => {
    setBody(null);
    setProvenance(null);
    if (!id || !tenantId) return;
    fetch('/api/memory/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, key: id }),
    }).then((r) => r.json()).then((r) => setBody(r?.data?.body ?? '')).catch(() => setBody(''));
    
    // Fetch provenance data
    getMemoryProvenance(tenantId, id).then(setProvenance).catch(() => setProvenance(null));
  }, [id, tenantId]);

  if (!note) return <aside style={{ borderLeft: '1px solid var(--rule)', background: 'var(--bg-card)', padding: 24, color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 12 }}>Select a node to inspect.</aside>;

  const m = KIND_META[note.kind] ?? KIND_META.note!;
  const outIds = (graph?.edges ?? []).filter(([a]) => a === id).map(([, b]) => b);
  const inIds  = (graph?.edges ?? []).filter(([, b]) => b === id).map(([a]) => a);
  const lookup = (nid: string) => (graph?.notes ?? []).find((n) => n.id === nid);

  return (
    <aside style={{ borderLeft: '1px solid var(--rule)', background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="mono" style={{ fontSize: 9, padding: '2px 5px', color: m.c, border: `1px solid ${m.c}`, borderRadius: 2, letterSpacing: '.08em', fontWeight: 600 }}>{m.ic}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.dir || '(root)'}</span>
          <button onClick={() => setId(null)} className="btn btn-sm" style={{ marginLeft: 'auto', width: 22, height: 22, padding: 0 }}><X size={12} /></button>
        </div>
        <div className="serif" style={{ fontSize: 18, letterSpacing: '-0.012em', lineHeight: 1.2, marginBottom: 6 }}>{note.title}</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', display: 'flex', gap: 10, letterSpacing: '.04em', flexWrap: 'wrap' }}>
          <span>↘{note.outgoing} out</span><span>↙{note.backlinks} in</span>
          <span className="tabular">{note.chars}c</span>
          <span style={{ marginLeft: 'auto' }}>edited {relTime(note.edited)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)' }}>
        {(['overview', 'source', 'links', 'provenance'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, height: 34, border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'transparent', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase',
            color: tab === t ? 'var(--ink)' : 'var(--ink-3)', cursor: 'pointer', fontWeight: tab === t ? 600 : 400,
          }}>{t}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'overview' && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {note.tags.length > 0 && (
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>TAGS</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {note.tags.map((t) => (
                    <span key={t} className="mono" style={{ fontSize: 10, padding: '2px 7px', background: 'var(--bg-2)', color: 'var(--ink-2)', borderRadius: 2, letterSpacing: '.04em' }}>{t}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>EXCERPT</div>
              <pre className="mono" style={{ margin: 0, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--rule)', borderLeft: `2px solid ${m.c}`, fontSize: 11, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 280, overflowY: 'auto' }}>
                {body === null ? 'loading…' : body.split('\n').slice(0, 18).join('\n') || '(empty)'}
              </pre>
            </div>
          </div>
        )}
        {tab === 'source' && (
          <pre className="mono" style={{ margin: 0, padding: '12px 14px', fontSize: 11, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.65, background: 'var(--bg)' }}>
            {body === null ? 'loading…' : (body || '(empty)')}
          </pre>
        )}
        {tab === 'links' && (
          <div style={{ padding: '10px 6px' }}>
            <div className="eyebrow" style={{ padding: '4px 10px 6px' }}>↙ INCOMING · {inIds.length}</div>
            {inIds.map((nid) => {
              const n = lookup(nid);
              const mm = n ? (KIND_META[n.kind] ?? KIND_META.note!) : KIND_META.note!;
              return (
                <button key={nid} onClick={() => setId(nid)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%', background: 'transparent', border: 'none', borderTop: '1px solid var(--rule)', textAlign: 'left', cursor: 'pointer' }}>
                  <span className="mono" style={{ fontSize: 9, padding: '1px 4px', color: mm.c, border: `1px solid ${mm.c}`, borderRadius: 2 }}>{mm.ic}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n?.title ?? nid}</span>
                </button>
              );
            })}
            {inIds.length === 0 && <div style={{ padding: '14px 16px', fontSize: 11, color: 'var(--ink-4)', fontStyle: 'italic' }}>No incoming links.</div>}
            <div className="eyebrow" style={{ padding: '14px 10px 6px' }}>↘ OUTGOING · {outIds.length}</div>
            {outIds.map((nid) => {
              const n = lookup(nid);
              const mm = n ? (KIND_META[n.kind] ?? KIND_META.note!) : KIND_META.note!;
              return (
                <button key={nid} onClick={() => setId(nid)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%', background: 'transparent', border: 'none', borderTop: '1px solid var(--rule)', textAlign: 'left', cursor: 'pointer' }}>
                  <span className="mono" style={{ fontSize: 9, padding: '1px 4px', color: mm.c, border: `1px solid ${mm.c}`, borderRadius: 2 }}>{mm.ic}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n?.title ?? nid}</span>
                </button>
              );
            })}
          </div>
        )}
        {tab === 'provenance' && (
          <ProvenanceTab provenance={provenance} />
        )}
      </div>
    </aside>
  );
}
