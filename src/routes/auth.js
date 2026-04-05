import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { users, guestUsernames, persistUserToDb, upsertUserInMemory } from '../lib/userStore.js';
import User from '../models/User.js';
import { containsProfanity } from '../middleware/profanityFilter.js';
import Session from '../models/Session.js';
import { randomUUID } from 'crypto';
import { assessIpRisk } from '../lib/ipRisk.js';
import { sendMail } from '../lib/mailer.js';

const router = Router();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELETION_GRACE_PERIOD_MS = 10 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

const buildEmailVerifyUrl = ({ token }) => {
  // Prefer backend origin if explicitly provided; fallback to client origin with dev proxy
  const base = String(env.apiOrigin || env.clientOrigin || '').replace(/\/$/, '');
  return `${base}/api/auth/verify-email?token=${encodeURIComponent(String(token))}`;
};

const issueEmailVerification = async ({ email, displayName }) => {
  const cleanEmail = (email || '').toString().trim();
  if (!cleanEmail) return null;

  const token = `verify-${(typeof randomUUID === 'function') ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const expires = Date.now() + EMAIL_VERIFY_TTL_MS;

  try {
    await User.updateOne(
      { email: cleanEmail },
      { $set: { emailVerificationToken: token, emailVerificationTokenExpires: expires, emailVerified: false } }
    ).exec();
  } catch (e) {
    console.warn('⚠️ Failed to persist email verification token', e?.message || e);
  }

  // Keep in-memory user in sync (best-effort)
  try {
    const cached = users.get(cleanEmail);
    if (cached) {
      cached.emailVerificationToken = token;
      cached.emailVerificationTokenExpires = expires;
      cached.emailVerified = false;
      users.set(cleanEmail, cached);
    }
  } catch (_) {}

  const verifyUrl = buildEmailVerifyUrl({ token });
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">
      <p>Hi ${String(displayName || '').trim() || 'there'},</p>
      <p>Thanks for signing up to Zoktu. Please verify your email address by clicking the button below:</p>
      <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">Verify Email</a></p>
      <p style="font-size:12px;color:#6b7280">This link expires in 24 hours. If you didn’t create an account, you can ignore this email.</p>
      <p style="font-size:12px;color:#6b7280">If the button doesn’t work, copy/paste this link:<br/>${verifyUrl}</p>
    </div>
  `;

  try {
    const info = await sendMail({ to: cleanEmail, subject: 'Verify your Zoktu email', html });
    const msgId = info?.messageId ? String(info.messageId) : null;
    const resp = info?.response ? String(info.response) : null;
    console.log('✅ verify-email sent', { to: cleanEmail, messageId: msgId, response: resp });
  } catch (e) {
    console.warn('⚠️ verify-email send failed', e?.message || e);
  }

  return { token, expires };
};

const getUserStorageKey = (user) => {
  if (!user) return null;
  return user.email || user.id || null;
};

// Simple endpoint for frontend to verify a Turnstile token and mark verification.
// Frontend calls POST /api/auth/turnstile-verify with { turnstileToken }.
// Legacy route retained for compatibility; verification is disabled.
router.post('/turnstile-verify', asyncHandler(async (req, res) => {
  return res.json({ success: true });
}));

const getRequestIp = (req) => {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') {
    return cfIp.trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    return realIp.trim();
  }

  // prefer X-Forwarded-For when behind proxies
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    const list = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (list[0]) return list[0];
  }

  return req.socket.remoteAddress || '';
};

/**
 * Internal helper to check if a user's premium subscription has expired.
 * If expired, it updates both the MongoDB document and the in-memory cache.
 */
const checkPremiumExpiration = async (userDoc) => {
  if (!userDoc || !userDoc.isPremium || !userDoc.premiumUntil) return userDoc;

  const now = new Date();
  const expiry = new Date(userDoc.premiumUntil);

  if (now > expiry) {
    try {
      console.log(`[Premium] VIP Expiring for user: ${userDoc._id || userDoc.id || 'unknown'}`);
      
      // Update MongoDB (atomic)
      await User.updateOne(
        { _id: userDoc._id },
        { $set: { isPremium: false, premiumStatus: 'free' } }
      ).exec();

      // Mutate local object to reflect change in the current request response
      userDoc.isPremium = false;
      userDoc.premiumStatus = 'free';

      // Synchronize in-memory user store/cache
      const emailKey = userDoc.email ? String(userDoc.email).trim().toLowerCase() : null;
      if (emailKey && users.has(emailKey)) {
        const cached = users.get(emailKey);
        if (cached) {
          cached.isPremium = false;
          cached.premiumStatus = 'free';
          users.set(emailKey, cached);
        }
      }
      
      // Also try sync by ID/guestId if available
      const idKey = String(userDoc.id || userDoc._id || '').trim();
      if (idKey && users.has(idKey)) {
        const cached = users.get(idKey);
        if (cached) {
          cached.isPremium = false;
          cached.premiumStatus = 'free';
          users.set(idKey, cached);
        }
      }
    } catch (e) {
      console.warn('⚠️ Failed to auto-expire premium status', e?.message || e);
    }
  }

  return userDoc;
};


