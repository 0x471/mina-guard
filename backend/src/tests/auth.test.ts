import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createAuthMiddleware } from '../middleware/auth.js';

const SECRET = 'test-secret-please-rotate';

function base64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Builds an HS256-signed JWT mirroring the NextAuth default payload shape. */
function makeToken(payload: Record<string, unknown>, secret = SECRET, alg = 'HS256'): string {
  const header = base64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${base64url(sig)}`;
}

/**
 * Invokes the middleware against a fake (req, res, next) trio and resolves
 * with the outcome we observe: either next() fired, or res.status(...).json(...)
 * was called.
 */
function runMiddleware(
  req: Partial<Request>,
): Promise<{ status: number | null; body: unknown; nexted: boolean }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    let body: unknown = null;
    const res: Partial<Response> = {
      status(code: number) {
        status = code;
        return res as Response;
      },
      json(payload: unknown) {
        body = payload;
        resolve({ status, body, nexted: false });
        return res as Response;
      },
    };
    const next: NextFunction = () => {
      resolve({ status, body, nexted: true });
    };
    const middleware = createAuthMiddleware();
    middleware(req as Request, res as Response, next);
  });
}

function request(overrides: Partial<Request> & { path: string; headers?: Record<string, string> }): Partial<Request> {
  const headers = overrides.headers ?? {};
  return {
    path: overrides.path,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as Partial<Request>;
}

describe('auth middleware', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['AUTH_DISABLED', 'AUTH_JWT_SECRET', 'AUTH_ALLOWED_DOMAINS']) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_ALLOWED_DOMAINS = 'o1labs.org';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('public /health passes without a token', async () => {
    const out = await runMiddleware(request({ path: '/health' }));
    expect(out.nexted).toBe(true);
  });

  test('non-/api/ routes pass without a token', async () => {
    const out = await runMiddleware(request({ path: '/some/public/asset' }));
    expect(out.nexted).toBe(true);
  });

  test('AUTH_DISABLED=true short-circuits', async () => {
    process.env.AUTH_DISABLED = 'true';
    const out = await runMiddleware(request({ path: '/api/contracts' }));
    expect(out.nexted).toBe(true);
  });

  test('missing bearer yields 401', async () => {
    const out = await runMiddleware(request({ path: '/api/contracts' }));
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });

  test('valid token with allowed domain passes', async () => {
    const token = makeToken({
      email: 'user@o1labs.org',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(true);
  });

  test('valid signature but disallowed domain yields 403', async () => {
    const token = makeToken({
      email: 'intruder@evil.com',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(403);
  });

  test('forged signature yields 401', async () => {
    const token = makeToken({ email: 'user@o1labs.org' }, 'wrong-secret');
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });

  test('expired token yields 401', async () => {
    const token = makeToken({
      email: 'user@o1labs.org',
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });

  test('unsupported alg (none) yields 401', async () => {
    const token = makeToken(
      { email: 'user@o1labs.org', exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
      'none',
    );
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });

  test('malformed JWT yields 401', async () => {
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: 'Bearer not.a.token' } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(401);
  });

  test('missing AUTH_JWT_SECRET yields 500', async () => {
    delete process.env.AUTH_JWT_SECRET;
    const token = makeToken({ email: 'user@o1labs.org' });
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(500);
  });

  test('multi-domain allowlist accepts any configured domain', async () => {
    process.env.AUTH_ALLOWED_DOMAINS = 'o1labs.org, example.com';
    const token = makeToken({
      email: 'ops@example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const out = await runMiddleware(
      request({ path: '/api/contracts', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(out.nexted).toBe(true);
  });
});
