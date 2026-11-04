import type { NexoModule } from "@nexo/shared";

/**
 * Template for a client-specific module. Enable it per client in the console by adding
 * "example-hello" to that client's modules. Copy this folder to start a real one.
 */
const mod: NexoModule = {
  name: "example-hello",
  // migrationsDir: "migrations",   // optional: ordered .sql files, tracked per module
  register({ app, flags, log }) {
    app.get("/hello", (c) => c.json({ message: "Hello from a client module", flags }));
    log("registered");
  },
};

export default mod;