const resolveClientOrigin = () => {
  const raw = String(env.clientOrigin || '').trim();
  if (!raw) return 'https://zoktu.com';
  const first = raw.split(',').map(s => s.trim()).filter(Boolean)[0];
  return first || 'https://zoktu.com';
};

const buildRestrictedUrl = () => `${resolveClientOrigin().replace(/\/$/, '')}/access-restricted`;

// Public pre-auth risk check for login/register pages.
router.get('/risk-check', asyncHandler(async (req, res) => {
  const ip = getRequestIp(req);
  const riskInfo = await assessIpRisk(ip, {
    userAgent: req.headers['user-agent'] || '',
    userLanguage: req.headers['accept-language'] || ''
  }).catch(() => ({ risk: false }));
  const blocked = Boolean(riskInfo?.risk);

  return res.json({
    blocked,
    score: riskInfo?.score || 0,
    redirectUrl: blocked ? buildRestrictedUrl() : null,
    reason: blocked ? (riskInfo?.reason || 'vpn/proxy/tor') : null
  });
}));

const resolveClientPlatform = (req) => {
  const headerValue = req.headers['x-client-platform'] || req.headers['x-platform'];
  const bodyValue = req.body?.platform;
  const platform = String(bodyValue || headerValue || 'web').trim().toLowerCase();
  return platform || 'web';
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

const finalizeDeletionIfDue = async (user) => {
  if (!user) return { deleted: false };
  const scheduledFor = Number(user.deleteScheduledFor || 0);
  const pending = Boolean(user.deletePending && scheduledFor);
  if (!pending) return { deleted: false };
  if (Date.now() < scheduledFor) return { deleted: false };

  // Remove from Mongo (registered email is the primary key)
  try {
    if (user.email) {
      await User.deleteOne({ email: String(user.email) }).exec();
    } else if (user._id) {
      await User.deleteOne({ _id: String(user._id) }).exec();
    } else if (user.id && /^[a-f\d]{24}$/i.test(String(user.id))) {
      await User.deleteOne({ _id: String(user.id) }).exec();
    }
  } catch (e) {
    console.warn('⚠️ Failed to finalize account deletion in DB', e?.message || e);
  }

  // Remove from in-memory cache
  try {
    const key = getUserStorageKey(user);
    if (key) users.delete(key);
    if (user.id) users.delete(String(user.id));
    if (user.guestId) users.delete(String(user.guestId));
  } catch (_) {}

  return { deleted: true };
};

const validateSessionFromPayload = async (payload) => {
  if (!payload?.sessionId) {
    return { error: { status: 401, message: 'Session expired' } };
  }
  const sessionId = String(payload.sessionId);
  const session = await Session.findOne({ sessionId, revoked: { $ne: true } }).lean().exec();
  if (!session) {
    return { error: { status: 401, message: 'Session expired' } };
  }
  const payloadId = String(payload.id || payload.userId || payload._id || payload.guestId || '');
  if (!payloadId || String(session.userId) !== payloadId) {
    return { error: { status: 401, message: 'Session expired' } };
  }

  // Best-effort last active update
  Session.updateOne({ sessionId }, { $set: { lastActive: new Date() } }).catch(() => {});
  return { session };
};

const extractAuthPayload = async (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return { error: { status: 401, message: 'Unauthorized' } };
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const sessionCheck = await validateSessionFromPayload(payload);
    if (sessionCheck.error) return { error: sessionCheck.error };
    return { payload, session: sessionCheck.session };
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

const requireRegisteredUser = async (req) => {
  const auth = await extractAuthPayload(req);
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

const signToken = (user, sessionId) => jwt.sign({
  id: user.id,
  email: user.email,
  userType: user.userType || 'registered',
  sessionId: sessionId || undefined
}, env.jwtSecret, { expiresIn: '7d' });

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
    const platform = resolveClientPlatform(req);
    const cleanUserId = userId ? String(userId) : null;
    if (cleanUserId) {
      await Session.updateMany(
        { userId: cleanUserId, platform, revoked: { $ne: true } },
        { $set: { revoked: true, revokedAt: new Date() } }
      ).exec();
    }
    const sessionId = (typeof randomUUID === 'function') ? randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const ip = getRequestIp(req);
    const riskInfo = await assessIpRisk(ip, {
      userAgent: req.headers['user-agent'] || '',
      userLanguage: req.headers['accept-language'] || ''
    }).catch(() => ({ risk: false }));
    const doc = new Session({
      sessionId,
      userId: cleanUserId,
      deviceId: req.body?.deviceId || req.headers['x-device-id'] || null,
      platform,
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

const DEFAULT_AVATAR_BY_GENDER = {
  female: '/avatars/default-female.svg',
  male: '/avatars/default-male.svg'
};

const resolveDefaultAvatar = (gender) => {
  const g = String(gender || '').toLowerCase();
  return g === 'female' ? DEFAULT_AVATAR_BY_GENDER.female : DEFAULT_AVATAR_BY_GENDER.male;
};

const validateGenderAge = (body) => {
  const genderRaw = String(body?.gender || '').trim().toLowerCase();
  if (genderRaw !== 'male' && genderRaw !== 'female') {
    return { ok: false, error: 'Gender must be male or female' };
  }
  const ageNum = Number(body?.age);
  if (!Number.isFinite(ageNum) || ageNum < 18 || ageNum > 80) {
    return { ok: false, error: 'Age must be between 18 and 80' };
  }
  return { ok: true, gender: genderRaw, age: Math.round(ageNum) };
};

router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body;
  console.log('➡️ /api/auth/signup called', { email: !!email, hasAuthorization: !!req.headers.authorization });
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });

  const ga = validateGenderAge(req.body);
  if (!ga.ok) return res.status(400).json({ message: ga.error });

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return res.status(400).json({ message: 'email and password required' });
  if (!emailRegex.test(normalizedEmail)) return res.status(400).json({ message: 'valid email required' });

  // If request contains an auth token, and it's a guest, convert that guest
  const auth = await extractAuthPayload(req);
  let convertingGuest = null;
  console.log('   signup auth result:', auth.error ? { error: auth.error.message } : { payload: auth.payload });
  if (!auth.error && auth.payload && auth.payload.userType === 'guest') {
    const lookupId = auth.payload.id || auth.payload.id;
    const candidate = findUserByIdentifier(lookupId) || users.get(lookupId);
    if (candidate && (candidate.userType === 'guest' || candidate.isAnonymous)) {
      convertingGuest = candidate;
    }
  }

  const hash = await bcrypt.hash(password, 10);

  // Block profane/explicit display names
  try {
    if (containsProfanity(displayName || '', { lenient: true })) {
      return res.status(400).json({ message: 'Display name contains disallowed content' });
    }
  } catch (e) {
    // fail-open on detection errors
  }

  if (convertingGuest) {
    // Convert existing guest to registered while preserving displayName
    const guestLookupId = String(convertingGuest.guestId || convertingGuest.id || '').trim();
    const existingByEmail = await User.findOne({ email: normalizedEmail }).select('_id guestId').lean().exec().catch(() => null);
    if (existingByEmail) {
      const existingGuestId = String(existingByEmail.guestId || '').trim();
      const sameGuest = guestLookupId && existingGuestId && guestLookupId === existingGuestId;
      if (!sameGuest) {
        return res.status(409).json({ message: 'email already in use' });
      }
    }

    convertingGuest.email = normalizedEmail;
    convertingGuest.password = hash;
    convertingGuest.userType = 'registered';
    // prefer provided displayName only if guest has none
    convertingGuest.displayName = convertingGuest.displayName || displayName || email;
    convertingGuest.name = convertingGuest.displayName;
    convertingGuest.gender = ga.gender;
    convertingGuest.age = ga.age;
    {
      const existingAv = String(convertingGuest.avatar || convertingGuest.photoURL || '').trim();
      const looksCustom = existingAv && !/\/avatars\/default-(male|female)\.svg(\?|$)/i.test(existingAv);
      if (!looksCustom) {
        const def = resolveDefaultAvatar(ga.gender);
        convertingGuest.avatar = def;
        convertingGuest.photoURL = def;
      }
    }

    try {
      convertingGuest.lastIp = getRequestIp(req);
      const { _id: ignoreId, id: ignoreMemoryId, ...persistableGuest } = convertingGuest;
      let saved = null;

      if (guestLookupId) {
        saved = await User.findOneAndUpdate(
          { guestId: guestLookupId },
          { $set: { ...persistableGuest, guestId: guestLookupId, userType: 'registered' } }, // explicitly ensure type
          { upsert: true, new: true }
        ).lean().exec();
      } else if (convertingGuest._id) {
        saved = await User.findByIdAndUpdate(
          convertingGuest._id,
          { $set: { ...persistableGuest, userType: 'registered' } },
          { new: true }
        ).lean().exec();
      } else {
        saved = await persistUserToDb(convertingGuest);
      }

      // Cleanup old guest entry from maps before re-inserting
      if (guestLookupId) users.delete(guestLookupId);

      const merged = saved ? upsertUserInMemory({ ...saved, id: String(saved.guestId || saved._id) }) : convertingGuest;
      
      // Strict cleanup of guest namespaces
      if (merged?.displayName) guestUsernames.delete(String(merged.displayName).toLowerCase());
      if (convertingGuest.displayName) guestUsernames.delete(String(convertingGuest.displayName).toLowerCase());

      if (merged?.email) users.set(merged.email, merged);
      if (merged?.id) users.set(String(merged.id), merged);
      if (merged?.guestId) users.set(String(merged.guestId), merged);
      
      const sessionId = await createSessionForUser((merged || convertingGuest).id, req);
      if (!sessionId) {
        return res.status(500).json({ message: 'Unable to create session' });
      }
      const token = signToken((merged || convertingGuest), sessionId);

      issueEmailVerification({ email: normalizedEmail, displayName: convertingGuest.displayName || convertingGuest.name || normalizedEmail }).catch(() => {});
      return res.json({ user: sanitizeUser(merged || convertingGuest), token, sessionId });
    } catch (e) {
      console.warn('⚠️ Failed to persist converted guest to registered user', e?.message || e);
      return res.status(500).json({ message: 'Could not complete guest-to-account conversion. Please retry.' });
    }
  }

  // Regular signup (no guest conversion)
  // Check both Email AND DisplayName collision before attempting creation
  const existingByEmail = await User.findOne({ email: normalizedEmail }).select('_id').lean().exec().catch(() => null);
  if (existingByEmail || users.has(normalizedEmail)) {
    return res.status(409).json({ message: 'email already in use' });
  }

  const profileName = displayName || normalizedEmail;
  const existingByName = await User.findOne({ displayName: { $regex: new RegExp(`^${profileName}$`, 'i') } }).select('_id').lean().exec().catch(() => null);
  if (existingByName || guestUsernames.has(profileName.toLowerCase())) {
     return res.status(409).json({ message: 'This display name is already taken. Please choose another one.' });
  }
  const defaultAvatar = resolveDefaultAvatar(ga.gender);
  const user = {
    id: String(users.size + 1),
    email: normalizedEmail,
    displayName: profileName,
    name: profileName,
    userType: 'registered',
    password: hash,
    emailVerified: false,
    gender: ga.gender,
    age: ga.age,
    avatar: defaultAvatar,
    photoURL: defaultAvatar
  };
  // persist to DB and in-memory
  try {
    user.lastIp = getRequestIp(req);
    await persistUserToDb(user);
  } catch (e) {
    // non-fatal: continue using in-memory copy
  }
  users.set(normalizedEmail, user);
  const sessionId = await createSessionForUser(user.id, req);
  if (!sessionId) {
    return res.status(500).json({ message: 'Unable to create session' });
  }
  const token = signToken(user, sessionId);

  // Fire-and-forget verification email
  issueEmailVerification({ email: normalizedEmail, displayName: user.displayName || user.name || normalizedEmail }).catch(() => {});
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

  const normalized = email.trim().toLowerCase();
  const user = Array.from(users.values()).find((u) => (u.email || '').toLowerCase() === normalized);

  const base = String(env.clientOrigin || '').replace(/\/$/, '');
  // In dev, always return a reset URL (even if user doesn't exist) to avoid account enumeration
  // while still letting developers test the reset flow without SMTP.
  const devToken = `reset-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const devResetUrl = `${base}/reset-password?token=${encodeURIComponent(user?.resetToken || devToken)}`;

  if (user) {
    user.resetToken = `reset-${Date.now()}`;
    user.resetTokenExpires = Date.now() + 20 * 60 * 1000; // 20 minutes
    try { await persistUserToDb(user); } catch (_) {}
    // send reset email (non-blocking)
    try {
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(user.resetToken)}`;
      const html = `<p>Hi ${user.displayName || ''},</p><p>We received a request to reset your password. Click the link below to reset it (valid for 20 minutes):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, ignore this message.</p>`;
      sendMail({ to: user.email, subject: 'Reset your Zoktu password', html }).catch((e) => console.warn('⚠️ reset-email send failed', e?.message || e));
    } catch (e) {
      console.warn('⚠️ Failed to queue reset email', e?.message || e);
    }
  }

  const response = { message: 'If an account exists with that email, a reset link has been sent.' };
  if (env.emailDevMode && env.nodeEnv !== 'production') {
    // Always include a URL in dev so frontend can test the flow without SMTP.
    response.devResetUrl = user ? `${base}/reset-password?token=${encodeURIComponent(user.resetToken)}` : devResetUrl;
  }
  res.json(response);
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};

  if (!token || !String(token).trim()) {
    return res.status(400).json({ message: 'Reset token is required' });
  }

  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }

  const cleanToken = String(token).trim();
  const userDoc = await User.findOne({ resetToken: cleanToken }).exec().catch(() => null);
  if (!userDoc) {
    return res.status(400).json({ message: 'Invalid or expired reset token' });
  }

  const expires = Number(userDoc.resetTokenExpires || 0);
  if (!expires || Date.now() > expires) {
    return res.status(400).json({ message: 'Reset token expired. Please request a new one.' });
  }

  const nextHash = await bcrypt.hash(String(newPassword), 10);
  userDoc.password = nextHash;
  userDoc.resetToken = undefined;
  userDoc.resetTokenExpires = undefined;
  await userDoc.save();

  // Keep in-memory cache in sync.
  try {
    const emailKey = userDoc.email ? String(userDoc.email) : null;
    if (emailKey && users.has(emailKey)) {
      const cached = users.get(emailKey);
      cached.password = nextHash;
      delete cached.resetToken;
      delete cached.resetTokenExpires;
      users.set(emailKey, cached);
    }
  } catch (_) {}

  res.json({ message: 'Password updated successfully' });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email: identifier, password } = req.body;

  if (!identifier || !password) return res.status(400).json({ message: 'email and password required' });

  // Primary fast lookup by the provided identifier (frontend still posts into `email` field)
  let lookup = users.get(identifier);

  // If not found, attempt case-insensitive search across common identifiers
  if (!lookup) {
    const normalized = String(identifier || '').trim().toLowerCase();
    lookup = Array.from(users.values()).find((u) => {
      return (u.email || '').toLowerCase() === normalized ||
             (u.displayName || '').toLowerCase() === normalized ||
             (u.username || '').toLowerCase() === normalized ||
             String(u.id) === normalized ||
             String(u.guestId || '').toLowerCase() === normalized;
    }) || null;
  }

  if (!lookup) return res.status(401).json({ message: 'invalid credentials' });

  const { user, expired } = enforceDeletionWindow(lookup);
  if (!user) {
    return res.status(expired ? 410 : 401).json({ message: expired ? 'Account already deleted' : 'invalid credentials' });
  }

  // Finalize deletion if grace period elapsed.
  if (user.deletePending && user.deleteScheduledFor && Date.now() >= Number(user.deleteScheduledFor)) {
    await finalizeDeletionIfDue(user);
    return res.status(410).json({ message: 'Account already deleted' });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: 'invalid credentials' });
  
  // Check for VIP expiration during login
  try {
    await checkPremiumExpiration(user);
  } catch (e) {
    // non-fatal
  }

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

  const sessionId = await createSessionForUser(user.id, req);
  if (!sessionId) {
    return res.status(500).json({ message: 'Unable to create session' });
  }
  const token = signToken(user, sessionId);
  res.json({ user: sanitizeUser(user), token, deletionRecovered: hadPendingDeletion, sessionId });
}));

