import type React from 'react';
import { useState } from 'react';

export function Card({
  title,
  children,
  flush,
  action,
}: {
  title: string;
  children: React.ReactNode;
  flush?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--rule)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div className="eyebrow" style={{ margin: 0 }}>{title}</div>
        {action}
      </div>
      <div style={{ padding: flush ? 0 : 16, display: 'flex', flexDirection: 'column', gap: flush ? 0 : 6 }}>
        {children}
      </div>
    </div>
  );
}

export function KVInput({
  k, v, onChange, mono, placeholder, inputMode,
}: {
  k: string;
  v: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, alignItems: 'center' }}>
      <span className="eyebrow" style={{ margin: 0, flex: '0 0 auto' }}>{k}</span>
      <input
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={mono ? 'mono' : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: 'right',
          background: 'var(--bg-2)',
          color: 'var(--ink)',
          border: '1px solid var(--rule)',
          borderRadius: 2,
          padding: '4px 8px',
          fontSize: mono ? 11 : 12,
        }}
      />
    </div>
  );
}

export function KVSelect({
  k, v, onChange, options,
}: {
  k: string;
  v: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, alignItems: 'center' }}>
      <span className="eyebrow" style={{ margin: 0 }}>{k}</span>
      <select
        value={v}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--bg-2)',
          color: 'var(--ink)',
          border: '1px solid var(--rule)',
          borderRadius: 2,
          padding: '4px 8px',
          fontSize: 12,
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function KV({
  k, v, mono, valueColor,
}: { k: string; v: string; mono?: boolean; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, alignItems: 'baseline' }}>
      <span className="eyebrow" style={{ margin: 0 }}>{k}</span>
      <span
        className={mono ? 'mono' : undefined}
        style={{ color: valueColor ?? 'var(--ink-2)', fontSize: mono ? 11 : 12, textAlign: 'right', wordBreak: 'break-all' }}
      >
        {v}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 12 }}>
      {children}
    </div>
  );
}

/**
 * Render the first `defaultLimit` items of `items`, then a "View all N" toggle
 * if there are more. Used by Inbox/Revisions/Wakeups/Task-sessions tables on
 * the agent detail page so they don't bury the rest of the page when long.
 */
export function ExpandableRows<T>({
  items,
  defaultLimit = 5,
  renderRow,
  noun = 'rows',
}: {
  items: T[];
  defaultLimit?: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  noun?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, defaultLimit);
  const hidden = items.length - visible.length;
  return (
    <>
      {visible.map((item, i) => renderRow(item, i))}
      {hidden > 0 && (
        <tr>
          <td
            colSpan={99}
            style={{
              padding: '6px 16px',
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--ink-3)',
              cursor: 'pointer',
              borderTop: '1px dashed var(--rule)',
              background: 'var(--bg-2)',
            }}
            onClick={() => setExpanded(true)}
            className="mono"
          >
            View all {items.length} {noun} ↓
          </td>
        </tr>
      )}
      {expanded && items.length > defaultLimit && (
        <tr>
          <td
            colSpan={99}
            style={{
              padding: '6px 16px',
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--ink-3)',
              cursor: 'pointer',
              borderTop: '1px dashed var(--rule)',
              background: 'var(--bg-2)',
            }}
            onClick={() => setExpanded(false)}
            className="mono"
          >
            Collapse ↑
          </td>
        </tr>
      )}
    </>
  );
}

export function prioColor(p: string): string {
  if (p === 'critical') return 'var(--err)';
  if (p === 'high') return 'var(--warn)';
  if (p === 'medium') return 'var(--accent)';
  return 'var(--ink-3)';
}
