'use client';

import { useEffect, useState } from 'react';
import { V2Shell } from '@/components/v2/shell';
import { useV2Nav } from '@/components/v2/nav';
import { listTenants, type Tenant } from '@/lib/api';
import { ChevronDown } from 'lucide-react';

type RowKind = 'toggle-on' | 'toggle-off' | 'select' | 'text' | 'link' | 'readonly' | 'danger';
interface Row { label: string; value: string; kind: RowKind; }
interface Group { title: string; rows: Row[]; }

export default function SettingsV2() {
  const navigate = useV2Nav();
  const [tenant, setTenant] = useState<Tenant | null>(null);

  useEffect(() => { listTenants().then((ts) => setTenant(ts[0] ?? null)).catch(() => {}); }, []);

  const groups: Group[] = [
    {
      title: 'Tenant',
      rows: [
        { label: 'Display name', value: tenant?.name ?? '—',         kind: 'text' },
        { label: 'ID',           value: tenant?.id ?? '—',           kind: 'readonly' },
        { label: 'Vault root',   value: tenant?.vaultRoot ?? '—',    kind: 'text' },
        { label: 'Industry',     value: tenant?.industry ?? '—',     kind: 'select' },
      ],
    },
    {
      title: 'Adapters',
      rows: [
        { label: 'Claude Code', value: 'Connection state not exposed yet', kind: 'readonly' },
        { label: 'Cursor',      value: 'Connection state not exposed yet', kind: 'readonly' },
        { label: 'Codex',       value: 'Connection state not exposed yet', kind: 'readonly' },
      ],
    },
    {
      title: 'Reviewer policy',
      rows: [
        { label: 'Auto-approve threshold', value: 'Not configurable yet', kind: 'readonly' },
        { label: 'Stale escalation',       value: 'Not configurable yet', kind: 'readonly' },
        { label: 'Two-key for critical',   value: 'Not configurable yet', kind: 'readonly' },
      ],
    },
    {
      title: 'Audit',
      rows: [
        { label: 'Hash chain rotation', value: 'Quarterly',     kind: 'readonly' },
        { label: 'Evidence retention',  value: '7 years',       kind: 'readonly' },
        { label: 'NDJSON export',       value: '/export/ndjson', kind: 'readonly' },
      ],
    },
    {
      title: 'Danger zone',
      rows: [
        { label: 'Force pause all agents',     value: 'Substrate-wide kill switch',          kind: 'danger' },
        { label: 'Rotate audit signing key',   value: 'Manual rotation creates new epoch',    kind: 'danger' },
      ],
    },
  ];

  return (
    <V2Shell active="settings" onNav={navigate}>
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
        <div>
          <div className="eyebrow">SYSTEM · SETTINGS</div>
          <div className="serif" style={{ fontSize: 30, letterSpacing: '-0.018em', marginTop: 4 }}>
            Tenant configuration
          </div>
          <div style={{ color: 'var(--ink-3)', fontSize: 13, maxWidth: '62ch', marginTop: 6 }}>
            Settings are scoped to the active tenant. Changes are themselves audited — every toggle here writes an event into the ledger.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 18 }}>
          {groups.map((g) => (
            <section
              key={g.title}
              className="card"
              style={{
                padding: 0,
                overflow: 'hidden',
                gridColumn: g.title === 'Danger zone' ? '1 / -1' : undefined,
              }}
            >
              <div
                style={{
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--rule)',
                  background: g.title === 'Danger zone' ? 'var(--err-soft)' : 'transparent',
                }}
              >
                <div className="eyebrow" style={{ margin: 0, color: g.title === 'Danger zone' ? 'var(--err)' : 'var(--ink-3)' }}>
                  {g.title.toUpperCase()}
                </div>
              </div>
              {g.rows.map((r, i) => (
                <div
                  key={r.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '13px 18px',
                    borderTop: i ? '1px solid var(--rule)' : 'none',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{r.label}</div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--ink-3)',
                        marginTop: 2,
                        letterSpacing: '.02em',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.value}
                    >
                      {r.value}
                    </div>
                  </div>
                  <SettingControl kind={r.kind} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </V2Shell>
  );
}

function SettingControl({ kind }: { kind: RowKind }) {
  if (kind === 'toggle-on')  return <Toggle on />;
  if (kind === 'toggle-off') return <Toggle />;
  if (kind === 'select')     return <button className="btn btn-sm">Change <ChevronDown size={11} strokeWidth={1.6} /></button>;
  if (kind === 'text')       return <button className="btn btn-sm">Edit</button>;
  if (kind === 'link')       return <button className="btn btn-sm">Open ›</button>;
  if (kind === 'readonly')   return <span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', letterSpacing: '.06em' }}>READ-ONLY</span>;
  return <button className="btn btn-sm" style={{ borderColor: 'var(--err)', color: 'var(--err)' }}>Run…</button>;
}

function Toggle({ on }: { on?: boolean }) {
  return (
    <div
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: on ? 'var(--ink)' : 'var(--bg-2)',
        border: '1px solid var(--rule-2)',
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 1,
          left: on ? 17 : 1,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: on ? 'var(--bg)' : 'var(--ink-3)',
          transition: 'left .12s',
        }}
      />
    </div>
  );
}
