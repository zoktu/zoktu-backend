import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { users, guestUsernames, persistUserToDb } from '../lib/userStore.js';
import User from '../models/User.js';
import Session from '../models/Session.js';
import { randomUUID } from 'crypto';
import { assessIpRisk } from '../lib/ipRisk.js';
import { sendMail } from '../lib/mailer.js';

const router = Router();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELETION_GRACE_PERIOD_MS = 10 * 24 * 60 * 60 * 1000;

const getUserStorageKey = (user) => {
  if (!user) return null;
  return user.email || user.id || null;
};

const getRequestIp = (req) => {
  // prefer X-Forwarded-For when behind proxies
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || null;
};

const enforceDeletionWindow = (user) => {
  if (!user || !user.deletePending || !user.deleteScheduledFor) {
    return { user, expired: false };
  }

  if (Date.now() >= user.deleteScheduledFor) {
    const key = getUserStorageKey(user);
    if (key) {
      users.delete(key);
    }
    return { user: null, expired: true };
  }

  return { user, expired: false };
};

const extractAuthPayload = (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return { error: { status: 401, message: 'Unauthorized' } };
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    return { payload };
  } catch {
    return { error: { status: 401, message: 'Invalid token' } };
  }
};

const resolveUserFromPayload = (payload) => {
  if (!payload) {
    return { user: null, expired: false };
  }
  const candidate = (payload.email && users.get(payload.email)) || findUserByIdentifier(payload.id);
  return enforceDeletionWindow(candidate);
};

const requireRegisteredUser = (req) => {
  const auth = extractAuthPayload(req);
  if (auth.error) return auth;

  const { user, expired } = resolveUserFromPayload(auth.payload);
  if (!user) {
    return {
      error: {
        status: expired ? 410 : 404,
        message: expired ? 'Account already deleted' : 'User not found'
      }
    };
  }

  return { user, payload: auth.payload };
};

const signToken = (user) => jwt.sign({ id: user.id, email: user.email, userType: user.userType || 'registered' }, env.jwtSecret, { expiresIn: '7d' });

const sanitizeUser = (user) => {
  if (!user) return null;
  const {
    password,
    resetToken,
    resetTokenExpires,
    deleteRequestedAt,
    deleteScheduledFor,
    deletePending,
    ...safeUser
  } = user;
  return safeUser;
};

const createSessionForUser = async (userId, req) => {
  try {
    const sessionId = (typeof randomUUID === 'function') ? randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const ip = getRequestIp(req);
    const riskInfo = await assessIpRisk(ip).catch(() => ({ risk: false }));
    const doc = new Session({
      sessionId,
      userId: userId || null,
      deviceId: req.body?.deviceId || req.headers['x-device-id'] || null,
      userAgent: req.headers['user-agent'] || null,
      ip,
      risk: Boolean(riskInfo?.risk),
      riskScore: riskInfo?.score || null,
      riskReason: riskInfo?.reason || null
    });
    await doc.save();
    return sessionId;
  } catch (e) {
    console.warn('⚠️ Failed to create session', e?.message || e);
    return null;
  }
};

const findUserByIdentifier = (identifier) => {
  if (!identifier) return null;
  if (users.has(identifier)) {
    return users.get(identifier);
  }
  return Array.from(users.values()).find((entry) => entry.id === identifier) || null;
};

