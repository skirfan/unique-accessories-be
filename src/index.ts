import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`Unique Accessories API listening at ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Let in-flight requests finish and close the DB connection (via app.ts's
// onClose hook) before exiting, instead of dying mid-request on redeploy.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await app.close();
    app.log.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
