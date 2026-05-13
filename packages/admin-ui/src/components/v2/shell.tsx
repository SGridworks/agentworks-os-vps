'use client';

import { useEffect, useRef, useState, type ReactNode, Fragment } from 'react';
import clsx from 'clsx';
import {
  Radar,
  Network,
  ListChecks,
  Inbox,
  Bot,
  Shield,
  ScanSearch,
  Activity,
  Lightbulb,
  HeartPulse,
  ScrollText,
  Settings,
  Search,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Sun,
  Moon,
  Filter,
  Plane,
  type LucideIcon,
} from 'lucide-react';
import { getHealth, listTenants, type Health, type Tenant as TenantRow } from '@/lib/api';
import { useActiveTenantId, setActiveTenantId } from '@/lib/use-active-tenant';

type Theme = 'light' | 'dark';

type NavKey =
  | 'mission-control'
  | 'memory-vault'
  | 'vault-health'
  | 'approvals'
  | 'triage-queue'
  | 'agents'
  | 'rule-packs'
  | 'scanner'
  | 'process-health'
  | 'activity'
  | 'evidence'
  | 'insights'
  | 'autopilot'
  | 'map'
  | 'settings';

interface NavItem {
  k: NavKey;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

interface Tenant {
  mark: string;
  name: string;
}

interface LiveStatus {
  // Daemon health.
  health: Health | null;
  // Wall-clock of the last successful /api/health response.
  lastOkAt: number | null;
  // Polling state — replaces the old fake "WS connected" indicator.
  state: 'connecting' | 'ok' | 'stale' | 'error';
  errorMessage: string | null;
  // Tenants for the switcher; null until first load.
  tenants: TenantRow[] | null;
}

function useLiveStatus(pollMs = 5_000): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>({
    health: null,
    lastOkAt: null,
    state: 'connecting',
    errorMessage: null,
    tenants: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const h = await getHealth();
        if (cancelled) return;
        setStatus((prev) => ({
          ...prev,
          health: h,
          lastOkAt: Date.now(),
          state: 'ok',
          errorMessage: null,
        }));
        if (!status.tenants) {
          try {
            const ts = await listTenants();
            if (!cancelled) setStatus((prev) => ({ ...prev, tenants: ts }));
          } catch {
            // ignore — tenants are not critical for shell render
          }
        }
      } catch (err) {
        if (cancelled) return;
        setStatus((prev) => ({
          ...prev,
          state: prev.lastOkAt && Date.now() - prev.lastOkAt < 30_000 ? 'stale' : 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  return status;
}

function deriveMark(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '··';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

const OPERATE: NavItem[] = [
  { k: 'mission-control', label: 'Mission Control', icon: Radar },
  { k: 'memory-vault',    label: 'Memory Vault',    icon: Network },
  { k: 'vault-health',    label: 'Vault Health',    icon: HeartPulse },
  { k: 'insights',        label: 'Insights',        icon: Lightbulb },
  { k: 'autopilot',       label: 'Autopilot',       icon: Plane },
  { k: 'approvals',       label: 'Approvals',       icon: ListChecks },
  { k: 'triage-queue',    label: 'Triage Queue',    icon: Inbox },
  { k: 'agents',          label: 'Agents',          icon: Bot },
];
const GOVERN: NavItem[] = [
  { k: 'rule-packs',     label: 'Rule Packs',      icon: Shield },
  { k: 'scanner',        label: 'Scanner',         icon: ScanSearch },
  { k: 'process-health', label: 'Process Health',  icon: Activity },
  { k: 'activity',       label: 'Activity Log',    icon: Activity },
  { k: 'evidence',       label: 'Evidence Report', icon: ScrollText },
];
const SYSTEM: NavItem[] = [
  { k: 'settings', label: 'Settings', icon: Settings },
];

/* ============================================================
   V2Shell — combines Sidebar + TopBar + main content
   ============================================================ */

export function V2Shell({
  children,
  active,
  onNav,
  tenant: tenantProp,
  triageCount = 0,
  initialTheme = 'dark',
}: {
  children: ReactNode;
  active: NavKey;
  onNav: (k: NavKey) => void;
  /** Override the auto-loaded tenant (rare — most callers omit this). */
  tenant?: Tenant;
  triageCount?: number;
  initialTheme?: Theme;
  /** @deprecated — version is now read live from /api/health. Ignored. */
  substrateVersion?: string;
}) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return initialTheme;
    const saved = window.localStorage.getItem('awo-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return initialTheme;
  });
  const [collapsed, setCollapsed] = useState(false);
  const live = useLiveStatus();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('awo-theme', theme);
    }
  }, [theme]);

  // Active-tenant id persists in localStorage; default to the newest tenant
  // (the API returns ORDER BY createdAt DESC). The TopBar dropdown writes
  // back via setActiveTenantId, which fires a storage event consumers listen for.
  const activeTenantId = useActiveTenantId();
  useEffect(() => {
    if (!activeTenantId && live.tenants && live.tenants[0]) {
      setActiveTenantId(live.tenants[0].id);
    }
  }, [activeTenantId, live.tenants]);

  const liveTenant: Tenant | null = (() => {
    if (tenantProp) return tenantProp;
    const list = live.tenants ?? [];
    const picked = list.find((t) => t.id === activeTenantId) ?? list[0];
    if (!picked) return null;
    return { name: picked.name, mark: deriveMark(picked.name) };
  })();
  const displayTenant: Tenant = liveTenant ?? { name: 'Loading…', mark: '··' };
  const substrateVersion = live.health ? `v${live.health.version}` : '—';

  return (
    <div className="shell">
      <Sidebar
        active={active}
        onNav={onNav}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        triageCount={triageCount}
        substrateVersion={substrateVersion}
        liveState={live.state}
      />
      <div className="main">
        <TopBar
          tenant={displayTenant}
          theme={theme}
          onTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          live={live}
        />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================
   Sidebar — three-section nav (Operate / Govern / System)
   Brand mark: Line Gate, recolors with theme via CSS variables
   ============================================================ */

export function Sidebar({
  active,
  onNav,
  collapsed,
  onToggle,
  triageCount = 0,
  substrateVersion = '—',
  liveState = 'connecting',
}: {
  active: NavKey;
  onNav: (k: NavKey) => void;
  collapsed: boolean;
  onToggle: () => void;
  triageCount?: number;
  substrateVersion?: string;
  liveState?: 'connecting' | 'ok' | 'stale' | 'error';
}) {
  const renderItem = (it: NavItem) => {
    const Icon = it.icon;
    const badge = it.k === 'triage-queue' && triageCount > 0 ? triageCount : it.badge;
    return (
      <a
        key={it.k}
        className={clsx('sidebar-link', active === it.k && 'active')}
        onClick={() => onNav(it.k)}
        title={collapsed ? it.label : undefined}
      >
        <Icon strokeWidth={1.6} />
        {!collapsed && <span className="sidebar-link-label">{it.label}</span>}
        {!collapsed && badge ? <span className="badge">{badge}</span> : null}
      </a>
    );
  };

  return (
    <aside className={clsx('sidebar', collapsed && 'collapsed')}>
      <div className="sidebar-brand">
        <BrandMark />
        {!collapsed && <span className="sidebar-brand-text">AgentWorks</span>}
      </div>

      {!collapsed && <div className="sidebar-section-label">Operate</div>}
      <nav className="sidebar-nav">
        {OPERATE.map(renderItem)}
        {!collapsed && <div className="sidebar-section-label">Govern</div>}
        {GOVERN.map(renderItem)}
        {!collapsed && <div className="sidebar-section-label">System</div>}
        {SYSTEM.map(renderItem)}
      </nav>

      <div className="sidebar-foot">
        <span
          className={clsx(
            'dot',
            liveState === 'ok' && 'dot-success dot-pulse',
            liveState === 'stale' && 'dot-warn',
            liveState === 'error' && 'dot-err',
            liveState === 'connecting' && 'dot-info',
          )}
        />
        {!collapsed && <>SUBSTRATE · {substrateVersion}</>}
        <button
          onClick={onToggle}
          className="icon-btn"
          style={{ marginLeft: collapsed ? 0 : 'auto' }}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight strokeWidth={1.6} /> : <ChevronLeft strokeWidth={1.6} />}
        </button>
      </div>
    </aside>
  );
}

/* ============================================================
   TopBar — tenant switcher, ⌘K palette trigger, status, theme
   ============================================================ */

export function TopBar({
  tenant,
  onTheme,
  theme,
  live,
}: {
  tenant: Tenant;
  onTheme: () => void;
  theme: Theme;
  live: LiveStatus;
}) {
  const tenants = live.tenants ?? [];
  const multiTenant = tenants.length > 1;
  const substrateVersion = live.health ? `v${live.health.version}` : '—';
  const lastOkRel = live.lastOkAt
    ? `${Math.max(0, Math.round((Date.now() - live.lastOkAt) / 1000))}s ago`
    : 'never';
  const stateLabel: Record<LiveStatus['state'], string> = {
    connecting: 'CONNECTING',
    ok: 'POLLING · 5s',
    stale: 'STALE · retrying',
    error: 'OFFLINE',
  };

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const activeTenantId = useActiveTenantId();
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setPickerOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [pickerOpen]);

  return (
    <header className="topbar">
      <div ref={pickerRef} style={{ position: 'relative' }}>
        <button
          className="tenant-switcher"
          title={
            multiTenant
              ? 'Switch tenant'
              : tenants[0]
              ? `Single tenant · ${tenants[0].id.slice(0, 8)}`
              : 'No tenants registered yet'
          }
          disabled={!multiTenant}
          onClick={() => multiTenant && setPickerOpen((o) => !o)}
          style={{ cursor: multiTenant ? 'pointer' : 'default', opacity: tenants.length ? 1 : 0.7 }}
        >
          <span className="tenant-mark">{tenant.mark}</span>
          <span style={{ fontWeight: 500 }}>{tenant.name}</span>
          {multiTenant && <ChevronDown size={13} strokeWidth={1.6} />}
        </button>
        {pickerOpen && (
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              minWidth: 240,
              background: 'var(--surface-2, #1a1a1f)',
              border: '1px solid var(--border, #2a2a32)',
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              zIndex: 50,
              padding: 4,
            }}
          >
            {tenants.map((t) => {
              const isActive = t.id === activeTenantId;
              return (
                <button
                  key={t.id}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveTenantId(t.id);
                    setPickerOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 10px',
                    background: isActive ? 'var(--surface-hover, #25252d)' : 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'var(--surface-hover, #25252d)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span className="tenant-mark">{deriveMark(t.name)}</span>
                  <span style={{ flex: 1 }}>{t.name}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.5 }}>
                    {t.id.slice(0, 8)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="cmdk" title="Command palette is not yet wired (Cmd+K coming)">
        <Search size={14} strokeWidth={1.6} />
        <span>Search companies, agents, issues, vault notes…</span>
        <span className="cmdk-shortcut mono">⌘K</span>
      </div>
      <div className="topbar-status">
        <span
          className="item"
          title={
            live.health
              ? `daemon ${live.health.version} · started ${live.health.startedAt}`
              : (live.errorMessage ?? 'unknown daemon state')
          }
        >
          <span
            className={clsx(
              'dot',
              live.state === 'ok' && 'dot-success dot-pulse',
              live.state === 'stale' && 'dot-warn',
              live.state === 'error' && 'dot-err',
              live.state === 'connecting' && 'dot-info',
            )}
          />{' '}
          <b>SUBSTRATE</b> {substrateVersion}
        </span>
        <span className="item" title={`Last OK ${lastOkRel}`}>
          <span
            className={clsx(
              'dot',
              live.state === 'ok' ? 'dot-info' : live.state === 'stale' ? 'dot-warn' : 'dot-err',
            )}
          />{' '}
          <b>{stateLabel[live.state]}</b>
        </span>
      </div>
      <button className="icon-btn" onClick={onTheme} aria-label="Toggle theme">
        {theme === 'dark' ? <Sun strokeWidth={1.6} /> : <Moon strokeWidth={1.6} />}
      </button>
      <div className="avatar" title={tenant.name}>{tenant.mark}</div>
    </header>
  );
}

/* ============================================================
   Breadcrumb
   ============================================================ */

export function Breadcrumb({ items = [] }: { items?: string[] }) {
  return (
    <div className="breadcrumb">
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight strokeWidth={1.6} />}
          <a>{it}</a>
        </Fragment>
      ))}
    </div>
  );
}