const validateUsername = (username) => {
  if (!username || !username.trim()) {
    return { valid: false, error: 'Username is required' };
  }
  const trimmed = username.trim();
  if (trimmed.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }
  if (trimmed.length > 20) {
    return { valid: false, error: 'Username must be less than 20 characters' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
  }
  if (/^[0-9]/.test(trimmed)) {
    return { valid: false, error: 'Username cannot start with a number' };
  }
  return { valid: true, username: trimmed };
};

// Guest username validation: allow 2-character names (other rules same)
const validateGuestUsername = (username) => {
  if (!username || !username.trim()) {
    return { valid: false, error: 'Username is required' };
  }
  const trimmed = username.trim();
  if (trimmed.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }
  if (trimmed.length > 20) {
    return { valid: false, error: 'Username must be less than 20 characters' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
  }
  if (/^[0-9]/.test(trimmed)) {
    return { valid: false, error: 'Username cannot start with a number' };
  }
  return { valid: true, username: trimmed };
};

router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body;
  console.log('➡️ /api/auth/signup called', { email: !!email, hasAuthorization: !!req.headers.authorization });
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });

  // If request contains an auth token, and it's a guest, convert that guest
  const auth = extractAuthPayload(req);
  let convertingGuest = null;
  console.log('   signup auth result:', auth.error ? { error: auth.error.message } : { payload: auth.payload });
  if (!auth.error && auth.payload && auth.payload.userType === 'guest') {
    const candidate = findUserByIdentifier(auth.payload.id) || users.get(auth.payload.id);
    if (candidate && candidate.userType === 'guest') {
      convertingGuest = candidate;
    }
  }

  const hash = await bcrypt.hash(password, 10);

  if (convertingGuest) {
    // Convert existing guest to registered while preserving displayName
    if (users.has(email)) return res.status(409).json({ message: 'email already in use' });
    convertingGuest.email = email;
    convertingGuest.password = hash;
    convertingGuest.userType = 'registered';
    // prefer provided displayName only if guest has none
    convertingGuest.displayName = convertingGuest.displayName || displayName || email;
    convertingGuest.name = convertingGuest.displayName;

    try {
      convertingGuest.lastIp = getRequestIp(req);
      const saved = await persistUserToDb(convertingGuest);
      users.set(email, convertingGuest);
      users.set(convertingGuest.id, convertingGuest);
      const token = signToken(convertingGuest);
      const sessionId = await createSessionForUser(convertingGuest.id, req);
      return res.json({ user: sanitizeUser(convertingGuest), token, sessionId });
    } catch (e) {
      console.warn('⚠️ Failed to persist converted guest to registered user', e?.message || e);
      // fallthrough to in-memory registration
    }
  }

  // Regular signup (no guest conversion)
  const profileName = displayName || email;
  const user = {
    id: String(users.size + 1),
    email,
    displayName: profileName,
    name: profileName,
    userType: 'registered',
    password: hash,
    emailVerified: false
  };
  // persist to DB and in-memory
  try {
    user.lastIp = getRequestIp(req);
    await persistUserToDb(user);
  } catch (e) {
    // non-fatal: continue using in-memory copy
  }
  users.set(email, user);
  const token = signToken(user);
  const sessionId = await createSessionForUser(user.id, req);
  res.json({ user: sanitizeUser(user), token, sessionId });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ message: 'Email is required' });
  }

  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ message: 'Please provide a valid email address' });
  }

      // Fire-and-forget: send verification email if we have an address
      try {
        if (convertingGuest.email) {
          const vToken = jwt.sign({ email: convertingGuest.email, purpose: 'verify_email' }, env.jwtSecret, { expiresIn: '1d' });
          const verifyUrl = `${env.clientOrigin.replace(/\/$/, '')}/auth/verify-email?token=${encodeURIComponent(vToken)}`;
          const html = `<p>Hi ${convertingGuest.displayName || ''},</p><p>Thanks for signing up. Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>If you didn't sign up, ignore this message.</p>`;
          sendMail({ to: convertingGuest.email, subject: 'Verify your ChitZ account', html }).catch((e) => console.warn('⚠️ verify-email send failed', e?.message || e));
        }
      } catch (e) {
        console.warn('⚠️ Failed to queue verification email', e?.message || e);
      }
      res.json({ user: sanitizeUser(convertingGuest), token, sessionId });
  const user = Array.from(users.values()).find((u) => (u.email || '').toLowerCase() === normalized);

  if (user) {
    user.resetToken = `reset-${Date.now()}`;
    user.resetTokenExpires = Date.now() + 20 * 60 * 1000; // 20 minutes
    try { await persistUserToDb(user); } catch (_) {}
    // send reset email (non-blocking)
    try {
      const resetUrl = `${env.clientOrigin.replace(/\/$/, '')}/auth/reset-password?token=${encodeURIComponent(user.resetToken)}`;
      const html = `<p>Hi ${user.displayName || ''},</p><p>We received a request to reset your password. Click the link below to reset it (valid for 20 minutes):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, ignore this message.</p>`;
      sendMail({ to: user.email, subject: 'Reset your ChitZ password', html }).catch((e) => console.warn('⚠️ reset-email send failed', e?.message || e));
    } catch (e) {
      console.warn('⚠️ Failed to queue reset email', e?.message || e);
    }
  }

  res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const lookup = users.get(email);
  if (!lookup) return res.status(401).json({ message: 'invalid credentials' });

  const { user, expired } = enforceDeletionWindow(lookup);
  if (!user) {
    return res.status(expired ? 410 : 401).json({ message: expired ? 'Account already deleted' : 'invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: 'invalid credentials' });
  const hadPendingDeletion = Boolean(user.deletePending);
  if (hadPendingDeletion) {
    delete user.deletePending;
    delete user.deleteRequestedAt;
    delete user.deleteScheduledFor;
  }

  if (user.email) {
    try { user.lastIp = getRequestIp(req); await persistUserToDb(user); } catch (_) {}
    users.set(user.email, user);
  }

  const token = signToken(user);
  const sessionId = await createSessionForUser(user.id, req);
  res.json({ user: sanitizeUser(user), token, deletionRecovered: hadPendingDeletion, sessionId });
}));

