import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const AGENTOS_URL = process.env.AGENTOS_URL ?? 'http://127.0.0.1:7710';
const TENANT_ENDPOINT = '/api/tenants';

async function postJson(url: string, body: string): Promise<any> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

async function main() {
  const payload = {
    name: 'Sgridworks Local',
    industry: 'other',
    vaultRoot: '~/vault/sgridworks-local',
  };
  const response = await postJson(`${AGENTOS_URL}${TENANT_ENDPOINT}`, JSON.stringify(payload));
  const tenantId = response.id ?? response.tenantId ?? response.tenant?.id;
  if (!tenantId) {
    console.error('Failed to get tenant ID from response');
    process.exit(1);
  }
  const home = homedir();
  const vaultRoot = resolve(home, 'vault', 'sgridworks-local', tenantId, 'wiki');
  await ensureDir(vaultRoot);
  const configPath = resolve(home, '.agentworks', 'sgridworks-local.json');
  await ensureDir(dirname(configPath));
  await writeFile(configPath, JSON.stringify({ tenantId }, null, 2));
  console.log(`Tenant ${tenantId} provisioned, vault at ${vaultRoot}`);
}

main().catch((e) => {
  console.error('Provisioning failed:', e);
  process.exit(1);
});
