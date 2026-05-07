import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppDatabase } from "./database.js";
import {
  clearSessionCookie,
  createSessionCookie,
  generateToken,
  hashPassword,
  hashToken,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  parseCookies,
  verifyPassword,
} from "./auth.js";
import { createMailer } from "./mailer.js";

type SqlParam = string | number | null;

type ServerRow = {
  server_id: number;
  category_id: number;
  address: string;
  connection_port: number;
  query_port: number;
  name: string;
  description: string;
  date_added: string;
  votes: number;
};

type UserRow = {
  user_id: number;
  email: string;
  password_hash: string;
  password_salt: string;
  is_email_verified: number;
};

type SessionUserRow = {
  user_id: number;
  email: string;
};

const resetTokenCookieName = "reset_token";
const resetTokenCookieMaxAge = 60 * 60;
const authRateLimitWindowMs = 15 * 60 * 1000;
const authRateLimitMax = 10;
const authLimiter = rateLimit({
  windowMs: authRateLimitWindowMs,
  max: authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many attempts. Please try again later." });
  },
});
const htmlAuthLimiter = rateLimit({
  windowMs: authRateLimitWindowMs,
  max: authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).type("text/plain").send("Too many attempts. Please try again later.");
  },
});

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function validateServerPayload(body: Record<string, unknown>): { valid: true; value: { name: string; address: string; description: string; categoryId: number; connectionPort: number; queryPort: number } } | { valid: false; error: string } {
  const name = String(body.name ?? "").trim();
  const address = String(body.address ?? "").trim();
  const description = String(body.description ?? "").trim();

  if (name.length < 3 || name.length > 64) {
    return { valid: false, error: "Name must be between 3 and 64 characters." };
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(address) || address.length > 255) {
    return { valid: false, error: "Address must be a valid hostname or IP format." };
  }
  if (description.length < 10 || description.length > 3000) {
    return { valid: false, error: "Description must be between 10 and 3000 characters." };
  }

  return {
    valid: true,
    value: {
      name,
      address,
      description,
      categoryId: parsePositiveInt(body.categoryId, 1),
      connectionPort: parsePositiveInt(body.connectionPort, 25565),
      queryPort: parsePositiveInt(body.queryPort, 25565),
    },
  };
}

