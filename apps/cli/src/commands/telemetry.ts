/** `factstack telemetry [status|export|reset|opt-in|opt-out]`: the local-first usage metrics. */
import kleur from 'kleur';
import { processIO, type CliIO } from '../io.js';
import { createTelemetry } from '../telemetry.js';

export interface TelemetryOptions {
  json?: boolean;
}

export async function telemetryCommand(
  action: string | undefined,
  opts: TelemetryOptions,
  io: CliIO = processIO,
): Promise<void> {
  const act = (action ?? 'status').toLowerCase();
  /* CLI-11: a mistyped opt-out (`optout`, `off`) used to fall through to
     the status screen with exit 0 — the user believed they had opted out. */
  const ACTIONS = ['status', 'export', 'reset', 'opt-in', 'opt-out'];
  if (!ACTIONS.includes(act)) {
    io.stderr.write(
      kleur.red('factstack telemetry: ') +
        `unknown action "${action}". Expected: ${ACTIONS.join(' | ')}\n`,
    );
    io.exit(1);
  }
  const t = createTelemetry();

  if (act === 'opt-in') {
    await t.setOptedIn(true);
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · telemetry: ') +
        'opted IN to anonymous remote pingback.\n',
    );
    io.stderr.write(
      kleur.dim(
        '  remote events are sent only when FACTSTACK_TELEMETRY_URL is also set; data stays local otherwise.\n',
      ),
    );
    return;
  }
  if (act === 'opt-out') {
    await t.setOptedIn(false);
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · telemetry: ') +
        'opted OUT. Local metrics still collected; nothing leaves this machine.\n',
    );
    return;
  }
  if (act === 'reset') {
    await t.reset();
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · telemetry: ') +
        'local metrics + install ID deleted.\n',
    );
    return;
  }

  const data = await t.exportData();
  if (act === 'export' || opts.json) {
    io.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  // status (TTY)
  const m = data.metrics;
  const typeCount = Object.keys(m.events).length;
  const totalEvents = Object.values(m.events).reduce((a, b) => a + b, 0);
  const avg =
    m.durationsMs.length > 0
      ? Math.round(m.durationsMs.reduce((a, b) => a + b, 0) / m.durationsMs.length)
      : 0;
  const lines = [
    '',
    kleur.bold().green('FACTS') + kleur.dim(' · telemetry'),
    kleur.dim('  ─────────────'),
    `  install ID   ${kleur.dim(data.installId ?? '(none yet)')}`,
    `  opted in     ${data.optedIn ? kleur.green('yes') : kleur.dim('no (local only)')}`,
    `  remote URL   ${data.remoteUrl ? kleur.cyan(data.remoteUrl) : kleur.dim('(unset — set FACTSTACK_TELEMETRY_URL)')}`,
    `  events       ${kleur.cyan(String(totalEvents))} across ${typeCount} type${typeCount === 1 ? '' : 's'}`,
    `  avg scan     ${avg ? kleur.cyan(avg + ' ms') : kleur.dim('—')} ${kleur.dim(`(last ${m.durationsMs.length})`)}`,
    '',
    kleur.dim(
      `  data: ${t.dir}  ·  opt in: factstack telemetry opt-in  ·  wipe: factstack telemetry reset`,
    ),
    '',
  ];
  io.stderr.write(lines.join('\n') + '\n');
}
