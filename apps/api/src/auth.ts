// Sign-in for multi-person deployments. REQUIRE_LOGIN=true switches the API
// from the single-computer local identity to real users: a password login sets
// an HttpOnly session cookie (and returns the token for scripts), owners
// manage workspace members, and the first user is created through
// /auth/bootstrap when no password user exists yet.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Resource } from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { assert, digest } from "./security.js";
import { resource, transaction, type Store } from "./store.js";

const SESSION_COOKIE = "hf_session",
  SESSION_DAYS = 7;

// scrypt is built into Node; the salt travels inside the stored hash.
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("base64url")}`;
}
export function verifyPassword(password: string, stored: string) {
  const m = /^scrypt:([A-Za-z0-9_-]+):([A-Za-z0-9_/-]+)$/.exec(stored || "");
  if (!m) return false;
  const expected = Buffer.from(m[2], "base64url"),
    actual = scryptSync(password, m[1], 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const sessionCookie = (req: any) =>
  typeof req.cookies?.[SESSION_COOKIE] === "string" &&
  req.cookies[SESSION_COOKIE]
    ? (req.cookies[SESSION_COOKIE] as string)
    : undefined;

// Users are addressed by a digest of their lowercased email, which keeps
// email unique across the installation.
const userId = (email: string) => "usr_" + digest(email).slice(0, 32);
const passwordUsers = async (store: Store) =>
  (await store.list("global", "user")).filter((u) => u.data.passwordHash);
const userJson = (u: Resource) => ({
  id: u.id,
  name: u.name,
  email: u.data.email,
});

async function issueSession(store: Store, id: string, reply: any) {
  const raw = randomBytes(48).toString("base64url");
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource(
        "global",
        "session",
        "Sign-in",
        { userId: id, expiresAt: Date.now() + SESSION_DAYS * 86400_000 },
        digest(raw),
      ),
    ),
  );
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
    secure: config.origin.startsWith("https:"),
  });
}

// Security-relevant events land in the global audit log. Passwords, tokens
// and other secrets are never part of a detail payload.
async function audit(
  store: Store,
  action: string,
  actor: string,
  detail: Record<string, unknown> = {},
) {
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource("global", "audit", action, {
        actor,
        ...detail,
      }),
    ),
  );
}

export function registerAuth(
  app: FastifyInstance,
  opts: {
    store: Store;
    user: (req: any) => Promise<{ user: Resource; session: Resource }>;
    access: (
      req: any,
      min?: "viewer" | "editor" | "owner",
    ) => Promise<{ user: Resource; session: Resource; scope: string }>;
    newWorkspace: (
      owner: Resource,
      name: string,
    ) => Promise<{ id: string; name: string }>;
  },
) {
  const { store, user, access, newWorkspace } = opts;
  const loginLimiter = { rateLimit: { max: 10, timeWindow: "1 minute" } };
  const credentials = z.object({
    email: z.email().max(320).transform((e) => e.toLowerCase()),
    password: z.string().min(1).max(1000),
  });

  app.get("/api/v1/auth/mode", async () => ({
    requireLogin: config.requireLogin,
    bootstrap:
      config.requireLogin && (await passwordUsers(store)).length === 0,
  }));

  app.post(
    "/api/v1/auth/login",
    { config: loginLimiter },
    async (req, reply) => {
      const b = credentials.parse(req.body),
        u = (await store.list("global", "user")).find(
          (x) => String(x.data.email || "").toLowerCase() === b.email,
        );
      if (!u?.data.passwordHash || !verifyPassword(b.password, u.data.passwordHash)) {
        await audit(store, "login_failed", b.email).catch(() => {});
        assert(false, "Email or password is incorrect", 401);
      }
      await audit(store, "login", u.id);
      await issueSession(store, u.id, reply);
      return { user: userJson(u) };
    },
  );

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const raw =
      sessionCookie(req) ||
      /^Bearer (.+)$/.exec(String(req.headers.authorization || ""))?.[1];
    if (raw)
      await transaction(store, "global", async (tx) => {
        const s = await tx.get(digest(raw));
        if (s?.kind === "session") tx.delete(s.id);
      });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // The first sign-in: only while no password user exists. Creates the user,
  // a workspace they own, and their session.
  app.post("/api/v1/auth/bootstrap", async (req, reply) => {
    assert(
      config.requireLogin,
      "Sign-in is not enabled on this installation",
      400,
    );
    assert((await passwordUsers(store)).length === 0, "Already set up", 409);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        email: z.email().max(320).transform((e) => e.toLowerCase()),
        password: z.string().min(8).max(200),
      })
      .parse(req.body),
      u = resource(
        "global",
        "user",
        b.name,
        { email: b.email, passwordHash: hashPassword(b.password) },
        userId(b.email),
      );
    await transaction(store, "global", async (tx) => tx.put(u));
    const workspace = await newWorkspace(u, "My workspace");
    await audit(store, "bootstrap", u.id, { email: b.email });
    await issueSession(store, u.id, reply);
    return { user: userJson(u), workspace };
  });

  app.post("/api/v1/auth/password", async (req) => {
    const a = await user(req);
    assert(
      a.session.kind === "session" && a.user.data.passwordHash,
      "Password change needs a signed-in password user",
      403,
    );
    const b = z
      .object({
        current: z.string().min(1).max(1000),
        next: z.string().min(8).max(200),
      })
      .parse(req.body);
    assert(
      verifyPassword(b.current, a.user.data.passwordHash),
      "Current password is incorrect",
      403,
    );
    await transaction(store, "global", async (tx) => {
      const u = await tx.get(a.user.id);
      if (u)
        tx.update(u, { ...u.data, passwordHash: hashPassword(b.next) });
    });
    await audit(store, "password_change", a.user.id);
    return { ok: true };
  });

  // Member management is owner-only; members can read the list.
  const members = async (scope: string) =>
    (await store.list("global", "member")).filter(
      (m) => m.data.workspaceId === scope,
    );

  app.get("/api/v1/workspaces/:w/members", async (req) => {
    const a = await access(req);
    return {
      members: await Promise.all(
        (await members(a.scope)).map(async (m) => {
          const u = await store.get("global", m.data.userId);
          return {
            userId: m.data.userId,
            name: u?.name || m.name,
            email: u?.data.email,
            role: m.data.role,
          };
        }),
      ),
    };
  });

  app.post("/api/v1/workspaces/:w/members", async (req) => {
    const a = await access(req, "owner");
    const b = z
      .object({
        email: z.email().max(320).transform((e) => e.toLowerCase()),
        name: z.string().trim().min(1).max(100).optional(),
        role: z.enum(["viewer", "editor", "owner"]),
        // Needed only when the email belongs to nobody yet.
        password: z.string().min(8).max(200).optional(),
      })
      .parse(req.body),
      id = userId(b.email);
    const added = await transaction(store, "global", async (tx) => {
      let u = await tx.get(id);
      if (!u) {
        assert(
          b.password,
          "This email is new — set a password for their first sign-in",
          400,
        );
        u = tx.put(
          resource(
            "global",
            "user",
            b.name || b.email,
            { email: b.email, passwordHash: hashPassword(b.password) },
            id,
          ),
        );
      }
      const key = `${u.id}:${a.scope}`;
      assert(!(await tx.get(key)), "Already a member", 409);
      tx.put(
        resource(
          "global",
          "member",
          u.name,
          { userId: u.id, role: b.role, workspaceId: a.scope },
          key,
        ),
      );
      return u;
    });
    await audit(store, "member_add", a.user.id, {
      workspaceId: a.scope,
      userId: added.id,
      role: b.role,
    });
    return { user: userJson(added), role: b.role };
  });

  const member = (list: Resource[], userId: string) => {
    const m = list.find((x) => x.data.userId === userId);
    assert(m, "Member not found", 404);
    return m;
  };
  const lastOwner = (list: Resource[]) =>
    assert(
      list.filter((x) => x.data.role === "owner").length > 1,
      "The workspace needs at least one owner",
      400,
    );

  app.patch("/api/v1/workspaces/:w/members/:userId", async (req: any) => {
    const a = await access(req, "owner"),
      b = z
        .object({ role: z.enum(["viewer", "editor", "owner"]) })
        .parse(req.body),
      list = await members(a.scope),
      m = member(list, req.params.userId);
    if (m.data.role === "owner" && b.role !== "owner") lastOwner(list);
    await transaction(store, "global", async (tx) => {
      const cur = await tx.get(`${req.params.userId}:${a.scope}`);
      if (cur) tx.update(cur, { ...cur.data, role: b.role });
    });
    await audit(store, "member_role", a.user.id, {
      workspaceId: a.scope,
      userId: req.params.userId,
      role: b.role,
    });
    return { ok: true };
  });

  app.delete("/api/v1/workspaces/:w/members/:userId", async (req: any) => {
    const a = await access(req, "owner"),
      list = await members(a.scope),
      m = member(list, req.params.userId);
    if (m.data.role === "owner") lastOwner(list);
    await transaction(store, "global", async (tx) => {
      const cur = await tx.get(m.id);
      if (cur) tx.delete(cur.id);
    });
    await audit(store, "member_remove", a.user.id, {
      workspaceId: a.scope,
      userId: m.data.userId,
    });
    return { ok: true };
  });

  // Owners read their workspace's security events, newest first.
  app.get("/api/v1/workspaces/:w/audit", async (req) => {
    const a = await access(req, "owner");
    const rows = (await store.list("global", "audit")).filter(
      (r) => !r.data.workspaceId || r.data.workspaceId === a.scope,
    );
    rows.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return {
      events: rows.slice(0, 200).map((r) => ({
        at: r.createdAt,
        action: r.name,
        actor: r.data.actor,
        ...r.data,
      })),
    };
  });
}
