/**
 * mini-shop entrypoint: boots the HTTP server and registers the API routes.
 */
import { registerRoutes } from './api/routes';
import { connect } from './db/client';

export interface ServerConfig {
  port: number;
  host: string;
}

export async function main(config: ServerConfig = { port: 3000, host: '127.0.0.1' }): Promise<void> {
  await connect();
  const routes = registerRoutes();
  // In the real app this would hand `routes` to an HTTP framework; the
  // fixture stops at wiring so the corpus stays dependency-free.
  console.log(`mini-shop listening on ${config.host}:${config.port} with ${routes.length} routes`);
}