router.post('/guest', asyncHandler(async (req, res) => {
  const { name } = req.body;

  // Validate username
  const validation = validateGuestUsername(name);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.error });
  }

  const username = validation.username;

  // Quick in-memory check (fast-fail), but we must also use an atomic DB upsert
  if (guestUsernames.has(username.toLowerCase())) {
    return res.status(409).json({ message: 'Username already taken' });
  }

  // Prevent guest creation if a registered user already has this displayName (case-insensitive)
  // Check in-memory first
  const registeredCollision = Array.from(users.values()).find((u) => {
    return u && u.userType !== 'guest' && (u.displayName || '').toLowerCase() === username.toLowerCase();
  });
  if (registeredCollision) {
    return res.status(409).json({ message: 'Username already taken by a registered user' });
  }

  // Also check in MongoDB (case-insensitive) to avoid races with other processes
  try {
    const existingRegistered = await User.findOne({ displayName: { $regex: `^${username}$`, $options: 'i' }, userType: { $ne: 'guest' } }).lean().exec();
    if (existingRegistered) {
      return res.status(409).json({ message: 'Username already taken by a registered user' });
    }
  } catch (e) {
    console.warn('⚠️ Could not check registered displayName collision in DB', e?.message || e);
    // continue — we'll still attempt the upsert and rely on DB unique constraints for guests
  }

  // Use an atomic findOneAndUpdate with upsert to avoid race conditions
  try {
    const now = new Date();
    const saved = await User.findOneAndUpdate(
      { displayName: username, userType: 'guest' },
      {
        $setOnInsert: {
          guestId: `guest-${Date.now()}`,
          displayName: username,
          userType: 'guest',
          createdAt: now
        },
        $set: { lastIp: getRequestIp(req) }
      },
      { upsert: true, new: true }
    ).lean().exec();

    // Build the in-memory user object
    const user = {
      id: saved.guestId || String(saved._id),
      email: '',
      displayName: saved.displayName,
      userType: 'guest',
      createdAt: saved.createdAt
    };

    // update in-memory maps
    try { user.lastIp = getRequestIp(req); await persistUserToDb(user); } catch (e) {}
    guestUsernames.set(username.toLowerCase(), user.id);
    users.set(user.id, user);

    const token = signToken(user);
    const sessionId = await createSessionForUser(user.id, req);
    return res.json({ user, token, sessionId });
  } catch (e) {
    // Duplicate key may happen if another request inserted the same name concurrently
    if (e && e.code === 11000) {
      return res.status(409).json({ message: 'Username already taken' });
    }
    console.warn('⚠️ Failed to persist guest user', e?.message || e);
    // Fall back to in-memory guest (non-persistent)
    const fallbackId = `guest-${Date.now()}`;
    const user = { id: fallbackId, email: '', displayName: username, userType: 'guest' };
    guestUsernames.set(username.toLowerCase(), user.id);
    users.set(user.id, user);
    const token = signToken(user);
    const sessionId = await createSessionForUser(user.id, req);
    return res.json({ user, token, sessionId });
  }
}));

// Check if username is available
router.get('/check-username', (req, res) => {
  const { username } = req.query;
  
  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }
  
  // Use guest-specific validation (allows 2-character guest names)
  const validation = validateGuestUsername(username);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.error, available: false });
  }

  // Check if username exists (case-insensitive)
  const exists = guestUsernames.has(validation.username.toLowerCase());
  if (exists) {
    return res.status(409).json({ message: 'Username already taken', available: false });
  }

  return res.json({ message: 'Username is available', available: true });
});

