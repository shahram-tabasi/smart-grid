import { createRouter } from '../middleware/safeRouter';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';

export const authRouter = createRouter();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, full_name, role, is_active, can_read_precise_location
     FROM users WHERE email = $1`,
    [String(email).toLowerCase()]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await writeAuditLog({ action: 'LOGIN_FAILED', entityType: 'USER', entityId: user.id, ipAddress: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const authUser = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    canReadPreciseLocation: user.can_read_precise_location,
  };
  const accessToken = signAccessToken(authUser);
  const refreshToken = signRefreshToken(user.id);

  await writeAuditLog({ userId: user.id, action: 'LOGIN', entityType: 'USER', entityId: user.id, ipAddress: req.ip });

  res.json({ accessToken, refreshToken, user: authUser });
});

/**
 * Exchange a refresh token for a new access token.
 *
 * The login response has always issued a refresh token, but nothing could redeem it: this endpoint
 * did not exist and the browser discarded the token. The result was that every session broke with
 * "Invalid or expired token" exactly two hours after signing in, with no way back except clearing
 * storage and logging in again.
 *
 * The user record is re-read rather than trusted from the token, so a deactivated account or a
 * changed role takes effect at the next refresh instead of persisting for the life of the token.
 */
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  let payload: { sub: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: 'Refresh token is invalid or expired. Please sign in again.' });
  }

  const { rows } = await pool.query(
    `SELECT id, email, full_name, role, is_active, can_read_precise_location
     FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account is no longer active. Please sign in again.' });
  }

  const authUser = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    canReadPreciseLocation: user.can_read_precise_location,
  };

  res.json({
    accessToken: signAccessToken(authUser),
    // Rotate the refresh token as well, so a long-lived session does not depend on one token that
    // was issued weeks ago and may have been captured since.
    refreshToken: signRefreshToken(user.id),
    user: authUser,
  });
});

// The /demo-accounts endpoint was removed.
//
// It returned every user's email address, full name and role to anyone who asked, with no
// authentication — it existed only to populate a login-page account picker that has since been
// taken off that page. A staff directory is not something to hand out at the door, and the accounts
// it advertised are documented in docs/OPERATIONS_MANUAL.md where credentials belong.
