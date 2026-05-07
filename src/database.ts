import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type AppDatabase = DatabaseSync;

const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataDir, "minecraft-servers-list.db");

export function openDatabase(): AppDatabase {
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      category_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS servers (
      server_id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      connection_port INTEGER NOT NULL DEFAULT 25565,
      query_port INTEGER NOT NULL DEFAULT 25565,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      date_added TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (category_id) REFERENCES categories(category_id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(server_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      ip_address TEXT NOT NULL,
      message TEXT NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(server_id)
    );
  `);

  const categoryCount = db
    .prepare("SELECT COUNT(*) as count FROM categories")
    .get() as { count: number };
  if (!categoryCount || categoryCount.count === 0) {
    db.prepare("INSERT INTO categories (name, description) VALUES (?, ?)")
      .run("Minecraft", "Default category");
  }

  return db;
}