function queryAll<T>(db: AppDatabase, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T>(db: AppDatabase, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function execute(db: AppDatabase, sql: string, ...params: SqlParam[]): number {
  const result = db.prepare(sql).run(...params) as { lastInsertRowid?: number };
  return Number(result.lastInsertRowid ?? 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isProduction(): boolean {
  return String(process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

function getBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

function createTransientCookie(name: string, value: string, maxAgeSeconds: number): string {
  const securePart = isProduction() ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${securePart}`;
}

function clearTransientCookie(name: string): string {
  const securePart = isProduction() ? "; Secure" : "";
  return `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${securePart}`;
}

function getSessionUser(db: AppDatabase, req: Request): SessionUserRow | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.session;
  if (!sessionToken) {
    return undefined;
  }

  const tokenHash = hashToken(sessionToken);
  return queryOne<SessionUserRow>(
    db,
    `SELECT u.user_id, u.email
     FROM user_sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    nowIso()
  );
}

async function sendVerificationEmail(db: AppDatabase, _req: Request, userId: number, email: string): Promise<void> {
  const mailer = createMailer();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const createdAt = nowIso();

  execute(db, "DELETE FROM email_verification_tokens WHERE user_id = ?", userId);
  execute(
    db,
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    userId,
    tokenHash,
    addHours(new Date(), 24),
    null,
    createdAt
  );

  const verificationUrl = `${getBaseUrl()}/auth/verify-email?token=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    to: email,
    subject: "Verify your account",
    text: `Welcome! Verify your account by visiting: ${verificationUrl}`,
    html: `<p>Welcome!</p><p>Verify your account by visiting <a href="${escapeHtml(verificationUrl)}">${escapeHtml(verificationUrl)}</a>.</p>`,
  });
}

async function sendPasswordResetEmail(db: AppDatabase, _req: Request, userId: number, email: string): Promise<void> {
  const mailer = createMailer();
  const token = generateToken();
  const tokenHash = hashToken(token);

  execute(db, "DELETE FROM password_reset_tokens WHERE user_id = ?", userId);
  execute(
    db,
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    userId,
    tokenHash,
    addHours(new Date(), 1),
    null,
    nowIso()
  );

  const resetUrl = `${getBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    to: email,
    subject: "Reset your password",
    text: `Reset your password by visiting: ${resetUrl}`,
    html: `<p>Reset your password by visiting <a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a>.</p>`,
  });
}

export function createApp(db: AppDatabase) {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/template", express.static("template"));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/servers", (req: Request, res: Response) => {
    const limit = Math.min(parsePositiveInt(req.query.limit, 10), 100);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const categoryId = Number(req.query.categoryId ?? 0);

    const filters = Number.isInteger(categoryId) && categoryId > 0 ? "WHERE s.category_id = ?" : "";
    const params: Array<number> = [];
    if (filters) {
      params.push(categoryId);
    }

    const servers = queryAll<ServerRow>(
      db,
      `SELECT s.* FROM servers s ${filters} ORDER BY s.votes DESC, s.server_id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    );

    res.json({ servers, limit, offset });
  });

  app.get("/api/servers/:id", (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id, -1);
    if (id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }

    const server = queryOne<ServerRow>(db, "SELECT * FROM servers WHERE server_id = ?", id);
    if (!server) {
      return res.status(404).json({ error: "Server not found." });
    }

    return res.json({ server });
  });

  app.post("/api/servers", (req: Request, res: Response) => {
    const payload = validateServerPayload(req.body as Record<string, unknown>);
    if (!payload.valid) {
      return res.status(400).json({ error: payload.error });
    }

    const category = queryOne<{ category_id: number }>(
      db,
      "SELECT category_id FROM categories WHERE category_id = ?",
      payload.value.categoryId
    );
    if (!category) {
      return res.status(400).json({ error: "Category not found." });
    }

    const serverId = execute(
      db,
      `INSERT INTO servers (category_id, address, connection_port, query_port, name, description, date_added)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      payload.value.categoryId,
      payload.value.address,
      payload.value.connectionPort,
      payload.value.queryPort,
      payload.value.name,
      payload.value.description,
      new Date().toISOString()
    );

    return res.status(201).json({ serverId });
  });

  app.post("/api/servers/:id/votes", (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id, -1);
    if (id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }

    const server = queryOne<{ server_id: number }>(db, "SELECT server_id FROM servers WHERE server_id = ?", id);
    if (!server) {
      return res.status(404).json({ error: "Server not found." });
    }

    execute(db, "UPDATE servers SET votes = votes + 1 WHERE server_id = ?", id);
    execute(
      db,
      "INSERT INTO votes (server_id, ip, timestamp) VALUES (?, ?, ?)",
      id,
      req.ip ?? "unknown",
      Date.now()
    );

    return res.status(201).json({ success: true });
  });

  app.post("/api/servers/:id/reports", (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id, -1);
    if (id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }

    const message = String(req.body.message ?? "").trim();
    if (message.length < 5 || message.length > 2000) {
      return res.status(400).json({ error: "Message must be between 5 and 2000 characters." });
    }

    const server = queryOne<{ server_id: number }>(db, "SELECT server_id FROM servers WHERE server_id = ?", id);
    if (!server) {
      return res.status(404).json({ error: "Server not found." });
    }

    execute(
      db,
      "INSERT INTO reports (server_id, ip_address, message, date) VALUES (?, ?, ?, ?)",
      id,
      req.ip ?? "unknown",
      message,
      new Date().toISOString()
    );

    return res.status(201).json({ success: true });
  });

  app.post("/api/auth/signup", async (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "Password must be 8-128 characters." });
    }

    const existing = queryOne<{ user_id: number }>(db, "SELECT user_id FROM users WHERE email = ?", email);
    if (existing) {
      return res.status(409).json({ error: "Email already registered." });
    }

    const { hash, salt } = hashPassword(password);
    const userId = execute(
      db,
      "INSERT INTO users (email, password_hash, password_salt, is_email_verified, created_at) VALUES (?, ?, ?, ?, ?)",
      email,
      hash,
      salt,
      0,
      nowIso()
    );

    await sendVerificationEmail(db, req, userId, email);
    return res.status(201).json({ success: true, message: "Account created. Verify your email before login." });
  });

  app.get("/api/auth/verify-email", (req: Request, res: Response) => {
    const token = String(req.query.token ?? "").trim();
    if (!token) {
      return res.status(400).json({ error: "Missing token." });
    }

    const tokenHash = hashToken(token);
    const row = queryOne<{ user_id: number }>(
      db,
      `SELECT user_id FROM email_verification_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIso()
    );

    if (!row) {
      return res.status(400).json({ error: "Invalid or expired token." });
    }

    execute(db, "UPDATE users SET is_email_verified = 1 WHERE user_id = ?", row.user_id);
    execute(db, "UPDATE email_verification_tokens SET used_at = ? WHERE token_hash = ?", nowIso(), tokenHash);

    return res.json({ success: true });
  });

  app.post("/api/auth/login", authLimiter, (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");

    const user = queryOne<UserRow>(db, "SELECT * FROM users WHERE email = ?", email);
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (!user.is_email_verified) {
      return res.status(403).json({ error: "Verify your email before logging in." });
    }

    const sessionToken = generateToken();
    const maxAgeSeconds = 7 * 24 * 60 * 60;
    execute(
      db,
      "INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
      user.user_id,
      hashToken(sessionToken),
      addDays(new Date(), 7),
      nowIso()
    );

    res.setHeader("Set-Cookie", createSessionCookie(sessionToken, maxAgeSeconds, isProduction()));
    return res.json({ success: true });
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.session;
    if (sessionToken) {
      execute(db, "DELETE FROM user_sessions WHERE token_hash = ?", hashToken(sessionToken));
    }

    res.setHeader("Set-Cookie", clearSessionCookie(isProduction()));
    return res.json({ success: true });
  });

  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    const user = queryOne<{ user_id: number; email: string }>(db, "SELECT user_id, email FROM users WHERE email = ?", email);
    if (user) {
      await sendPasswordResetEmail(db, req, user.user_id, user.email);
    }

    return res.json({ success: true, message: "If the account exists, a reset email has been sent." });
  });

  app.post("/api/auth/reset-password", authLimiter, (req: Request, res: Response) => {
    const token = String(req.body.token ?? "").trim();
    const newPassword = String(req.body.newPassword ?? "");

    if (!token) {
      return res.status(400).json({ error: "Missing token." });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: "Password must be 8-128 characters." });
    }

    const tokenHash = hashToken(token);
    const row = queryOne<{ user_id: number }>(
      db,
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIso()
    );

    if (!row) {
      return res.status(400).json({ error: "Invalid or expired token." });
    }

    const { hash, salt } = hashPassword(newPassword);
    execute(db, "UPDATE users SET password_hash = ?, password_salt = ? WHERE user_id = ?", hash, salt, row.user_id);
    execute(db, "UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?", nowIso(), tokenHash);
    execute(db, "DELETE FROM user_sessions WHERE user_id = ?", row.user_id);

    return res.json({ success: true });
  });

  app.get("/api/auth/me", (req: Request, res: Response) => {
    const user = getSessionUser(db, req);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    return res.json({ user });
  });

  app.get("/", (req: Request, res: Response) => {
    const user = getSessionUser(db, req);
    const servers = queryAll<ServerRow>(
      db,
      "SELECT * FROM servers ORDER BY votes DESC, server_id DESC LIMIT 50"
    );

    const listMarkup = servers.length
      ? servers
          .map(
            (server) => `
              <article class="card">
                <h3>${escapeHtml(server.name)}</h3>
                <p><strong>Address:</strong> ${escapeHtml(server.address)}:${server.connection_port}</p>
                <p><strong>Votes:</strong> ${server.votes}</p>
                <p>${escapeHtml(server.description)}</p>
                <form method="post" action="/servers/${server.server_id}/vote">
                  <button type="submit">Vote</button>
                </form>
              </article>
            `
          )
          .join("\n")
      : "<p>No servers submitted yet.</p>";

    const authMarkup = user
      ? `<p>Signed in as <strong>${escapeHtml(user.email)}</strong></p>
         <form method="post" action="/auth/logout"><button type="submit">Logout</button></form>`
      : `<p><a href="/auth/login">Login</a> | <a href="/auth/signup">Sign up</a> | <a href="/auth/forgot-password">Forgot password</a></p>`;

    res.type("html").send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Minecraft Servers List Lite</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 2rem auto; max-width: 860px; line-height: 1.45; padding: 0 1rem; }
            .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
            form { margin-top: 0.75rem; }
            label { display: block; margin-top: 0.5rem; }
            input, textarea { width: 100%; max-width: 100%; padding: 0.5rem; box-sizing: border-box; }
            button { margin-top: 0.75rem; padding: 0.5rem 1rem; cursor: pointer; }
          </style>
        </head>
        <body>
          <h1>Minecraft Servers List Lite</h1>
          <p>TypeScript + Express + local SQLite database</p>
          ${authMarkup}

          <section>
            <h2>Submit Server</h2>
            <form method="post" action="/servers/submit">
              <label>Name <input required minlength="3" maxlength="64" name="name" /></label>
              <label>Address <input required name="address" /></label>
              <label>Description <textarea required minlength="10" maxlength="3000" name="description"></textarea></label>
              <label>Connection Port <input type="number" name="connectionPort" min="1" max="65535" value="25565" /></label>
              <label>Query Port <input type="number" name="queryPort" min="1" max="65535" value="25565" /></label>
              <button type="submit">Submit</button>
            </form>
          </section>

          <section>
            <h2>Top Servers</h2>
            ${listMarkup}
          </section>
        </body>
      </html>
    `);
  });

  app.get("/auth/signup", (_req: Request, res: Response) => {
    res.type("html").send(`
      <!doctype html>
      <html>
        <body>
          <h1>Sign up</h1>
          <form method="post" action="/auth/signup">
            <label>Email <input type="email" name="email" required /></label>
            <label>Password <input type="password" name="password" required minlength="8" maxlength="128" /></label>
            <button type="submit">Create account</button>
          </form>
          <p><a href="/">Back</a></p>
        </body>
      </html>
    `);
  });

  app.post("/auth/signup", async (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");

    if (!isValidEmail(email)) {
      return res.status(400).type("text/plain").send("Invalid email address.");
    }
    if (!isValidPassword(password)) {
      return res.status(400).type("text/plain").send("Password must be 8-128 characters.");
    }

    const existing = queryOne<{ user_id: number }>(db, "SELECT user_id FROM users WHERE email = ?", email);
    if (existing) {
      return res.status(409).type("text/plain").send("Email already registered.");
    }

    const { hash, salt } = hashPassword(password);
    const userId = execute(
      db,
      "INSERT INTO users (email, password_hash, password_salt, is_email_verified, created_at) VALUES (?, ?, ?, ?, ?)",
      email,
      hash,
      salt,
      0,
      nowIso()
    );

    await sendVerificationEmail(db, req, userId, email);
    return res.redirect("/auth/login?signup=1");
  });

  app.get("/auth/verify-email", (req: Request, res: Response) => {
    const token = String(req.query.token ?? "").trim();
    if (!token) {
      return res.status(400).type("text/plain").send("Missing token.");
    }

    const tokenHash = hashToken(token);
    const row = queryOne<{ user_id: number }>(
      db,
      `SELECT user_id FROM email_verification_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIso()
    );

    if (!row) {
      return res.status(400).type("text/plain").send("Invalid or expired token.");
    }

    execute(db, "UPDATE users SET is_email_verified = 1 WHERE user_id = ?", row.user_id);
    execute(db, "UPDATE email_verification_tokens SET used_at = ? WHERE token_hash = ?", nowIso(), tokenHash);

    return res.redirect("/auth/login?verified=1");
  });

  app.get("/auth/login", (req: Request, res: Response) => {
    const signupMessage = req.query.signup === "1" ? "<p>Account created. Check your email for verification.</p>" : "";
    const verifiedMessage = req.query.verified === "1" ? "<p>Email verified. You can log in now.</p>" : "";
    const resetMessage = req.query.reset === "1" ? "<p>Password reset. You can log in now.</p>" : "";

    res.type("html").send(`
      <!doctype html>
      <html>
        <body>
          <h1>Login</h1>
          ${signupMessage}
          ${verifiedMessage}
          ${resetMessage}
          <form method="post" action="/auth/login">
            <label>Email <input type="email" name="email" required /></label>
            <label>Password <input type="password" name="password" required /></label>
            <button type="submit">Login</button>
          </form>
          <p><a href="/auth/forgot-password">Forgot password?</a></p>
          <p><a href="/">Back</a></p>
        </body>
      </html>
    `);
  });

  app.post("/auth/login", htmlAuthLimiter, (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");

    const user = queryOne<UserRow>(db, "SELECT * FROM users WHERE email = ?", email);
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).type("text/plain").send("Invalid credentials.");
    }
    if (!user.is_email_verified) {
      return res.status(403).type("text/plain").send("Verify your email before logging in.");
    }

    const sessionToken = generateToken();
    const maxAgeSeconds = 7 * 24 * 60 * 60;
    execute(
      db,
      "INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
      user.user_id,
      hashToken(sessionToken),
      addDays(new Date(), 7),
      nowIso()
    );

    res.setHeader("Set-Cookie", createSessionCookie(sessionToken, maxAgeSeconds, isProduction()));
    return res.redirect("/");
  });

  app.post("/auth/logout", (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.session;
    if (sessionToken) {
      execute(db, "DELETE FROM user_sessions WHERE token_hash = ?", hashToken(sessionToken));
    }

    res.setHeader("Set-Cookie", clearSessionCookie(isProduction()));
    return res.redirect("/");
  });

  app.get("/auth/forgot-password", (_req: Request, res: Response) => {
    res.type("html").send(`
      <!doctype html>
      <html>
        <body>
          <h1>Forgot password</h1>
          <form method="post" action="/auth/forgot-password">
            <label>Email <input type="email" name="email" required /></label>
            <button type="submit">Send reset email</button>
          </form>
          <p><a href="/">Back</a></p>
        </body>
      </html>
    `);
  });

  app.post("/auth/forgot-password", async (req: Request, res: Response) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    if (!isValidEmail(email)) {
      return res.status(400).type("text/plain").send("Invalid email address.");
    }

    const user = queryOne<{ user_id: number; email: string }>(db, "SELECT user_id, email FROM users WHERE email = ?", email);
    if (user) {
      await sendPasswordResetEmail(db, req, user.user_id, user.email);
    }

    return res.redirect("/auth/reset-password/requested");
  });

  app.get("/auth/reset-password/requested", (_req: Request, res: Response) => {
    res.type("html").send(`
      <!doctype html>
      <html>
        <body>
          <h1>Reset email sent</h1>
          <p>If the account exists, a reset link was sent.</p>
          <p><a href="/">Back</a></p>
        </body>
      </html>
    `);
  });

  app.get("/auth/reset-password", (req: Request, res: Response) => {
    const token = String(req.query.token ?? "").trim();
    if (token) {
      const tokenHash = hashToken(token);
      const row = queryOne<{ user_id: number }>(
        db,
        `SELECT user_id FROM password_reset_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
        tokenHash,
        nowIso()
      );
      if (!row) {
        return res.status(400).type("text/plain").send("Invalid or expired token.");
      }

      res.setHeader("Set-Cookie", createTransientCookie(resetTokenCookieName, token, resetTokenCookieMaxAge));
      return res.redirect("/auth/reset-password");
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[resetTokenCookieName]) {
      return res.status(400).type("text/plain").send("Missing token.");
    }

    res.type("html").send(`
      <!doctype html>
      <html>
        <body>
          <h1>Reset password</h1>
          <form method="post" action="/auth/reset-password">
            <label>New password <input type="password" name="newPassword" required minlength="8" maxlength="128" /></label>
            <button type="submit">Reset password</button>
          </form>
          <p><a href="/">Back</a></p>
        </body>
      </html>
    `);
  });

  app.post("/auth/reset-password", htmlAuthLimiter, (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = String(cookies[resetTokenCookieName] ?? "").trim();
    const newPassword = String(req.body.newPassword ?? "");

    if (!token) {
      return res.status(400).type("text/plain").send("Missing token.");
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).type("text/plain").send("Password must be 8-128 characters.");
    }

    const tokenHash = hashToken(token);
    const row = queryOne<{ user_id: number }>(
      db,
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIso()
    );

    if (!row) {
      return res.status(400).type("text/plain").send("Invalid or expired token.");
    }

    const { hash, salt } = hashPassword(newPassword);
    execute(db, "UPDATE users SET password_hash = ?, password_salt = ? WHERE user_id = ?", hash, salt, row.user_id);
    execute(db, "UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?", nowIso(), tokenHash);
    execute(db, "DELETE FROM user_sessions WHERE user_id = ?", row.user_id);

    res.setHeader("Set-Cookie", clearTransientCookie(resetTokenCookieName));
    return res.redirect("/auth/login?reset=1");
  });

  app.post("/servers/submit", (req: Request, res: Response) => {
    const payload = validateServerPayload(req.body as Record<string, unknown>);
    if (!payload.valid) {
      return res.status(400).type("text/plain").send(payload.error);
    }

    const category = queryOne<{ category_id: number }>(
      db,
      "SELECT category_id FROM categories WHERE category_id = ?",
      payload.value.categoryId
    );
    if (!category) {
      return res.status(400).type("text/plain").send("Category not found.");
    }

    execute(
      db,
      `INSERT INTO servers (category_id, address, connection_port, query_port, name, description, date_added)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      payload.value.categoryId,
      payload.value.address,
      payload.value.connectionPort,
      payload.value.queryPort,
      payload.value.name,
      payload.value.description,
      new Date().toISOString()
    );

    return res.redirect("/");
  });

  app.post("/servers/:id/vote", (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id, -1);
    if (id < 1) {
      return res.status(400).type("text/plain").send("Invalid server id.");
    }

    const server = queryOne<{ server_id: number }>(db, "SELECT server_id FROM servers WHERE server_id = ?", id);
    if (!server) {
      return res.status(404).type("text/plain").send("Server not found.");
    }

    execute(db, "UPDATE servers SET votes = votes + 1 WHERE server_id = ?", id);
    execute(
      db,
      "INSERT INTO votes (server_id, ip, timestamp) VALUES (?, ?, ?)",
      id,
      req.ip ?? "unknown",
      Date.now()
    );

    return res.redirect("/");
  });

  return app;
}
