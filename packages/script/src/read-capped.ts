import { open } from "node:fs/promises";

/** A file is larger than the cap the caller allows. */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) { super(`the file is larger than ${maxBytes} bytes`); this.name = "FileTooLargeError"; }
}

/**
 * Reads a whole file with a size cap using ONE open handle: at most `maxBytes + 1` bytes are read from the handle (until end of file or that
 * limit) and the handle is closed. If more than `maxBytes` bytes came back the file is too large (FileTooLargeError). There is no separate
 * size check on the path, so the file cannot change between "check" and "use". A missing file or a directory rejects with the fs error.
 */
export async function readCapped(file: string, maxBytes: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > maxBytes) throw new FileTooLargeError(maxBytes);
    return buf.subarray(0, got);
  } finally { await fh.close(); }
}

/** readCapped decoded as UTF-8. */
export async function readTextCapped(file: string, maxBytes: number): Promise<string> {
  return (await readCapped(file, maxBytes)).toString("utf8");
}
