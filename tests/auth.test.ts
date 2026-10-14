import { it, expect, describe, beforeAll, afterAll } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";

// Sign-in mode is exercised by flipping the singleton flag; every other test
// file runs with it off, and vitest isolates files so this cannot leak.
const store = new MemoryStore();
let app: Awaited<ReturnType<typeof createApp>>;
beforeAll(async () => {
  config.requireLogin = true;
  app = await createApp(store);
});
afterAll(() => {
  config.requireLogin = false;
});

const cookie = (r: any) =>
  String(r.headers["set-cookie"] || "").match(/hf_session=([^;]+)/)?.[1];
const as = async (c: string, method: string, url: string, payload?: any) =>
  (await app.inject({
    method: method as any,
    url,
    payload,
    headers: { cookie: `hf_session=${c}` },
  })) as any;
let ann = "",
  ben = "",
  ws = "";

describe("sign-in mode", () => {
  it("rejects unauthenticated requests", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toContain("Sign in");
  });

  it("reports the mode and that bootstrap is open", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/auth/mode" });
    expect(r.json()).toEqual({ requireLogin: true, bootstrap: true });
  });

  it("bootstraps the first user into an owned workspace", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { name: "Ann", email: "ann@corp.test", password: "password-1" },
    });
    expect(r.statusCode).toBe(200);
    ann = cookie(r)!;
    expect(ann).toBeTruthy();
    const me = await as(ann, "GET", "/api/v1/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("ann@corp.test");
    ws = me.json().workspaces[0].id;
    expect(ws).toBeTruthy();
  });

  it("refuses a second bootstrap", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: { name: "B", email: "b@corp.test", password: "password-1" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("rejects a wrong password, accepts the right one", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ann@corp.test", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ann@corp.test", password: "password-1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe("ann@corp.test");
  });

  it("lets an owner add a member who can then sign in", async () => {
    const add = await as(ann, "POST", `/api/v1/workspaces/${ws}/members`, {
      email: "ben@corp.test",
      name: "Ben",
      role: "viewer",
      password: "password-2",
    });
    expect(add.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ben@corp.test", password: "password-2" },
    });
    expect(login.statusCode).toBe(200);
    ben = cookie(login)!;
    const me = await as(ben, "GET", "/api/v1/me");
    expect(me.json().workspaces).toEqual([
      { id: ws, name: "My workspace", role: "viewer" },
    ]);
  });

  it("blocks member management for non-owners", async () => {
    const r = await as(ben, "POST", `/api/v1/workspaces/${ws}/members`, {
      email: "c@corp.test",
      role: "viewer",
      password: "password-3",
    });
    expect(r.statusCode).toBe(403);
  });

  it("protects the last owner", async () => {
    const annId = (await as(ann, "GET", "/api/v1/me")).json().user.id;
    const demote = await as(
      ann,
      "PATCH",
      `/api/v1/workspaces/${ws}/members/${annId}`,
      { role: "viewer" },
    );
    expect(demote.statusCode).toBe(400);
    expect(demote.json().error).toContain("at least one owner");
    const remove = await as(
      ann,
      "DELETE",
      `/api/v1/workspaces/${ws}/members/${annId}`,
    );
    expect(remove.statusCode).toBe(400);
  });

  it("changes a password and keeps the old session working", async () => {
    const r = await as(ann, "POST", "/api/v1/auth/password", {
      current: "password-1",
      next: "password-1b",
    });
    expect(r.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ann@corp.test", password: "password-1b" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("invalidates the session on logout", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ann@corp.test", password: "password-1b" },
    });
    const c = cookie(login)!;
    expect((await as(c, "GET", "/api/v1/me")).statusCode).toBe(200);
    await as(c, "POST", "/api/v1/auth/logout");
    expect((await as(c, "GET", "/api/v1/me")).statusCode).toBe(401);
  });
});