router.post('/guest', asyncHandler(async (req, res) => {
  const { name } = req.body;
  const ga = validateGenderAge(req.body);
  if (!ga.ok) {
    return res.status(400).json({ message: ga.error });
  }
  const defaultAvatar = resolveDefaultAvatar(ga.gender);

  // Validate username
  const validation = validateGuestUsername(name);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.error });
  }

  const username = validation.username;

  // Block profane/explicit usernames
  try {
    if (containsProfanity(username, { lenient: true })) {
      return res.status(400).json({ message: 'Username contains disallowed content' });
    }
  } catch (e) {
    // fail-open
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

  // Use an atomic check then update to verify device/IP for existing guests
  try {
    const currentIp = getRequestIp(req);
    const deviceId = req.body.deviceId || req.headers['x-device-id'] || null;
    const now = new Date();

    // Check if a guest with this name already exists
    const existingGuest = await User.findOne({ displayName: username, userType: 'guest' }).lean().exec();

    let saved;
    if (existingGuest) {
      // Security check: Same device OR Same initial IP
      const ipMatch = existingGuest.guestInitialIp && existingGuest.guestInitialIp === currentIp;
      const deviceMatch = existingGuest.guestDeviceId && deviceId && existingGuest.guestDeviceId === deviceId;

      // Strict security: if a guestDeviceId is recorded, it MUST match for resumption.
      // Falling back to ipMatch ONLY if guestDeviceId was not recorded (legacy support).
      if (existingGuest.guestDeviceId) {
        if (!deviceMatch) {
          return res.status(403).json({ message: 'This guest name is reserved for another device.' });
        }
      } else {
        if (!ipMatch) {
          return res.status(403).json({ message: 'This guest name is reserved for another location.' });
        }
      }

      // Allow "login" to existing guest account
      saved = await User.findOneAndUpdate(
        { _id: existingGuest._id },
        { $set: { lastIp: currentIp, isOnline: true, lastSeen: null, gender: ga.gender, age: ga.age, avatar: existingGuest.avatar || defaultAvatar } },
        { new: true }
      ).lean().exec();
    } else {
      // Create new guest
      const guestId = `guest-${Date.now()}`;
      const newGuest = new User({
        guestId,
        displayName: username,
        userType: 'guest',
        gender: ga.gender,
        age: ga.age,
        avatar: defaultAvatar,
        photoURL: defaultAvatar,
        createdAt: now,
        guestInitialIp: currentIp, // Store the IP of the creator
        guestDeviceId: deviceId,    // Store the device ID of the creator
        lastIp: currentIp,
        isOnline: true,
        lastSeen: null
      });
      const doc = await newGuest.save();
      saved = doc.toObject();
    }

    // Build the in-memory user object
    const user = {
      id: saved.guestId || String(saved._id),
      guestId: saved.guestId || String(saved._id),
      email: '',
      username: saved.username || saved.displayName,
      displayName: saved.displayName,
      name: saved.displayName,
      userType: 'guest',
      gender: ga.gender || saved.gender,
      age: ga.age || saved.age,
      avatar: saved.avatar || defaultAvatar,
      photoURL: saved.photoURL || saved.avatar || defaultAvatar,
      isOnline: true,
      lastSeen: null,
      createdAt: saved.createdAt,
      guestInitialIp: saved.guestInitialIp,
      guestDeviceId: saved.guestDeviceId
    };

    // update in-memory maps
    try { 
      user.lastIp = currentIp; 
      // Ensure in-memory user has the new fields
      const cached = users.get(user.id) || {};
      users.set(user.id, { ...cached, ...user });
      guestUsernames.set(username.toLowerCase(), user.id);
    } catch (e) {}
    
    upsertUserInMemory(user);

    const sessionId = await createSessionForUser(user.id, req);
    if (!sessionId) {
      return res.status(500).json({ message: 'Unable to create session' });
    }
    const token = signToken(user, sessionId);
    return res.json({ user, token, sessionId });
  } catch (e) {
    // Duplicate key may happen if another request inserted the same name concurrently
    if (e && e.code === 11000) {
      return res.status(409).json({ message: 'Username already taken' });
    }
    console.warn('⚠️ Failed to persist guest user', e?.message || e);
    // Fall back to in-memory guest (non-persistent)
    const fallbackId = `guest-${Date.now()}`;
    const user = {
      id: fallbackId,
      guestId: fallbackId,
      email: '',
      username,
      displayName: username,
      name: username,
      userType: 'guest',
      gender: ga.gender,
      age: ga.age,
      avatar: defaultAvatar,
      photoURL: defaultAvatar,
      isOnline: true,
      lastSeen: null
    };
    guestUsernames.set(username.toLowerCase(), user.id);
    upsertUserInMemory(user);
    const sessionId = await createSessionForUser(user.id, req);
    if (!sessionId) {
      return res.status(500).json({ message: 'Unable to create session' });
    }
    const token = signToken(user, sessionId);
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

  // Block profane/explicit usernames from availability checks
  try {
    if (containsProfanity(username, { lenient: true })) {
      return res.status(400).json({ message: 'Username contains disallowed content', available: false });
    }
  } catch (e) {
    // fail-open
  }

  // Check if username exists (case-insensitive)
  const exists = guestUsernames.has(validation.username.toLowerCase());
  if (exists) {
    return res.status(409).json({ message: 'Username already taken', available: false });
  }

  return res.json({ message: 'Username is available', available: true });
});

