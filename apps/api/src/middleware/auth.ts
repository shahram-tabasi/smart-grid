import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@simorgh/shared';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

/**
 * Refresh tokens are signed with a DIFFERENT key from access tokens.
 *
 * Both used to be signed with JWT_SECRET, which made them interchangeable: a 30-day refresh token
 * passed requireAuth and authenticated the request as a user whose `id` and `role` were undefined.
 * That is an authentication bypass on every endpoint guarded by requireAuth alone, and it also
 * meant audit rows could be written with an undefined user id.
 *
 * Derived from JWT_SECRET rather than required as new configuration, so existing deployments and
 * the installers keep working untouched; set JWT_REFRESH_SECRET to use an independent key.
 * Separate keys plus the `type` claim checked below mean neither token can stand in for the other.
 */
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || `${JWT_SECRET}:refresh-v1`;

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  canReadPreciseLocation: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ ...user, type: 'access' }, JWT_SECRET, { expiresIn: '2h' });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: 'refresh' }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
}

/**
 * Throws unless the token is genuinely a refresh token: right key, right type, real subject.
 * Callers turn the throw into a 401. Passing an access token here previously got as far as a user
 * lookup with an undefined id, which then reported the misleading "Account is no longer active".
 */
export function verifyRefreshToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as { sub?: unknown; type?: unknown };
  if (decoded.type !== 'refresh') throw new Error('Not a refresh token');
  if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) throw new Error('Refresh token has no subject');
  return { sub: decoded.sub };
}

/**
 * READ-ONLY BOUNDARY: this middleware (and every route it protects) only ever gates access to
 * data retrieval or acknowledgement/assignment workflows. There is no route anywhere in this API
 * that issues a command to a relay or breaker — see docs/ARCHITECTURE.md §2/§10.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET) as AuthUser & { type?: string };
    // A refresh token must never authenticate a request, and a token with no identity must never
    // reach a route handler that will read req.user.id.
    if (decoded.type === 'refresh' || !decoded.id || !decoded.role) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires one of roles: ${roles.join(', ')}` });
    }
    next();
  };
}

export function requirePrecisionLocationAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.canReadPreciseLocation) {
    return res.status(403).json({
      error: 'Precise location access is not authorized for this account. Only province/city level detail is available by default.',
    });
  }
  next();
}
