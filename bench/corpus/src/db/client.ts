/**
 * Shared database client. Every model funnels through `query` so there is a
 * single choke point for connection pooling, retries, and tracing.
 */
let connected = false;

export async function connect(): Promise<void> {
  connected = true;
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  if (!connected) throw new Error('db: query before connect()');
  // The fixture is storage-free; a real client would hit sqlite/postgres here.
  void sql;
  void params;
  return null;
}
