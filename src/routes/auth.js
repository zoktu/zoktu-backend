import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Placeholder in-memory store
const users = new Map();
const guestUsernames = new Map(); // Track guest usernames
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELETION_GRACE_PERIOD_MS = 10 * 24 * 60 * 60 * 1000;

const getUserStorageKey = (user) => {
  if (!user) return null;
  return user.email || user.id || null;
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

router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });
  if (users.has(email)) return res.status(409).json({ message: 'user exists' });
  const hash = await bcrypt.hash(password, 10);
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
  users.set(email, user);
  const token = signToken(user);
  res.json({ user: sanitizeUser(user), token });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ message: 'Email is required' });
  }

  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ message: 'Please provide a valid email address' });
  }

  const normalized = email.trim().toLowerCase();
  const user = Array.from(users.values()).find((u) => (u.email || '').toLowerCase() === normalized);

  if (user) {
    user.resetToken = `reset-${Date.now()}`;
    user.resetTokenExpires = Date.now() + 20 * 60 * 1000; // 20 minutes
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
    users.set(user.email, user);
  }

  const token = signToken(user);
  res.json({ user: sanitizeUser(user), token, deletionRecovered: hadPendingDeletion });
}));

router.post('/guest', (req, res) => {
  const { name } = req.body;
  
  // Validate username
  const validation = validateUsername(name);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.error });
  }
  
  const username = validation.username;
  
  // Check if username already exists
  if (guestUsernames.has(username.toLowerCase())) {
    return res.status(409).json({ message: 'Username already taken' });
  }
  
  const userId = `guest-${Date.now()}`;
  const user = { 
    id: userId, 
    email: '', 
    displayName: username, 
    userType: 'guest' 
  };
  
  guestUsernames.set(username.toLowerCase(), userId);
  
  const token = signToken(user);
  res.json({ user, token });
});

// Check if username is available
router.get('/check-username', (req, res) => {
  const { username } = req.query;
  
  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }
  
  // Validate username format
  const validation = validateUsername(username);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.error, available: false });
  }
  
  // Check if username exists
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
  res.json({
    id: user?.id || payload.id,
    uid: user?.id || payload.id,
    email: payload.email,
    userType: payload.userType,
    name: displayName,
    displayName,
    emailVerified: user?.emailVerified ?? false
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
  if (!user.email) {
    return res.status(400).json({ message: 'No email linked to verify' });
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
