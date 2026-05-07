# Minecraft Servers List - TypeScript Edition

This project has been rewritten to use **TypeScript** and a **local SQLite database**.

## Stack

- Node.js + Express
- TypeScript
- SQLite (local file in `data/minecraft-servers-list.db`)

## Features

- Submit Minecraft servers
- List top servers by votes
- Vote for servers
- Report servers
- JSON API endpoints for integration

## Quick start

1. Install Node.js 20+.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start in development mode:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000`.

## Build and run

```bash
npm run build
npm start
```

## API

- `GET /api/servers`
- `GET /api/servers/:id`
- `POST /api/servers`
- `POST /api/servers/:id/votes`
- `POST /api/servers/:id/reports`

## Database

The app automatically creates the SQLite schema on startup and seeds a default category.
