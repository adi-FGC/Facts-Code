/**
 * The one seam between a command and the process it runs in (tech-debt#6).
 * Every command in ./commands/ writes through `io.stdout` / `io.stderr` and
 * ends through `io.exit`, so a test can run it in-process and read what it
 * printed and the code it exited with. The binary passes `processIO`: the
 * real streams and the real `process.exit`, so output and exit codes are
 * exactly what they were when every command lived inline in cli.ts.
 */

/** The part of a writable stream a command uses. */
export interface CliStream {
  write(chunk: string): unknown;
}

export interface CliIO {
  readonly stdout: CliStream;
  readonly stderr: CliStream;
  /** End the command now with `code` (process.exit in the binary). */
  exit(code: number): never;
  /** Set the code the process ends with, without ending it now
   *  (process.exitCode in the binary — `hook` reports a failure this way). */
  setExitCode(code: number): void;
}

export const processIO: CliIO = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};
