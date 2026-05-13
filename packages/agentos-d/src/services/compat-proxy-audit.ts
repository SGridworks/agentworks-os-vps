import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { compatProxyEvents, type NewCompatProxyEventRow } from "../db/schema.js";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CompatProxyAuditInput {
  method: string;
  path: string;
  statusCode?: number;
  requestBody: string;
  responseBody?: Buffer;
  runId?: string;
  forwardedTo: string;
  error?: string;
}

export function recordCompatProxyEvent(input: CompatProxyAuditInput): string {
  const id = randomUUID();
  const responseBody = input.responseBody ?? Buffer.alloc(0);
  const row: NewCompatProxyEventRow = {
    id,
    method: input.method,
    path: input.path,
    statusCode: input.statusCode ?? null,
    requestHash: sha256(input.requestBody),
    responseHash: input.responseBody ? sha256(input.responseBody) : null,
    requestBytes: Buffer.byteLength(input.requestBody),
    responseBytes: responseBody.byteLength,
    runId: input.runId ?? null,
    forwardedTo: input.forwardedTo,
    error: input.error ?? null,
    createdAt: new Date().toISOString(),
  };

  getDb().insert(compatProxyEvents).values(row).run();
  return id;
}
