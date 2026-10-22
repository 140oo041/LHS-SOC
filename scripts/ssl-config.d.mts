import type { ConnectionOptions } from "node:tls";

export function sslConfig(
  connectionString: string,
  env?: Record<string, string | undefined>,
): ConnectionOptions | false | undefined;

export function insecureSslReason(connectionString: string, env?: Record<string, string | undefined>): string | null;
