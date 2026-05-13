/**
 * WebSocket broadcast server for real-time approval queue events.
 *
 * Mounted alongside the HTTP server so the admin-ui inbox lights up
 * in <2s after a POST /api/approval-queue/:id/review.
 *
 * Clients connect to ws://<host>:<port>/ws and receive JSON events:
 *   { type: "approval_reviewed", approvalQueueId: string, status: string }
 *
 * Security: this deployment uses a transparent proxy in front of agentos-d,
 * so we rely on the upstream auth layer rather than adding our own.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";

export interface ApprovalReviewedEvent {
  type: "approval_reviewed";
  approvalQueueId: string;
  status: "approved" | "rejected" | "returned";
  reviewedBy: string;
  reviewedAt: string;
}

export interface ApprovalEnqueuedEvent {
  type: "approval_enqueued";
  approvalQueueId: string;
  tenantId: string;
  actorLabel: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decisionReason: string;
  enqueuedAt: string;
}

let wss: WebSocketServer | null = null;

/**
 * Start the WebSocket server on the same HTTP server as Express.
 * Safe to call multiple times (idempotent).
 */
export function startWebSocketServer(httpServer: Server): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    // Ping to keep connection alive (prevents proxy idle-drop)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on("close", () => clearInterval(pingInterval));
    ws.on("error", () => clearInterval(pingInterval));
  });

  return wss;
}

/**
 * Broadcast an event to all connected WebSocket clients.
 * No-op if no clients are connected.
 */
export function broadcast(
  event: ApprovalReviewedEvent | ApprovalEnqueuedEvent,
): void {
  if (!wss) return;

  const payload = JSON.stringify(event);
  for (const client of Array.from(wss.clients)) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
