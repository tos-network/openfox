import http, { type IncomingMessage, type ServerResponse } from "http";
import type {
  OpenFoxConfig,
  OpenFoxDatabase,
  OperatorApprovalRequestRecord,
  OwnerReportPeriodKind,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import { decideOperatorApprovalRequest } from "../operator/autopilot.js";
import { renderOwnerReportHtml } from "./render.js";

const logger = createLogger("reports.server");

export interface OwnerReportServer {
  url: string;
  close(): Promise<void>;
}

function normalizePathPrefix(pathPrefix: string): string {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.end();
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const alt = req.headers["x-openfox-owner-token"];
  return typeof alt === "string" && alt.trim() ? alt.trim() : undefined;
}

function ensureAuthorized(
  req: IncomingMessage,
  token: string | undefined,
  url: URL,
): boolean {
  if (!token) return true;
  const provided = getBearerToken(req) || url.searchParams.get("token") || undefined;
  return provided === token;
}

function isPeriodKind(value: string | null): value is OwnerReportPeriodKind {
  return value === "daily" || value === "weekly";
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, string | undefined>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
          key,
          value == null ? undefined : String(value),
        ]),
      );
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function renderOwnerApprovalsHtml(params: {
  approvals: OperatorApprovalRequestRecord[];
  pathPrefix: string;
  token?: string;
  status?: string | null;
}): string {
  const tokenQuery = params.token ? `?token=${encodeURIComponent(params.token)}` : "";
  const statusLabel = params.status?.trim() || "all";
  const rows = params.approvals
    .map((approval) => {
      const approveAction = `${params.pathPrefix}/approvals/${encodeURIComponent(approval.requestId)}/approve${tokenQuery}`;
      const rejectAction = `${params.pathPrefix}/approvals/${encodeURIComponent(approval.requestId)}/reject${tokenQuery}`;
      const note = approval.reason ? `<p><strong>Reason:</strong> ${approval.reason}</p>` : "";
      const payload = approval.payload
        ? `<details><summary>Payload</summary><pre>${JSON.stringify(approval.payload, null, 2)}</pre></details>`
        : "";
      const actions =
        approval.status === "pending"
          ? `
        <form method="post" action="${approveAction}" style="display:inline-block;margin-right:8px;">
          <button type="submit">Approve</button>
        </form>
        <form method="post" action="${rejectAction}" style="display:inline-block;">
          <button type="submit">Reject</button>
        </form>`
          : `<p><strong>Decision:</strong> ${approval.status}${approval.decisionNote ? ` — ${approval.decisionNote}` : ""}</p>`;
      return `
      <article style="border:1px solid #d0d7de;border-radius:12px;padding:16px;margin:16px 0;">
        <h2 style="margin:0 0 8px 0;">${approval.kind}</h2>
        <p><strong>Request ID:</strong> ${approval.requestId}</p>
        <p><strong>Status:</strong> ${approval.status}</p>
        <p><strong>Scope:</strong> ${approval.scope}</p>
        <p><strong>Requested by:</strong> ${approval.requestedBy}</p>
        <p><strong>Expires:</strong> ${approval.expiresAt || "(none)"}</p>
        ${note}
        ${payload}
        <div style="margin-top:12px;">${actions}</div>
      </article>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenFox Approval Inbox</title>
  </head>
  <body style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:840px;margin:0 auto;padding:24px;">
    <h1>OpenFox Approval Inbox</h1>
    <p>Showing <strong>${params.approvals.length}</strong> ${statusLabel} approval request(s).</p>
    <p><a href="${params.pathPrefix}${tokenQuery}">Back to latest report</a></p>
    ${rows || "<p>No approval requests found.</p>"}
  </body>
</html>`;
}

export async function startOwnerReportServer(params: {
  config: OpenFoxConfig;
  db: OpenFoxDatabase;
}): Promise<OwnerReportServer | null> {
  if (!params.config.ownerReports?.enabled || !params.config.ownerReports.web.enabled) {
    return null;
  }

  const webConfig = params.config.ownerReports.web;
  const pathPrefix = normalizePathPrefix(webConfig.pathPrefix);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (!ensureAuthorized(req, webConfig.authToken, url)) {
          json(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && url.pathname === `${pathPrefix}/healthz`) {
          json(res, 200, { ok: true });
          return;
        }

        if (req.method === "GET" && url.pathname === pathPrefix) {
          const latest = params.db.getLatestOwnerReport("daily") || params.db.getLatestOwnerReport("weekly");
          if (!latest) {
            html(
              res,
              200,
              `<!doctype html><html><body><h1>No owner reports yet.</h1><p><a href="${pathPrefix}/approvals${webConfig.authToken ? `?token=${encodeURIComponent(webConfig.authToken)}` : ""}">Open approval inbox</a></p></body></html>`,
            );
            return;
          }
          html(res, 200, renderOwnerReportHtml(latest));
          return;
        }

        if (req.method === "GET" && url.pathname === `${pathPrefix}/reports`) {
          const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
          const periodRaw = url.searchParams.get("period");
          const periodKind = isPeriodKind(periodRaw) ? periodRaw : undefined;
          const items = params.db.listOwnerReports(limit, { periodKind });
          json(res, 200, { items });
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith(`${pathPrefix}/reports/latest/`)) {
          const periodRaw = url.pathname.slice(`${pathPrefix}/reports/latest/`.length);
          if (!isPeriodKind(periodRaw)) {
            json(res, 404, { error: "report not found" });
            return;
          }
          const report = params.db.getLatestOwnerReport(periodRaw);
          if (!report) {
            json(res, 404, { error: "report not found" });
            return;
          }
          const format = url.searchParams.get("format");
          if (format === "html") {
            html(res, 200, renderOwnerReportHtml(report));
            return;
          }
          json(res, 200, report);
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith(`${pathPrefix}/reports/`)) {
          const reportId = decodeURIComponent(url.pathname.slice(`${pathPrefix}/reports/`.length));
          const report = params.db.getOwnerReport(reportId);
          if (!report) {
            json(res, 404, { error: "report not found" });
            return;
          }
          const format = url.searchParams.get("format");
          if (format === "html") {
            html(res, 200, renderOwnerReportHtml(report));
            return;
          }
          json(res, 200, report);
          return;
        }

        if (req.method === "GET" && url.pathname === `${pathPrefix}/deliveries`) {
          const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
          const channelRaw = url.searchParams.get("channel");
          const statusRaw = url.searchParams.get("status");
          const items = params.db.listOwnerReportDeliveries(limit, {
            channel:
              channelRaw === "web" || channelRaw === "email" ? channelRaw : undefined,
            status:
              statusRaw === "pending" ||
              statusRaw === "delivered" ||
              statusRaw === "failed"
                ? statusRaw
                : undefined,
          });
          json(res, 200, { items });
          return;
        }

        if (req.method === "GET" && url.pathname === `${pathPrefix}/approvals`) {
          const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
          const statusRaw = url.searchParams.get("status");
          const status =
            statusRaw === "pending" ||
            statusRaw === "approved" ||
            statusRaw === "rejected" ||
            statusRaw === "expired"
              ? statusRaw
              : undefined;
          const items = params.db.listOperatorApprovalRequests(limit, { status });
          const format = url.searchParams.get("format");
          if (format === "json") {
            json(res, 200, { items });
            return;
          }
          html(
            res,
            200,
            renderOwnerApprovalsHtml({
              approvals: items,
              pathPrefix,
              token: webConfig.authToken,
              status: statusRaw,
            }),
          );
          return;
        }

        if (
          req.method === "POST" &&
          /^\/?.*\/approvals\/[^/]+\/(approve|reject)$/.test(url.pathname)
        ) {
          const match = url.pathname.match(/\/approvals\/([^/]+)\/(approve|reject)$/);
          if (!match) {
            json(res, 404, { error: "approval route not found" });
            return;
          }
          const [, requestId, decision] = match;
          const body = await readBody(req);
          const record = decideOperatorApprovalRequest({
            db: params.db,
            requestId: decodeURIComponent(requestId),
            status: decision === "approve" ? "approved" : "rejected",
            decidedBy: "owner-web",
            decisionNote: body.note,
          });
          const format = url.searchParams.get("format");
          if (format === "json" || req.headers.accept === "application/json") {
            json(res, 200, record);
            return;
          }
          redirect(
            res,
            `${pathPrefix}/approvals${webConfig.authToken ? `?token=${encodeURIComponent(webConfig.authToken)}` : ""}`,
          );
          return;
        }

        json(res, 404, { error: "not found" });
      } catch (error) {
        logger.warn(
          `Owner report server request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        json(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(webConfig.port, webConfig.bindHost, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve owner report server address");
  }
  return {
    url: `http://${webConfig.bindHost}:${address.port}${pathPrefix}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
