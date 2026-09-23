/**
 * FactsFS — abstract filesystem interface.
 *
 * Constraint C1: every package that transitively feeds into @factstack/core
 * must use this interface instead of importing node:fs directly. Node,
 * browser, and in-memory implementations live in @factstack/fs-node,
 * @factstack/fs-browser (v0.4), and @factstack/fs-memory respectively.
 */

export type Dirent = {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
};

export type Stats = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
};

export interface FactsFS {
  /** Read a file's bytes. Throws if not found or not a file. */
  readFile(path: string): Promise<Uint8Array>;

  /** Read a file as UTF-8 text. */
  readText(path: string): Promise<string>;

  /** Stream directory entries. Non-recursive; caller drives recursion. */
  readDir(path: string): AsyncIterable<Dirent>;

  /** Stat a path. Does not follow symlinks. */
  stat(path: string): Promise<Stats>;

  /**
   * Resolve a symlink target (one hop). Returns null if the path is not
   * a symlink. Used by the walker to detect loops without eagerly following.
   */
  readlink(path: string): Promise<string | null>;

  /** Normalize a path to POSIX form (forward slashes, no trailing slash). */
  normalize(path: string): string;

  /** Join path segments in a platform-agnostic way. */
  join(...segments: string[]): string;
}

/** File extensions that are never text (media, archives, fonts, binaries,
 *  databases). The one shared list for "is this worth reading as text":
 *  core skips them in the secret-only pass over oversized files, and the
 *  browser GitHub scan skips fetching them — so a CLI scan and a browser scan
 *  of the same repo look at the same files (INV7). Lower-case, with dot. */
export const NEVER_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    '.png .jpg .jpeg .gif .webp .avif .ico .bmp .tif .tiff .psd .heic .mp4 .mov .webm .mkv ' +
    '.avi .mp3 .wav .ogg .flac .m4a .zip .gz .tgz .bz2 .xz .7z .rar .zst .jar .war .ear ' +
    '.pdf .woff .woff2 .ttf .otf .eot .wasm .exe .dll .so .dylib .a .o .obj .class .pyc ' +
    '.bin .dat .db .sqlite .sqlite3 .parquet .onnx .pt .pth .h5 .npy .npz .dmg .iso .apk'
  ).split(' '),
);

/** Deterministic code-unit string comparator (INV2). Unlike localeCompare,
 *  `<`/`>` compare UTF-16 code units, giving identical ordering across every
 *  runtime/locale — required for byte-identical artifact output. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
