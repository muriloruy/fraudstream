import { request } from 'node:http';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Parsed body; tests narrow it with `as`. */
  json: () => unknown;
  cookies: Map<string, { value: string; attributes: string }>;
}

export interface CallOptions {
  body?: unknown;
  bearer?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  /** Source address on the loopback network (127.0.0.0/8), so each test has its own client IP. */
  from?: string;
}

/** Minimal HTTP client for integration tests; unlike fetch it can pick the client IP. */
export function call(
  base: string,
  method: string,
  path: string,
  o: CallOptions = {},
): Promise<Reply> {
  const url = new URL(path, base);
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  const headers: Record<string, string> = { ...o.headers };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.cookies) {
    headers.cookie = Object.entries(o.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        localAddress: o.from ?? '127.0.0.1',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const cookies = new Map<string, { value: string; attributes: string }>();
          for (const line of res.headers['set-cookie'] ?? []) {
            const [pair = '', ...attrs] = line.split(';');
            const eq = pair.indexOf('=');
            cookies.set(pair.slice(0, eq).trim(), {
              value: pair.slice(eq + 1),
              attributes: attrs.join(';').trim(),
            });
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as unknown,
            cookies,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let nextHost = 10;
/** A fresh loopback client address per caller. */
export const freshIp = (): string => `127.0.0.${String(nextHost++)}`;
