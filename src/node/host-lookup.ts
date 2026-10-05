import { lookup } from "node:dns/promises";

import type { HostLookup } from "../client/assets.js";

/** Every address the system resolver returns for a name, as fetch would see them. */
export const nodeHostLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });
