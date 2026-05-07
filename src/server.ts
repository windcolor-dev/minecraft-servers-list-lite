import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const port = Number(process.env.PORT ?? "3000");

async function bootstrap() {
  const db = await openDatabase();
  const app = createApp(db);

  app.listen(port, () => {
    console.log(`Minecraft Servers List Lite running on http://localhost:${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start application", error);
  process.exit(1);
});
