/** `factstack tokens [file|-]`: the cl100k token estimate analyze uses, for a file or stdin. */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import kleur from 'kleur';
import { approximateTokens } from '@factstack/scanners';
import { processIO, type CliIO } from '../io.js';

export interface TokensOptions {
  json?: boolean;
}

export function tokensCommand(
  target: string | undefined,
  opts: TokensOptions,
  io: CliIO = processIO,
): void {
  let text: string;
  let label: string;
  if (!target || target === '-') {
    if (process.stdin.isTTY) {
      io.stderr.write(
        kleur.red('factstack tokens: ') +
          'provide a file path, or pipe text via stdin (e.g. `cat file.ts | factstack tokens -`).\n',
      );
      io.exit(1);
    }
    // fd 0 = stdin; synchronous read of piped input.
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
    label = '<stdin>';
  } else {
    const abs = path.resolve(target);
    if (!existsSync(abs)) {
      io.stderr.write(kleur.red('factstack tokens: ') + `file not found: ${target}\n`);
      io.exit(1);
    }
    text = readFileSync(abs, 'utf8');
    label = target;
  }
  const tokens = approximateTokens(text);
  if (opts.json) {
    io.stdout.write(JSON.stringify({ path: label, chars: text.length, tokens }) + '\n');
    return;
  }
  const human = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
  io.stdout.write(
    `${kleur.bold(human + ' tokens')}  ${kleur.dim(`(${text.length} chars · ${label})`)}\n`,
  );
}
