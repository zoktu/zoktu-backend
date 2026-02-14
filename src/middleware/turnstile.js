import { env } from '../config/env.js';

export const verifyTurnstile = async (req, res, next) => {
  // Accept common token locations from frontend
  const token = req.body?.['cf-turnstile-response'] || req.body?.turnstileToken || req.headers['cf-turnstile-response'] || req.query?.['cf-turnstile-response'];

  // If not configured, fail-open so dev environments keep working
  if (!env.turnstileSecret) return next();

  if (!token) return res.status(400).json({ message: 'Missing Turnstile token' });

  try {
    const params = new URLSearchParams();
    params.append('secret', env.turnstileSecret);
    params.append('response', token);
    const remoteip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || '';
    if (remoteip) params.append('remoteip', remoteip);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: params
    });
    const data = await resp.json().catch(() => ({}));
    if (data && data.success) return next();
    console.warn('⚠️ Turnstile verification failed', data);
    return res.status(403).json({ message: 'Turnstile verification failed' });
  } catch (e) {
    console.warn('⚠️ Turnstile verify error', e?.message || e);
    // Fail-open on unexpected errors
    return next();
  }
};