router.get('/me', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const { payload } = auth;
  let { user, expired } = resolveUserFromPayload(payload);
  if (!user && expired) {
    return res.status(410).json({ message: 'Account already deleted' });
  }

  // Refresh from DB so profile fields persist across restarts / stale in-memory cache.
  try {
    let doc = null;
    if (payload?.email) {
      doc = await User.findOne({ email: String(payload.email) }).lean().exec().catch(() => null);
    }
    if (!doc && payload?.id) {
      const id = String(payload.id);
      doc = await User.findOne({ $or: [{ _id: id }, { guestId: id }] }).lean().exec().catch(() => null);
    }
    if (doc) {
      user = upsertUserInMemory({ ...doc, id: String(doc.guestId || doc._id) });
      // Check for VIP expiration during profile refresh (/me)
      try {
        await checkPremiumExpiration(user);
      } catch (e) {
        // non-fatal
      }
    }
  } catch (e) {
    // ignore
  }

  // Finalize deletion if grace period elapsed (DB-backed)
  try {
    if (user?.deletePending && user?.deleteScheduledFor && Date.now() >= Number(user.deleteScheduledFor)) {
      await finalizeDeletionIfDue(user);
      return res.status(410).json({ message: 'Account already deleted' });
    }
  } catch (_) {}

  const displayName = user?.displayName || user?.name || payload.email || (payload.id && String(payload.id).startsWith('guest-') ? `Guest-${String(payload.id).split('-').slice(-1)[0]}` : 'User');
  const createdAt = user?.createdAt || (payload?.iat ? new Date(Number(payload.iat) * 1000) : undefined);
  const avatarUrl = (user?.avatar || user?.photoURL || '').toString().trim();
  const resolvedAge = Number.isFinite(Number(user?.age)) ? Number(user.age) : null;

  return res.json({
    id: user?.id || payload.id,
    uid: user?.id || payload.id,
    email: user?.email || payload.email,
    userType: user?.userType || payload.userType,
    premiumStatus: user?.premiumStatus,
    isPremium: user?.isPremium ?? false,
    name: user?.name || displayName,
    displayName,
    username: user?.username,
    lastUsernameChange: user?.lastUsernameChange,
    emailVerified: user?.emailVerified ?? false,
    avatar: avatarUrl || null,
    photoURL: avatarUrl || null,
    avatarUrl: avatarUrl || null,
    bio: user?.bio || '',
    age: resolvedAge,
    gender: user?.gender || '',
    location: user?.location || '',
    dob: user?.dob || null,
    settings: user?.settings || {},
    isOnline: user?.isOnline ?? false,
    lastSeen: user?.lastSeen || null,
    createdAt
  });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (!auth.error && auth.payload?.sessionId) {
    const sessionId = String(auth.payload.sessionId);
    await Session.updateOne(
      { sessionId },
      { $set: { revoked: true, revokedAt: new Date() } }
    ).exec().catch(() => {});
  }
  res.json({ message: 'logged out' });
}));

