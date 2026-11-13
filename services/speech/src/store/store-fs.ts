import { closeSync, constants as fc, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { fsyncDirSync } from "@acr/runtime/files";
import { appendIndexLine, type IndexEntry } from "./index-file.js";

/**
 * The file calls the store makes, injected so tests can fail any one step. The default is the real node fs. (Folder creation goes
 * through `paths.ts`, which owns its own safety checks.)
 */
export type StoreFs = {
  openSync(file: string, flags: number, mode: number): number;
  writeSync(fd: number, buf: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  unlinkSync(file: string): void;
  renameSync(from: string, to: string): void;
  fsyncDir(dir: string): void;
  appendIndex(file: string, entry: IndexEntry): void;
};

export const nodeStoreFs: StoreFs = {
  openSync: (file, flags, mode) => openSync(file, flags, mode),
  writeSync: (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  unlinkSync: (file) => unlinkSync(file),
  renameSync: (from, to) => renameSync(from, to),
  fsyncDir: (dir) => fsyncDirSync(dir),
  appendIndex: (file, entry) => appendIndexLine(file, entry),
};

/** Exclusive, private, link-refusing create: the one open mode every file the store makes uses. */
export const CREATE_FLAGS = fc.O_WRONLY | fc.O_CREAT | fc.O_EXCL | fc.O_NOFOLLOW;
