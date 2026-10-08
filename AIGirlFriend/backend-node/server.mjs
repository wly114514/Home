import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "./app.mjs";
export { createApplication, loadEnv, ROOT } from "./app.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApplication();
  const address = await app.listen();
  console.log(`[node-api] listening on http://${address.address}:${address.port}`);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
