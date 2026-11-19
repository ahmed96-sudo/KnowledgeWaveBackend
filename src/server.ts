import { createApp } from "./app.js";
import { config } from "./config.js";
import { purgeExpired } from "./lib/purge.js";

createApp().listen(config.PORT, () => {
  console.log(`KnowledgeWave API listening on http://localhost:${config.PORT}/api`);
});

// Hourly cleanup of expired rows (and once at startup)
const purge = () => purgeExpired().catch((e) => console.error("purge failed", e));
setInterval(purge, 3_600_000).unref();
void purge();
