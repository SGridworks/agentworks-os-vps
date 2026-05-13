'use client';

import { useEffect, useMemo, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { listScannerFindings, resolveFinding, type ScannerFinding } from '@/lib/api';
import { Play, Square } from 'lucide-react';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Sev = typeof SEV_ORDER[number];

function sevColor(s: string): string {
  if (s === 'critical') return 'var(--err)';
  if (s === 'high')     return 'var(--warn)';
  if (s === 'medium')   return 'var(--accent)';
  return 'var(--ink-3)';
}

export default function ScannerV2() {
  const navigate = useV2Nav();
  const [findings, setFindings] = useState<ScannerFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  async function load() {
    try {
      const next = await listScannerFindings();
      setFindings(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load findings');
    }
  }
  useEffect(() => { load(); }, []);

  const open = useMemo(() => findings.filter((f) => !f.resolved), [findings]);
  const counts = useMemo(() => {
    const c: Record<Sev, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of open) c[f.severity] += 1;
    return c;
  }, [open]);
  const sorted = useMemo(() =>
    [...open].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)),
    [open]
  );

  async function resolve(id: string) {
    setResolving(id);
    try { await resolveFinding(id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Resolve failed'); }
    finally  { setResolving(null); }
  }

  return (
    <V2Shell active="scanner" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div className="eyebrow">GOVERN · SCANNER</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Sweep the surface · find everything bound for review
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
              AgentGuard sweeps the agent fleet's configuration and outbound posture for risks. Output is grouped by severity and resolves into the audit ledger.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm">Scan options</button>
            <button className="btn btn-primary" onClick={() => setRunning((r) => !r)}>
              {running
                ? <><Square size={12} strokeWidth={1.6} />Stop scan</>
                : <><Play size={12} strokeWidth={1.6} />Run scan</>
              }
            </button>
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
            <div key={s} className="card" style={{ padding: '14px 16px', borderTop: `2px solid ${sevColor(s)}` }}>
              <div className="eyebrow" style={{ marginBottom: 6, color: sevColor(s) }}>{s.toUpperCase()}</div>
              <div className="serif tabular" style={{ fontSize: 30, lineHeight: 1, letterSpacing: '-0.02em' }}>{counts[s]}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center' }}>
            <div className="eyebrow" style={{ margin: 0 }}>FINDINGS · {sorted.length}</div>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em' }}>
              {findings.length - open.length} resolved · {findings.length} total
            </span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Severity</th>
                <th style={{ width: 200 }}>Rule</th>
                <th>Where</th>
                <th>Description</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className="mono" style={{ fontSize: 10, padding: '2px 7px', border: `1px solid ${sevColor(f.severity)}`, color: sevColor(f.severity), borderRadius: 2, textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
                      {f.severity}
                    </span>
                  </td>
                  <td className="mono" style={{ fontWeight: 600, color: 'var(--ink)' }}>{f.ruleId}</td>
                  <td className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{f.filePath ?? f.agentLabel ?? '—'}</td>
                  <td>{f.description}</td>
                  <td>
                    <button className="btn btn-sm" disabled={resolving === f.id} onClick={() => resolve(f.id)}>
                      {resolving === f.id ? '…' : 'Resolve'}
                    </button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    No open findings.
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