router.post('/resend-verification', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const cleanEmail = (email || '').toString().trim();
  if (!cleanEmail) {
    return res.status(400).json({ message: 'Email is required' });
  }
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ message: 'Please provide a valid email address' });
  }

  const record = users.get(cleanEmail);
  const displayName = record?.displayName || record?.name || cleanEmail;

  // Fire-and-forget, but don't leak whether the email exists.
  issueEmailVerification({ email: cleanEmail, displayName }).catch(() => {});

  res.json({ message: 'If an account exists, a verification email has been sent.' });
}));

// Verify via email link (no auth required)
router.get('/verify-email', asyncHandler(async (req, res) => {
  const token = (req.query?.token || '').toString().trim();
  if (!token) {
    return res.status(400).send('Missing token');
  }

  const doc = await User.findOne({ emailVerificationToken: token }).exec().catch(() => null);
  if (!doc) {
    return res.status(400).send('Invalid or already used token');
  }

  const expires = Number(doc.emailVerificationTokenExpires || 0);
  if (expires && Date.now() > expires) {
    return res.status(400).send('Verification link expired. Please request a new one.');
  }

  doc.emailVerified = true;
  doc.emailVerificationToken = undefined;
  doc.emailVerificationTokenExpires = undefined;
  await doc.save();

  // Sync in-memory
  try {
    const emailKey = doc.email ? String(doc.email) : null;
    if (emailKey && users.has(emailKey)) {
      const u = users.get(emailKey);
      u.emailVerified = true;
      delete u.emailVerificationToken;
      delete u.emailVerificationTokenExpires;
      users.set(emailKey, u);
    }
  } catch (_) {}

  const redirectBase = String(env.clientOrigin || '').replace(/\/$/, '');
  const homeUrl = redirectBase || '/';
  res.status(200).send(`
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;padding:24px">
      <h2>Email verified ✅</h2>
      <p>Your email address is now verified.</p>
      <p><a href="${homeUrl}">Go back to Zoktu</a></p>
    </div>
  `);
}));

