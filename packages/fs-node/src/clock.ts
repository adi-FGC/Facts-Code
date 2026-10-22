/**
 * The adapter's clock (INV1). Core stamps `generatedAt` from the value its
 * caller passes, so the artifact is a function of its inputs and the clock
 * is one more input rather than a hidden `new Date()`. SOURCE_DATE_EPOCH
 * (seconds since the epoch, the reproducible-builds convention) pins it;
 * otherwise it is now.
 */
export function generatedAtFromEnv(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): string {
  const raw = env.SOURCE_DATE_EPOCH?.trim();
  if (raw && /^\d{1,12}$/.test(raw)) {
    const d = new Date(Number(raw) * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now().toISOString();
}
