import express, { type Request, type Response } from "express";
import type { AppDatabase } from "./database.js";

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

function queryAll<T>(db: AppDatabase, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T>(db: AppDatabase, sql: string, ...params: Array<string | number>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function execute(db: AppDatabase, sql: string, ...params: Array<string | number>): number {
  const result = db.prepare(sql).run(...params) as { lastInsertRowid?: number };
  return Number(result.lastInsertRowid ?? 0);
}

export function createApp(db: AppDatabase) {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/template", express.static("template"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/servers", (req, res) => {
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

  app.get("/api/servers/:id", (req, res) => {
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

  app.post("/api/servers", (req, res) => {
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

  app.post("/api/servers/:id/votes", (req, res) => {
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

  app.post("/api/servers/:id/reports", (req, res) => {
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

  app.get("/", (_req: Request, res: Response) => {
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

  app.post("/servers/submit", (req, res) => {
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

  app.post("/servers/:id/vote", (req, res) => {
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
