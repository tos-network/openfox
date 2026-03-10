import { afterEach, describe, expect, it } from "vitest";
import { createTestConfig, createTestDb } from "./mocks.js";
import { startOperatorApiServer } from "../operator/api.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (!server) continue;
    await server.close();
  }
});

describe("operator api", () => {
  it("serves healthz without auth and protects operator endpoints", async () => {
    const db = createTestDb();
    const server = await startOperatorApiServer({
      config: createTestConfig({
        operatorApi: {
          enabled: true,
          bindHost: "127.0.0.1",
          port: 0,
          pathPrefix: "/operator",
          authToken: "secret-token",
          exposeDoctor: true,
          exposeServiceStatus: true,
        },
      }),
      db,
    });
    expect(server).not.toBeNull();
    if (!server) {
      db.close();
      return;
    }
    servers.push(server);

    const healthz = await fetch(`${server.url}/healthz`);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ ok: true });

    const unauthorized = await fetch(`${server.url}/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${server.url}/status`, {
      headers: {
        Authorization: "Bearer secret-token",
      },
    });
    expect(authorized.status).toBe(200);
    const snapshot = (await authorized.json()) as { configured: boolean; operatorApi: { enabled: boolean } | null };
    expect(snapshot.configured).toBe(true);
    expect(snapshot.operatorApi?.enabled).toBe(true);

    db.close();
  });

  it("returns 404 for disabled doctor and service status endpoints", async () => {
    const db = createTestDb();
    const server = await startOperatorApiServer({
      config: createTestConfig({
        operatorApi: {
          enabled: true,
          bindHost: "127.0.0.1",
          port: 0,
          pathPrefix: "/ops",
          authToken: "secret-token",
          exposeDoctor: false,
          exposeServiceStatus: false,
        },
      }),
      db,
    });
    expect(server).not.toBeNull();
    if (!server) {
      db.close();
      return;
    }
    servers.push(server);

    const headers = {
      Authorization: "Bearer secret-token",
    };
    const doctor = await fetch(`${server.url}/doctor`, { headers });
    expect(doctor.status).toBe(404);

    const service = await fetch(`${server.url}/service/status`, { headers });
    expect(service.status).toBe(404);

    db.close();
  });
});
