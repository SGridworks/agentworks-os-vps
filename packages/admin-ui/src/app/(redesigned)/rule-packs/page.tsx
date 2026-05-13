'use client';

import { useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { KPICard } from '@/components/v2/primitives';
import { listRulePacks, flipPackMode, getRulePackStats, type RulePackSummary, type RulePackStatsResponse } from '@/lib/api';
import { Plus, ListChecks } from 'lucide-react';

export default function RulePacksV2() {
  const navigate = useV2Nav();
  const [packs, setPacks] = useState<RulePackSummary[]>([]);
  const [stats, setStats] = useState<RulePackStatsResponse | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [next, statsRes] = await Promise.all([listRulePacks(), getRulePackStats()]);
      setPacks(next);
      setStats(statsRes);
      setSelId((cur) => cur && next.some((p) => p.id === cur) ? cur : (next[0]?.id ?? null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rule packs');
    }
  }
  useEffect(() => { load(); }, []);

  const sel = packs.find((p) => p.id === selId) ?? null;
  const enabled = packs.filter((p) => !p.shadowMode).length;

  async function toggleEnabled(p: RulePackSummary) {
    setBusy(true);
    try {
      const target: 'shadow' | 'enforce' = p.shadowMode ? 'enforce' : 'shadow';
      // reviewerId is required by the API; use a placeholder for now until a session/identity is wired.
      await flipPackMode(p.packId, target, 'admin-ui-v2');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mode flip failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <V2Shell active="rule-packs" onNav={navigate}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', flex: 1, minHeight: 0 }}>
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
          <div>
            <div className="eyebrow">GOVERN · RULE PACKS</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Compiled policy, pinned by version
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
              Rule packs evaluate every action proposal before it leaves the substrate. Packs are versioned and tenant-scoped; rolling forward writes a new evidence entry.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <KPICard label="ENABLED" value={`${enabled}/${packs.length}`} hint="Enforcing on this tenant" />
            <KPICard
              label="TOTAL RULES"
              value={stats ? String(stats.totals.rulesCount) : '—'}
              hint={stats ? `${stats.items.length} packs` : 'loading…'}
            />
            <KPICard
              label="FIRES · 24H"
              value={stats ? String(stats.totals.fires24h) : '—'}
              hint={stats ? `window: ${stats.windowHours}h` : 'loading…'}
            />
            <KPICard label="ESCALATIONS · 24H" value="—" hint="add count from approval-queue" accent />
          </div>

          {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center' }}>
              <div className="eyebrow" style={{ margin: 0 }}>CATALOG · {packs.length}</div>
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }}>
                <Plus size={12} strokeWidth={1.6} />Install pack
              </button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>Pack</th>
                  <th style={{ width: 90 }}>Version</th>
                  <th style={{ width: 90 }}>Tier</th>
                  <th style={{ width: 90 }}>Mode</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelId(p.id)}
                    style={{ cursor: 'pointer', background: selId === p.id ? 'var(--bg-2)' : 'transparent' }}
                  >
                    <td>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: p.shadowMode ? 'var(--ink-4)' : 'var(--ok)' }} />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.packName ?? p.packId}</div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 2, letterSpacing: '.04em' }}>{p.packId}</div>
                    </td>
                    <td className="mono tabular">{p.packVersion}</td>
                    <td>
                      <span className="mono" style={{ fontSize: 10, padding: '1px 6px', border: '1px solid var(--rule-2)', color: 'var(--ink-2)', borderRadius: 2, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                        {p.tier}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: p.shadowMode ? 'var(--warn)' : 'var(--ok)' }}>
                      {p.shadowMode ? 'shadow' : 'enforcing'}
                    </td>
                  </tr>
                ))}
                {packs.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)' }}>
                      No rule packs installed.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside style={{ borderLeft: '1px solid var(--rule)', background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {sel ? (
            <>
              <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--rule)' }}>
                <div className="eyebrow">PACK DETAIL</div>
                <div className="serif" style={{ fontSize: 22, letterSpacing: '-0.012em', marginTop: 4, lineHeight: 1.2 }}>
                  {sel.packName ?? sel.packId}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '.04em' }}>
                  {sel.packId} · v{sel.packVersion} · {sel.tier}
                </div>
              </div>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--rule)', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                Rule list and per-rule severities are not exposed via <span className="mono">/api/policy/packs/:id</span> yet —
                add when the substrate ships <span className="mono">pack.rules[]</span>.
              </div>
              <div style={{ padding: '14px 20px', display: 'flex', gap: 8 }}>
                <button className="btn btn-sm" style={{ flex: 1 }} disabled={busy} onClick={() => toggleEnabled(sel)}>
                  {sel.shadowMode ? 'Switch to enforce' : 'Switch to shadow'}
                </button>
                <button className="btn btn-sm btn-primary" style={{ flex: 1 }} onClick={() => navigate('approvals')}>
                  <ListChecks size={12} strokeWidth={1.6} />Escalations
                </button>
              </div>
            </>
          ) : (
            <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 12 }}>Select a pack to inspect.</div>
          )}
        </aside>
      </div>
    </V2Shell>
  );
}