router.get('/me', (req, res) => {
  const auth = extractAuthPayload(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const { payload } = auth;
  const { user, expired } = resolveUserFromPayload(payload);
  if (!user && expired) {
    return res.status(410).json({ message: 'Account already deleted' });
  }

  const displayName = user?.displayName || payload.email || 'User';
  // Include profile fields so frontend can show them on refresh
  res.json({
    id: user?.id || payload.id,
    uid: user?.id || payload.id,
    email: payload.email,
    userType: payload.userType,
    name: displayName,
    displayName,
    emailVerified: user?.emailVerified ?? false,
    avatar: user?.avatar || user?.photoURL || null,
    bio: user?.bio || '',
    settings: user?.settings || {},
    createdAt: user?.createdAt || payload.iat ? new Date() : undefined
  });
});

router.post('/logout', (_req, res) => {
  res.json({ message: 'logged out' });
});

router.post('/resend-verification', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }
  const record = users.get(email);
  if (!record) {
    return res.status(404).json({ message: 'User not found' });
  }
  const { user, expired } = enforceDeletionWindow(record);
  if (!user) {
    return res.status(expired ? 410 : 404).json({ message: expired ? 'Account already deleted' : 'User not found' });
  }
  user.lastVerificationSentAt = Date.now();
  users.set(email, user);
  res.json({ message: 'Verification email dispatched (stub)' });
});

router.post('/verify-email', asyncHandler(async (req, res) => {
  const auth = requireRegisteredUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const { user } = auth;
  if (user.email) {
    try { await persistUserToDb(user); } catch (_) {}
    users.set(user.email, user);
  }

  user.emailVerified = true;
  users.set(user.email, user);
  res.json({ message: 'Email verified successfully', user: sanitizeUser(user) });
}));

router.post('/change-password', asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current and new passwords are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }
  const auth = requireRegisteredUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const { user } = auth;
  if (!user || !user.password) {
    return res.status(400).json({ message: 'Unable to change password for this account' });
  }

  const matches = await bcrypt.compare(currentPassword, user.password);
  if (!matches) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  users.set(user.email, user);
  res.json({ message: 'Password updated successfully' });
}));

router.get('/deletion-status', (req, res) => {
  const auth = requireRegisteredUser(req);
  if (auth.error) {
    const status = auth.error.status || 400;
    const message = auth.error.status === 404 ? 'Only registered accounts can schedule deletion' : auth.error.message;
    return res.status(status).json({ message });
  }

  const { user } = auth;
  const pending = Boolean(user.deletePending && user.deleteScheduledFor && user.deleteScheduledFor > Date.now());
  res.json({
    pending,
    scheduledFor: pending ? user.deleteScheduledFor : null,
    daysRemaining: pending ? Math.max(0, Math.ceil((user.deleteScheduledFor - Date.now()) / (24 * 60 * 60 * 1000))) : 0
  });
});

router.post('/delete-account', (req, res) => {
  const auth = requireRegisteredUser(req);
  if (auth.error) {
    const status = auth.error.status || 400;
    const message = auth.error.status === 404 ? 'Only registered accounts can schedule deletion' : auth.error.message;
    return res.status(status).json({ message });
  }

  const { user } = auth;
  const now = Date.now();
  user.deletePending = true;
  user.deleteRequestedAt = now;
  user.deleteScheduledFor = now + DELETION_GRACE_PERIOD_MS;
  const key = getUserStorageKey(user);
  if (key) {
    users.set(key, user);
  }

  res.json({
    message: 'Account scheduled for deletion in 10 days',
    scheduledFor: user.deleteScheduledFor
  });
});

router.post('/cancel-deletion', (req, res) => {
  const auth = requireRegisteredUser(req);
  if (auth.error) {
    const status = auth.error.status || 400;
    const message = auth.error.status === 404 ? 'Only registered accounts can cancel deletion' : auth.error.message;
    return res.status(status).json({ message });
  }

  const { user } = auth;
  if (!user.deletePending) {
    return res.status(400).json({ message: 'No deletion scheduled' });
  }

  delete user.deletePending;
  delete user.deleteRequestedAt;
  delete user.deleteScheduledFor;
  const key = getUserStorageKey(user);
  if (key) {
    users.set(key, user);
  }

  res.json({ message: 'Deletion request canceled' });
});

export default router;
