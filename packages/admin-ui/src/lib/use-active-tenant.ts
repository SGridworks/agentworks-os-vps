'use client';

import { useEffect, useState } from 'react';
import { listTenants, type Tenant } from './api';

const STORAGE_KEY = 'awo-active-tenant-id';
const CHANGE_EVENT = 'awo-tenant-changed';

export function getStoredTenantId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setActiveTenantId(id: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { id } }));
}

export function useActiveTenantId(): string | null {
  const [id, setId] = useState<string | null>(() => getStoredTenantId());

  useEffect(() => {
    const onChange = () => setId(getStoredTenantId());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return id;
}

export function useActiveTenant(): {
  tenant: Tenant | null;
  tenants: Tenant[];
  loading: boolean;
} {
  const activeId = useActiveTenantId();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listTenants()
      .then((ts) => {
        if (cancelled) return;
        setTenants(ts);
        if (!getStoredTenantId() && ts[0]) {
          setActiveTenantId(ts[0].id);
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const tenant =
    tenants.find((t) => t.id === activeId) ?? tenants[0] ?? null;
  return { tenant, tenants, loading };
}
