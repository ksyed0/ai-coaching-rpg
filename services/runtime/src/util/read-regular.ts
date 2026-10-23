import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Opened without following a symbolic link and without blocking on a pipe; on Windows O_NOFOLLOW does not exist. */
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** Reads a small regular file from ONE handle: no check-then-use, no symbolic link, no pipe or device, at most `max` bytes. Rejects otherwise. */
export async function readRegularCapped(
  file: string,
  max: number,
): Promise<string> {
  const fh = await open(file, OPEN_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) throw new Error("not a regular file");
    const buf = Buffer.allocUnsafe(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > max) throw new Error("file too large");
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}