/* ============================================================
   EmptyState
   ============================================================ */

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '48px 24px',
        border: '1px dashed var(--rule-2)',
        borderRadius: 2,
        background: 'var(--bg-card)',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          margin: '0 auto 14px',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-3)',
        }}
      >
        <Icon size={22} strokeWidth={1.6} />
      </div>
      <div className="serif" style={{ fontSize: 18, marginBottom: 6 }}>
        {title}
      </div>
      <div
        style={{
          color: 'var(--ink-3)',
          fontSize: 13,
          maxWidth: '40ch',
          margin: '0 auto 18px',
        }}
      >
        {body}
      </div>
      {action}
    </div>
  );
}

/* ============================================================
   FilterBar
   ============================================================ */

export type FilterOption = { value: string; label: string };
export type FilterDef = {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
};

export function FilterBar({
  filters = [],
  onClear,
}: {
  filters?: FilterDef[];
  onClear?: () => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openIndex === null) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpenIndex(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenIndex(null);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openIndex]);

  return (
    <div ref={rootRef} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          padding: '0 8px',
          color: 'var(--ink-3)',
        }}
      >
        <Filter size={14} strokeWidth={1.6} />
        <span
          className="mono"
          style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}
        >
          Filter
        </span>
      </span>
      {filters.map((f, i) => {
        const current = f.options.find((o) => o.value === f.value);
        const display = current?.label ?? f.value;
        const open = openIndex === i;
        return (
          <div key={f.label} style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-sm"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpenIndex(open ? null : i)}
              style={{ height: 28, gap: 6 }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: 'var(--ink-3)',
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                }}
              >
                {f.label}
              </span>
              <span style={{ fontWeight: 500 }}>{display}</span>
              <ChevronDown size={12} strokeWidth={1.6} />
            </button>
            {open && (
              <ul
                role="listbox"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 20,
                  minWidth: '100%',
                  margin: 0,
                  padding: 4,
                  listStyle: 'none',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  boxShadow: '0 6px 20px rgba(0,0,0,.18)',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.options.map((opt) => {
                  const selected = opt.value === f.value;
                  return (
                    <li key={opt.value}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          f.onChange(opt.value);
                          setOpenIndex(null);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 10px',
                          fontSize: 12,
                          background: selected ? 'var(--bg-2)' : 'transparent',
                          color: 'var(--ink)',
                          border: 'none',
                          cursor: 'pointer',
                          borderRadius: 2,
                        }}
                      >
                        {opt.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      <button className="btn btn-ghost btn-sm" onClick={onClear} style={{ color: 'var(--ink-3)' }}>
        Clear
      </button>
    </div>
  );
}

/* ============================================================
   BrandMark — Line Gate logo (1A) inlined as SVG
   Re-tints with theme via CSS variables (--ink, --accent, --warn)
   Source: brand/logo-pack/selected/svg/mark-default-*.svg
   ============================================================ */

function BrandMark() {
  return (
    <span
      className="sidebar-brand-mark"
      style={{
        background: 'transparent',
        color: 'inherit',
      }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width="22" height="22" fill="none">
        <path
          d="M7 27V9.5C7 7.6 8.6 6 10.5 6H21.5C23.4 6 25 7.6 25 9.5V27"
          stroke="var(--ink)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M10 27H22" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 8V24" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="16" cy="12" r="1.6" fill="var(--accent)" />
        <circle cx="16" cy="19" r="1.6" fill="var(--accent)" />
        <path d="M5 13L2.8 13" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M29.2 13L27 13" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="7" cy="27" r="1.2" fill="var(--warn)" />
        <circle cx="25" cy="27" r="1.2" fill="var(--warn)" />
      </svg>
    </span>
  );
}
