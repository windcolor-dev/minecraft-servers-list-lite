import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const port = Number(process.env.PORT ?? "3000");

function bootstrap() {
  const db = openDatabase();
  const app = createApp(db);

  app.listen(port, () => {
    console.log(`Minecraft Servers List Lite running on http://localhost:${port}`);
  });
}

try {
  bootstrap();
} catch (error) {
  console.error("Failed to start application", error);
  process.exit(1);
}