router.post('/verify-email', asyncHandler(async (req, res) => {
  const auth = await requireRegisteredUser(req);
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
  const auth = await requireRegisteredUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const { user } = auth;
  const email = user?.email ? String(user.email).trim() : null;
  if (!email) {
    return res.status(400).json({ message: 'Unable to change password for this account' });
  }

  // Authoritative source of truth is MongoDB.
  const userDoc = await User.findOne({ email }).exec().catch(() => null);
  if (!userDoc) {
    return res.status(404).json({ message: 'User not found' });
  }
  if (!userDoc.password) {
    return res.status(400).json({ message: 'Unable to change password for this account' });
  }

  const matches = await bcrypt.compare(currentPassword, String(userDoc.password));
  if (!matches) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }

  const nextHash = await bcrypt.hash(newPassword, 10);
  userDoc.password = nextHash;
  userDoc.resetToken = undefined;
  userDoc.resetTokenExpires = undefined;
  await userDoc.save();

  // Keep in-memory cache in sync for current session.
  try {
    user.password = nextHash;
    users.set(email, user);
    await persistUserToDb(user);
  } catch (e) {
    // best-effort
  }

  res.json({ message: 'Password updated successfully' });
}));

router.get('/deletion-status', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const email = auth.payload?.email ? String(auth.payload.email).trim() : null;
  if (!email) {
    return res.status(400).json({ message: 'Only registered accounts can schedule deletion' });
  }

  const doc = await User.findOne({ email }).select('deletePending deleteScheduledFor').lean().exec().catch(() => null);
  if (!doc) {
    return res.status(404).json({ message: 'User not found' });
  }

  const scheduledFor = Number(doc.deleteScheduledFor || 0);
  const pending = Boolean(doc.deletePending && scheduledFor && scheduledFor > Date.now());
  return res.json({
    pending,
    scheduledFor: pending ? scheduledFor : null,
    daysRemaining: pending ? Math.max(0, Math.ceil((scheduledFor - Date.now()) / (24 * 60 * 60 * 1000))) : 0
  });
}));

