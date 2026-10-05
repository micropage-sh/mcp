import { createWorker } from "./app.js";

/** Cloudflare Workers entry (wrangler.toml `main`). The caches inside live as long as the isolate. */
export default createWorker();
