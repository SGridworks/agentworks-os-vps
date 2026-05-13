'use client';

import { useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { KPICard, StatusPill } from '@/components/v2/primitives';
import {
  listTenants,
  listEvidenceReports,
  generateEvidenceReport,
  type EvidenceReportRow,
} from '@/lib/api';
import { Copy, Download } from 'lucide-react';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function EvidenceV2() {
  const navigate = useV2Nav();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [rows, setRows] = useState<EvidenceReportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showGen, setShowGen] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    listTenants().then((ts) => setTenantId(ts[0]?.id ?? null)).catch((e) => setError(String(e)));
  }, []);

  async function load(tid: string) {
    try {
      const res = await listEvidenceReports(tid);
      setRows(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reports');
    }
  }
  useEffect(() => { if (tenantId) load(tenantId); }, [tenantId]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !periodStart || !periodEnd) {
      setError('Tenant + period dates required');
      return;
    }
    setGenerating(true);
    try {
      await generateEvidenceReport({ tenantId, periodStart, periodEnd });
      setShowGen(false);
      await load(tenantId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generate failed');
    } finally {
      setGenerating(false);
    }
  }

  const totalBytes = rows.reduce((s, r) => s + r.pdfByteLength, 0);
  const sealed = rows.filter((r) => r.status === 'complete').length;

  return (
    <V2Shell active="evidence" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div className="eyebrow">GOVERN · EVIDENCE REPORT</div>
            <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
              Hash-chained evidence bundles
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '.04em' }}>
              {rows.length} bundle{rows.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)} · {sealed} sealed
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setShowGen((s) => !s)}>
              {showGen ? 'Cancel' : 'Generate bundle'}
            </button>
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}

        {showGen && (
          <form onSubmit={generate} className="card" style={{ padding: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>NEW BUNDLE</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="eyebrow">Period start</span>
                <input className="form-input" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="eyebrow">Period end</span>
                <input className="form-input" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
              </label>
              <button type="submit" className="btn btn-primary" disabled={generating}>
                {generating ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </form>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
          <KPICard label="BUNDLES" value={String(rows.length)} hint={`${sealed} sealed · ${rows.length - sealed} other`} accent />
          <KPICard label="TOTAL SIZE" value={fmtBytes(totalBytes)} hint="across this tenant" />
          <KPICard label="LATEST" value={rows[0] ? rows[0].periodEnd.slice(0, 10) : '—'} hint={rows[0] ? `signed ${rows[0].signedAt?.slice(0, 10) ?? '—'}` : 'no bundles yet'} />
          <KPICard label="ENGINE" value={rows[0]?.engineName ?? '—'} hint="last bundle generator" />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)' }}>
            <div className="eyebrow" style={{ margin: 0 }}>BUNDLES · {rows.length}</div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Period</th>
                <th style={{ width: 110 }}>Generated</th>
                <th style={{ width: 100 }}>Size</th>
                <th style={{ width: 130 }}>Engine</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono tabular">{r.periodStart.slice(0, 10)} → {r.periodEnd.slice(0, 10)}</td>
                  <td className="mono tabular" style={{ color: 'var(--ink-3)' }}>{r.generatedAt.slice(0, 10)}</td>
                  <td className="mono tabular">{fmtBytes(r.pdfByteLength)}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>{r.engineName}</td>
                  <td>
                    {r.status === 'complete'
                      ? <StatusPill kind="success">Sealed</StatusPill>
                      : <StatusPill kind="error">Failed</StatusPill>}
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      title={r.pdfHash ?? 'no hash'}
                      onClick={() => r.pdfHash && navigator.clipboard.writeText(r.pdfHash)}
                      disabled={!r.pdfHash}
                    >
                      <Copy size={12} strokeWidth={1.6} />Hash
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                    No evidence bundles. Generate one with the agentos-d CLI or trigger a compliance report from the API.
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
