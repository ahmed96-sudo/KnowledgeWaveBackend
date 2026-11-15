import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.PORT, () => {
  console.log(`KnowledgeWave API listening on http://localhost:${config.PORT}/api`);
});

// Phase 3 adds the hourly purge of expired sessions / idempotency keys / reset tokens here.
