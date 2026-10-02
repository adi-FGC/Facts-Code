/** `factstack hook <install|uninstall> [target]`: the F8 git post-commit refresh hook. */
import path from 'node:path';
import kleur from 'kleur';
import { hookLaunchNote } from '../agentHook.js';
import { relativize } from '../format.js';
import { installGitHook, uninstallGitHook } from '../gitHook.js';
import { processIO, type CliIO } from '../io.js';

export interface HookOptions {
  command: string;
  shared?: boolean;
}

export function hookCommand(
  action: string,
  target: string | undefined,
  opts: HookOptions,
  io: CliIO = processIO,
): void {
  const root = path.resolve(target ?? '.');
  const hookOpts = { shared: opts.shared === true };
  if (action === 'install') {
    try {
      const r = installGitHook(root, opts.command, hookOpts);
      // Say so when the hook launches the unpublished npm package.
      const note = hookLaunchNote(
        r.command,
        '`hook install --command <cmd>` or FACTSTACK_HOOK_COMMAND',
      );
      const lines = [
        kleur.bold().green('FACTS') + kleur.dim(' · hook install'),
        `  ${kleur.green('✓')} ${relativize(r.hookPath, root)} ${kleur.dim(r.changed ? '(post-commit hook installed)' : '(already up to date)')}`,
        kleur.dim(`      runs after each commit: ${r.command} .`),
        ...(note !== undefined ? [kleur.yellow(`  ! ${note}`)] : []),
        ...(r.note ? [kleur.dim(`      ${r.note}`)] : []),
        ...(r.shared ? [kleur.yellow(`  ! shared hooks dir (--shared): ${r.shared}`)] : []),
        ...(r.unreachable
          ? [
              kleur.yellow(
                '  ! your post-commit hook ends in `exit` before the factstack block — it will never run. Move the `exit` below the block.',
              ),
            ]
          : []),
        '',
      ];
      io.stderr.write(lines.join('\n') + '\n');
    } catch (err) {
      io.stderr.write(
        kleur.red('factstack hook install: ') +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      io.setExitCode(1);
    }
    return;
  }
  if (action === 'uninstall') {
    try {
      const r = uninstallGitHook(root, hookOpts);
      io.stderr.write(
        kleur.bold().green('FACTS') +
          kleur.dim(' · hook uninstall') +
          '\n' +
          `  ${kleur.green('✓')} ${relativize(r.hookPath, root)} ${kleur.dim(r.changed ? '(post-commit hook removed)' : '(no factstack hook present)')}` +
          '\n' +
          (r.shared ? kleur.yellow(`  ! shared hooks dir (--shared): ${r.shared}`) + '\n' : '') +
          '\n',
      );
    } catch (err) {
      io.stderr.write(
        kleur.red('factstack hook uninstall: ') +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      io.setExitCode(1);
    }
    return;
  }
  io.stderr.write(
    kleur.red('factstack hook: ') + `unknown action "${action}" (expected: install | uninstall)\n`,
  );
  io.setExitCode(1);
}
