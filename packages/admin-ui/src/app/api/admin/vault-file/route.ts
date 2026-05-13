/**
 * GET /api/admin/vault-file?path=<rel>
 *
 * Reads a single .md file from the operator tenant's vault subtree and
 * returns its markdown body. The relative path is resolved against the
 * tenant root and rejected if it escapes (path traversal).
 */

import { readFileSync, statSync } from 'node:fs';
import { join, normalize, sep, isAbsolute } from 'node:path';

export const dynamic = 'force-dynamic';

const VAULT_ROOT = process.env.VAULT_ROOT;
const TENANT_ID = process.env.AGENTOS_TENANT_ID;
const MAX_BYTES = 256 * 1024;

export async function GET(req: Request): Promise<Response> {
  if (!VAULT_ROOT || !TENANT_ID) {
    return Response.json(
      { error: 'config_missing', message: 'VAULT_ROOT and AGENTOS_TENANT_ID env vars are required' },
      { status: 500 },
    );
  }
  const url = new URL(req.url);
  const rel = url.searchParams.get('path');
  if (!rel) {
    return Response.json({ error: 'missing_path' }, { status: 400 });
  }
  if (isAbsolute(rel)) {
    return Response.json({ error: 'absolute_path_rejected' }, { status: 400 });
  }
  const tenantRoot = join(VAULT_ROOT, TENANT_ID);
  const abs = normalize(join(tenantRoot, rel));
  if (!abs.startsWith(tenantRoot + sep) && abs !== tenantRoot) {
    return Response.json({ error: 'path_traversal' }, { status: 400 });
  }
  if (!abs.endsWith('.md')) {
    return Response.json({ error: 'not_markdown' }, { status: 400 });
  }
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      return Response.json({ error: 'not_a_file' }, { status: 404 });
    }
    if (st.size > MAX_BYTES) {
      return Response.json({ error: 'too_large', size: st.size, max: MAX_BYTES }, { status: 413 });
    }
    const body = readFileSync(abs, 'utf-8');
    return Response.json({
      path: rel,
      title: rel.split('/').pop()!.replace(/\.md$/i, ''),
      dir: rel.split('/').slice(0, -1).join('/') || '/',
      content: body,
      size: st.size,
      mtime: st.mtimeMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    console.error('[vault-file] failed:', message);
    return Response.json({ error: 'read_failed', message }, { status: 500 });
  }
}
