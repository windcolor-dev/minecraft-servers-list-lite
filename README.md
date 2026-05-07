# Minecraft Servers List - TypeScript Edition

This project has been rewritten to use **TypeScript** and a **local SQLite database**.

## Stack

- Node.js + Express
- TypeScript
- SQLite (local file in `data/minecraft-servers-list.db`)
- Cookie-based session auth
- SMTP email flows via Nodemailer

## Features

- Submit Minecraft servers
- List top servers by votes
- Vote for servers
- Report servers
- JSON API endpoints for integration
- Sign up + email verification
- Login + logout
- Forgot password + reset password by email

## Quick start

1. Install Node.js 20+.
2. Install dependencies:

   ```bash
   npm install
   ```

3. (Optional) Configure SMTP to send real emails:

   ```bash
   export SMTP_HOST=smtp.example.com
   export SMTP_PORT=587
   export SMTP_SECURE=false
   export SMTP_USER=your-user
   export SMTP_PASS=your-pass
   export MAIL_FROM="Minecraft List <noreply@example.com>"
   export APP_BASE_URL=http://localhost:3000
   ```

   If SMTP is not configured, emails are logged to console in development fallback mode.

4. Start in development mode:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

## Build and run

```bash
npm run build
npm start
```

## API

### Servers

- `GET /api/servers`
- `GET /api/servers/:id`
- `POST /api/servers`
- `POST /api/servers/:id/votes`
- `POST /api/servers/:id/reports`

### Auth

- `POST /api/auth/signup`
- `GET /api/auth/verify-email?token=...`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/me`

## HTML flows

- `GET /auth/signup`
- `GET /auth/login`
- `GET /auth/verify-email?token=...`
- `GET /auth/forgot-password`
- `GET /auth/reset-password?token=...`

## Database

The app automatically creates the SQLite schema on startup and seeds a default category.
