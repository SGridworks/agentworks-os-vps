'use client';

import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { getActivityLog, type ActivityLogEntry } from '@/lib/api';
import { Download } from 'lucide-react';
import clsx from 'clsx';

type Filter = 'all' | 'only-fires' | 'only-fails';

function outcomeColor(o: ActivityLogEntry['outcome']): string {
  if (o === 'allow' || o === 'approved') return 'var(--ok)';
  if (o === 'block' || o === 'rejected') return 'var(--err)';
  if (o === 'route_to_review')           return 'var(--warn)';
  return 'var(--ink-3)';
}

function kindColor(k: string): string {
  if (k.startsWith('policy'))  return 'var(--warn)';
  if (k.startsWith('review'))  return 'var(--accent)';
  if (k.startsWith('vault'))   return 'var(--info)';
  if (k.startsWith('outbound')) return '#7A6BD3';
  return 'var(--ink-3)';
}

export default function ActivityV2() {
  const navigate = useV2Nav();
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await getActivityLog({ limit: 200 });
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity log');
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => entries.filter((e) =>
    filter === 'all'
      || (filter === 'only-fires' && (e.actionKind === 'rule.fire' || e.actionKind.startsWith('policy')))
      || (filter === 'only-fails' && (e.outcome === 'block' || e.outcome === 'rejected'))
  ), [entries, filter]);

  return (
    <V2Shell active="activity" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div className="eyebrow">SYSTEM · ACTIVITY LOG</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Append-only · the substrate's heartbeat
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
              Every action proposal, vault write, rule fire, and human decision is hashed into the audit ledger. The activity log is a thin lens onto that stream.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ display: 'inline-flex', border: '1px solid var(--rule-2)', borderRadius: 2, height: 30 }}>
              {([['all', 'All'], ['only-fires', 'Rule fires'], ['only-fails', 'Failures']] as const).map(([k, l], i) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  style={{
                    height: '100%',
                    padding: '0 12px',
                    border: 'none',
                    borderLeft: i ? '1px solid var(--rule-2)' : 'none',
                    background: filter === k ? 'var(--ink)' : 'transparent',
                    color: filter === k ? 'var(--bg)' : 'var(--ink-2)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <button className="btn btn-sm"><Download size={12} strokeWidth={1.6} />Export NDJSON</button>
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 14, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            <span>RECENT · LAST 200</span>
            <span>SOURCE · /api/admin/activity-log</span>
            <button
              onClick={load}
              className="mono"
              style={{
                background: 'transparent',
                border: '1px solid var(--rule-2)',
                color: 'var(--ink-2)',
                padding: '2px 8px',
                fontSize: 10,
                letterSpacing: '.06em',
                cursor: 'pointer',
                borderRadius: 2,
              }}
            >
              REFRESH
            </button>
            <span style={{ marginLeft: 'auto' }} className="tabular">{filtered.length} events shown</span>
          </div>
          <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto', fontFamily: "'JetBrains Mono', monospace" }}>
            {filtered.map((e) => {
              const t = new Date(e.timestamp);
              const tStr = isNaN(t.getTime()) ? '—' : t.toISOString().slice(11, 19);
              const ok = e.outcome === 'allow' || e.outcome === 'approved';
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 22px 200px 1fr 120px',
                    gap: 14,
                    padding: '7px 16px',
                    borderBottom: '1px solid var(--rule)',
                    alignItems: 'center',
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: 'var(--ink-3)' }} className="tabular">{tStr}</span>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? 'var(--ok)' : 'var(--err)' }} />
                  <span style={{ color: kindColor(e.actionKind), fontWeight: 600, letterSpacing: '.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.actionKind}
                  </span>
                  <span style={{ color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.actorLabel}
                  </span>
                  <span style={{ color: outcomeColor(e.outcome), textAlign: 'right', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
                    {e.outcome}
                  </span>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 13 }}>
                No events found in /api/admin/activity-log
                {filter !== 'all' ? ' for this filter — try All.' : '. Trigger an action and refresh.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </V2Shell>
  );
}
