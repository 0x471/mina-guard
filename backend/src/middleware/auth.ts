import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HS256 bearer JWT middleware for `/api/*` (except explicitly-public routes).
 *
 * Trust model: the UI (NextAuth Google provider) issues a short-lived JWT
 * signed with a shared secret. The backend verifies the signature and the
 * email domain against `AUTH_ALLOWED_DOMAINS` (defense-in-depth — the UI
 * also checks this on sign-in). `AUTH_DISABLED=true` short-circuits the
 * check for lightnet / e2e / dev.
 */

function base64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf-8'));
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const given = base64urlDecode(sigB64);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp !== null && exp * 1000 < Date.now()) return null;

  return payload;
}

function emailDomainAllowed(email: string, allowedDomains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.includes(domain);
}

const PUBLIC_ROUTES = new Set(['/health', '/api/indexer/status']);

export function createAuthMiddleware() {
  const disabled = process.env.AUTH_DISABLED === 'true';
  const secret = process.env.AUTH_JWT_SECRET ?? '';
  const allowedDomains = (process.env.AUTH_ALLOWED_DOMAINS ?? 'o1labs.org')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  return (req: Request, res: Response, next: NextFunction) => {
    if (disabled) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (PUBLIC_ROUTES.has(req.path)) return next();
    if (!secret) {
      res.status(500).json({ error: 'AUTH_JWT_SECRET not configured on server' });
      return;
    }
    const authHeader = req.header('authorization') ?? req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = verifyJwt(token, secret);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!email || !emailDomainAllowed(email, allowedDomains)) {
      res.status(403).json({ error: 'Email domain not allowed' });
      return;
    }
    (req as Request & { auth?: { email: string } }).auth = { email };
    next();
  };
}
