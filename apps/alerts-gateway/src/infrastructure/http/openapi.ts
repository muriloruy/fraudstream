import { z } from 'zod';
import { ReplayBody } from './admin.controller.js';
import { ListQuery, ResolveBody, SummaryQuery } from './alerts.controller.js';
import { LoginBody } from './auth.controller.js';

type Role = 'public' | 'cookie' | 'analyst' | 'admin';

interface Operation {
  method: 'get' | 'post';
  path: string;
  summary: string;
  role: Role;
  body?: z.ZodType;
  query?: z.ZodObject;
  responses: Record<string, string>;
}

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

const problem = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
};

/** The gateway's public contract (SPEC §6.8), served as OpenAPI 3.1 at /docs and /docs-json. */
export const OPERATIONS: readonly Operation[] = [
  {
    method: 'post',
    path: '/auth/login',
    summary: 'Email + password → access token + refresh cookie',
    role: 'public',
    body: LoginBody,
    responses: {
      200: 'Logged in',
      400: 'Invalid body',
      401: 'Invalid credentials',
      423: 'Account locked (5 failures, 15 min)',
      429: 'More than 10 attempts per minute',
    },
  },
  {
    method: 'post',
    path: '/auth/refresh',
    summary: 'Rotate the refresh token (reuse revokes the family)',
    role: 'cookie',
    responses: { 200: 'New tokens', 401: 'Missing, expired, revoked or reused token' },
  },
  {
    method: 'post',
    path: '/auth/logout',
    summary: 'Revoke the refresh token and clear cookies',
    role: 'cookie',
    responses: { 204: 'Logged out' },
  },
  {
    method: 'post',
    path: '/auth/stream-session',
    summary: 'Issue the httpOnly cookie for /v1/stream (ADR-006)',
    role: 'analyst',
    responses: { 204: 'Cookie set', 401: 'No access token' },
  },
  {
    method: 'get',
    path: '/v1/alerts',
    summary: 'Alert queue, keyset pagination (score desc, created_at, id)',
    role: 'analyst',
    query: ListQuery,
    responses: { 200: 'A page and nextCursor', 400: 'Invalid filter or tampered cursor' },
  },
  {
    method: 'get',
    path: '/v1/alerts/{id}',
    summary: 'Alert details (audited as ALERT_VIEWED)',
    role: 'analyst',
    responses: { 200: 'Alert with snapshot', 404: 'Unknown alert' },
  },
  {
    method: 'post',
    path: '/v1/alerts/{id}/assign',
    summary: 'Assign to self (IN_PROGRESS)',
    role: 'analyst',
    responses: { 200: 'Assigned', 404: 'Unknown alert', 409: 'Already resolved' },
  },
  {
    method: 'post',
    path: '/v1/alerts/{id}/resolve',
    summary: 'Resolve with a verdict and a note; publishes analyst feedback',
    role: 'analyst',
    body: ResolveBody,
    responses: {
      200: 'Resolved',
      400: 'Missing note or invalid verdict',
      404: 'Unknown alert',
      409: 'Already resolved',
    },
  },
  {
    method: 'get',
    path: '/v1/accounts/{accountId}/timeline',
    summary: 'Last 100 decisions and ledger postings',
    role: 'analyst',
    responses: { 200: 'Timeline, newest first' },
  },
  {
    method: 'get',
    path: '/v1/metrics/summary',
    summary: 'tx/s, decision rates, p95 latency over a window',
    role: 'analyst',
    query: SummaryQuery,
    responses: { 200: 'Summary', 400: 'Invalid window' },
  },
  {
    method: 'get',
    path: '/v1/stream',
    summary: 'SSE: alert.created, alert.updated, decision.made (sampled), metrics.tick',
    role: 'cookie',
    responses: { 200: 'text/event-stream', 401: 'No stream session cookie' },
  },
  {
    method: 'post',
    path: '/admin/dlq/replay',
    summary: 'Replay a DLQ offset range (audited)',
    role: 'admin',
    body: ReplayBody,
    responses: { 200: 'Replay results', 400: 'Invalid range or topic', 403: 'Not an admin' },
  },
  {
    method: 'get',
    path: '/admin/consumers/lag',
    summary: 'Consumer lag per group, topic and partition',
    role: 'admin',
    responses: { 200: 'Lag rows', 403: 'Not an admin' },
  },
];

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const security =
      op.role === 'analyst' || op.role === 'admin'
        ? [{ bearer: [] }]
        : op.role === 'cookie'
          ? [{ refreshCookie: [] }]
          : [];
    const queryParams = op.query
      ? Object.entries(
          (json(op.query) as { properties?: Record<string, unknown> }).properties ?? {},
        ).map(([name, schema]) => ({ name, in: 'query', required: false, schema }))
      : [];
    const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    paths[op.path] ??= {};
    paths[op.path] = {
      ...paths[op.path],
      [op.method]: {
        summary: op.summary,
        description: `Role: ${op.role}`,
        security,
        parameters: [...pathParams, ...queryParams],
        ...(op.body
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: json(op.body) } },
              },
            }
          : {}),
        responses: Object.fromEntries(
          Object.entries(op.responses).map(([status, description]) => [
            status,
            Number(status) >= 400 ? { description, content: problem } : { description },
          ]),
        ),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'FraudStream alerts-gateway',
      version: '1.0.0',
      description: 'Analyst API (SPEC §6.8)',
    },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'fs_refresh' },
      },
      schemas: {
        Problem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { field: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}
