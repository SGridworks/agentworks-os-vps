'use client';

import { useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { KPICard, StatusPill } from '@/components/v2/primitives';

interface ProcessHealthCheck {
  checkId: string;
  label: string;
  pass: number;
  flag: number;
  autoFix: number;
}
interface ProcessHealthAgent {
  agentId: string;
  agentName: string;
  checks: ProcessHealthCheck[];
}
interface ProcessHealthDigest {
  today: { totalActions: number; violationsCaught: number };
  period: string;
  generatedAt: string;
  agents: ProcessHealthAgent[];
  topOffenders: { agentId: string; agentName: string; totalFlags: number; topCheck: string; topSeverity: 'critical' | 'warn' | 'info' }[];
  checkDefinitions: { checkId: string; label: string; description: string }[];
}

export default function ProcessHealthV2() {
  const navigate = useV2Nav();
  const [digest, setDigest] = useState<ProcessHealthDigest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/admin/process-health');
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        if (!cancelled) setDigest(data.digest);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load process health');
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <V2Shell active="process-health" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div>
          <div className="eyebrow">SYSTEM · PROCESS HEALTH</div>
          <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
            Per-agent compliance digest
          </div>
          <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
            Pass/flag/auto-fix counts across the canonical hygiene checks. Top offenders surface for triage; healthy fleet means every cell is below its watermark.
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <KPICard
            label="ACTIONS · TODAY"
            value={digest ? digest.today.totalActions.toLocaleString() : '—'}
            hint={digest?.period ?? 'window pending'}
            accent
          />
          <KPICard
            label="VIOLATIONS"
            value={digest ? String(digest.today.violationsCaught) : '—'}
            hint="caught by ProcessWatcher"
          />
          <KPICard
            label="AGENTS"
            value={digest ? String(digest.agents.length) : '—'}
            hint="reporting check counts"
          />
          <KPICard
            label="OFFENDERS"
            value={digest ? String(digest.topOffenders.length) : '—'}
            hint="flagged ≥ 1×"
          />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)' }}>
            <div className="eyebrow" style={{ margin: 0 }}>TOP OFFENDERS · {digest?.topOffenders.length ?? 0}</div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Agent</th>
                <th style={{ width: 120 }}>Total flags</th>
                <th style={{ width: 220 }}>Top check</th>
                <th style={{ width: 110 }}>Severity</th>
              </tr>
            </thead>
            <tbody>
              {(digest?.topOffenders ?? []).map((o) => (
                <tr key={o.agentId}>
                  <td className="mono" style={{ fontWeight: 600 }}>{o.agentName}</td>
                  <td className="mono tabular">{o.totalFlags}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{o.topCheck}</td>
                  <td>
                    {o.topSeverity === 'critical' ? <StatusPill kind="error">critical</StatusPill>
                      : o.topSeverity === 'warn' ? <StatusPill kind="warn">warn</StatusPill>
                      : <StatusPill kind="info">info</StatusPill>}
                  </td>
                </tr>
              ))}
              {(!digest || digest.topOffenders.length === 0) && (
                <tr>
                  <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    {digest ? 'No offenders in window.' : 'Loading…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {digest && digest.agents.length > 0 && (
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)' }}>
              <div className="eyebrow" style={{ margin: 0 }}>CHECK MATRIX · {digest.agents.length} agents × {digest.checkDefinitions.length} checks</div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--bg-2)' }}>Agent</th>
                  {digest.checkDefinitions.map((c) => (
                    <th key={c.checkId} title={c.description}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {digest.agents.map((a) => (
                  <tr key={a.agentId}>
                    <td className="mono" style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', fontWeight: 600 }}>{a.agentName}</td>
                    {digest.checkDefinitions.map((c) => {
                      const cell = a.checks.find((x) => x.checkId === c.checkId);
                      const flag = cell?.flag ?? 0;
                      const pass = cell?.pass ?? 0;
                      return (
                        <td key={c.checkId}>
                          <span className="mono tabular" style={{ fontSize: 11, color: flag > 0 ? 'var(--err)' : 'var(--ink-3)' }}>
                            {flag}/{pass + flag}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </V2Shell>
  );
}
