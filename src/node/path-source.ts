import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { assetTooLarge, type PathLoader } from "../client/assets.js";
import { MicropageError } from "../client/errors.js";

/** `{path}` sources for a server running on the user's machine. */
export const nodePathLoader: PathLoader = async (path, maxBytes) => {
  if (!isAbsolute(path)) {
    throw new MicropageError(
      "INVALID_SOURCE",
      `source.path "${path}" is relative. Pass an absolute path; the server's working directory is not the user's.`,
    );
  }
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    throw new MicropageError("INVALID_SOURCE", `Cannot read source.path "${path}": ${(err as NodeJS.ErrnoException).code ?? String(err)}.`, {
      cause: err,
    });
  }
  if (!info.isFile()) throw new MicropageError("INVALID_SOURCE", `source.path "${path}" is not a regular file.`);
  if (info.size > maxBytes) throw assetTooLarge(info.size, maxBytes);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw assetTooLarge(bytes.length, maxBytes);
  return bytes;
};