router.post('/delete-account', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const email = auth.payload?.email ? String(auth.payload.email).trim() : null;
  if (!email) {
    return res.status(400).json({ message: 'Only registered accounts can schedule deletion' });
  }

  const now = Date.now();
  const scheduledFor = now + DELETION_GRACE_PERIOD_MS;

  const doc = await User.findOne({ email }).exec().catch(() => null);
  if (!doc) {
    return res.status(404).json({ message: 'User not found' });
  }

  doc.deletePending = true;
  doc.deleteRequestedAt = now;
  doc.deleteScheduledFor = scheduledFor;
  await doc.save();

  // Sync in-memory best-effort
  try {
    const cached = users.get(email);
    if (cached) {
      cached.deletePending = true;
      cached.deleteRequestedAt = now;
      cached.deleteScheduledFor = scheduledFor;
      users.set(email, cached);
    }
  } catch (_) {}

  res.json({ message: 'Account scheduled for deletion in 10 days', scheduledFor });
}));

router.post('/cancel-deletion', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ message: auth.error.message });
  }

  const email = auth.payload?.email ? String(auth.payload.email).trim() : null;
  if (!email) {
    return res.status(400).json({ message: 'Only registered accounts can cancel deletion' });
  }

  const doc = await User.findOne({ email }).exec().catch(() => null);
  if (!doc) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (!doc.deletePending) {
    return res.status(400).json({ message: 'No deletion scheduled' });
  }

  doc.deletePending = false;
  doc.deleteRequestedAt = undefined;
  doc.deleteScheduledFor = undefined;
  await doc.save();

  // Sync in-memory best-effort
  try {
    const cached = users.get(email);
    if (cached) {
      delete cached.deletePending;
      delete cached.deleteRequestedAt;
      delete cached.deleteScheduledFor;
      users.set(email, cached);
    }
  } catch (_) {}

  res.json({ message: 'Deletion request canceled' });
}));

export default router;
