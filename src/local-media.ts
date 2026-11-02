import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaSources } from "./media.js";

/** Media sources of the local stdio server: files on this machine and base64. */
export function localMediaSources(): MediaSources {
  return {
    async readFile(file) {
      const p = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
      const st = await fs.stat(p);
      if (!st.isFile()) throw new Error(`${p} is not a file.`);
      return { size: st.size, name: p, body: createReadStream(p) };
    },
  };
}
