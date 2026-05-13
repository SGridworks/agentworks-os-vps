'use client';

import { useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { KPICard } from '@/components/v2/primitives';
import {
  listInsights,
  updateInsight,
  archiveInsight,
  listTenants,
  type Insight,
  type InsightFrameType,
} from '@/lib/api';
import { Check, Archive, Pencil, Save, X } from 'lucide-react';

const FRAMES: Array<InsightFrameType | 'all'> = [
  'all',
  'preference',
  'fact',
  'plan',
  'constraint',
  'feedback',
  'error_pattern',
];

export default function InsightsV2() {
  const navigate = useV2Nav();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [filter, setFilter] = useState<InsightFrameType | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);

  useEffect(() => {
    listTenants()
      .then((ts) => setTenantId(ts[0]?.id ?? null))
      .catch((e) => setError(String(e)));
  }, []);

  async function load() {
    if (!tenantId) return;
    try {
      const items = await listInsights({
        tenantId,
        frameType: filter === 'all' ? undefined : filter,
        limit: 500,
      });
      setInsights(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load insights');
    }
  }
  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, filter]);

  async function toggleValidated(ins: Insight) {
    if (!tenantId) return;
    setBusy(ins.id);
    try {
      const updated = await updateInsight(ins.id, { tenantId, validated: !ins.validated });
      setInsights((prev) => prev.map((i) => (i.id === ins.id ? updated : i)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!tenantId || !editing) return;
    setBusy(editing.id);
    try {
      const updated = await updateInsight(editing.id, { tenantId, content: editing.content });
      setInsights((prev) => prev.map((i) => (i.id === editing.id ? updated : i)));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function archive(ins: Insight) {
    if (!tenantId) return;
    if (!confirm(`Archive this insight?\n\n"${ins.content.slice(0, 80)}…"`)) return;
    setBusy(ins.id);
    try {
      await archiveInsight(ins.id, tenantId);
      setInsights((prev) => prev.filter((i) => i.id !== ins.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Archive failed');
    } finally {
      setBusy(null);
    }
  }

  const total = insights.length;
  const validated = insights.filter((i) => i.validated).length;
  const byFrame = insights.reduce<Record<string, number>>((acc, i) => {
    acc[i.frameType] = (acc[i.frameType] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <V2Shell active="insights" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div>
          <div className="eyebrow">OPERATE · INSIGHTS</div>
          <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
            Atomic memory frames
          </div>
          <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
            Frame-typed facts the substrate accumulates from agent reflection, user corrections, and task outcomes.
            Validate the ones you trust; archive what's stale or wrong.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <KPICard label="ACTIVE" value={String(total)} hint="across all frame types" />
          <KPICard label="VALIDATED" value={`${validated}/${total}`} hint="human-confirmed" />
          <KPICard
            label="TOP FRAME"
            value={Object.entries(byFrame).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'}
            hint="most common"
          />
          <KPICard label="UNVALIDATED" value={String(total - validated)} hint="awaiting review" accent />
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FRAMES.map((f) => (
            <button
              key={f}
              className="btn btn-sm"
              style={{
                background: filter === f ? 'var(--ink)' : 'transparent',
                color: filter === f ? 'var(--paper)' : 'var(--ink-2)',
                borderColor: 'var(--rule-2)',
              }}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'all' : f}
              {f !== 'all' && byFrame[f] ? (
                <span style={{ marginLeft: 6, opacity: 0.7 }}>{byFrame[f]}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 100 }}>Frame</th>
                <th style={{ width: 140 }}>Subject</th>
                <th>Content</th>
                <th style={{ width: 70 }}>Imp</th>
                <th style={{ width: 110 }}>Source</th>
                <th style={{ width: 130 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {insights.map((ins) => (
                <tr key={ins.id} style={{ background: ins.validated ? 'transparent' : 'var(--bg-2)' }}>
                  <td>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        border: '1px solid var(--rule-2)',
                        color: 'var(--ink-2)',
                        borderRadius: 2,
                        textTransform: 'uppercase',
                        letterSpacing: '.06em',
                      }}
                    >
                      {ins.frameType}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {ins.subject ?? '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {editing?.id === ins.id ? (
                      <input
                        className="input"
                        style={{ width: '100%', fontSize: 13 }}
                        value={editing.content}
                        onChange={(e) => setEditing({ id: ins.id, content: e.target.value })}
                        autoFocus
                      />
                    ) : (
                      ins.content
                    )}
                  </td>
                  <td className="mono tabular">{ins.importance}</td>
                  <td className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                    {ins.source}
                  </td>
                  <td style={{ display: 'flex', gap: 4 }}>
                    {editing?.id === ins.id ? (
                      <>
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={busy === ins.id || !editing.content.trim()}
                          onClick={saveEdit}
                          title="Save"
                        >
                          <Save size={12} strokeWidth={1.6} />
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy === ins.id}
                          onClick={() => setEditing(null)}
                          title="Cancel"
                        >
                          <X size={12} strokeWidth={1.6} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-sm"
                          style={{ background: ins.validated ? 'var(--ok-bg)' : 'transparent' }}
                          disabled={busy === ins.id}
                          onClick={() => toggleValidated(ins)}
                          title={ins.validated ? 'Unmark validated' : 'Mark validated'}
                        >
                          <Check size={12} strokeWidth={ins.validated ? 2.2 : 1.6} />
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy === ins.id}
                          onClick={() => setEditing({ id: ins.id, content: ins.content })}
                          title="Edit"
                        >
                          <Pencil size={12} strokeWidth={1.6} />
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy === ins.id}
                          onClick={() => archive(ins)}
                          title="Archive"
                        >
                          <Archive size={12} strokeWidth={1.6} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {insights.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)' }}>
                    No insights yet. They'll appear here as agents reflect on tasks and operators leave corrections.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </V2Shell>
  );
}
