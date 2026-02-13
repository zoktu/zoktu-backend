const buckets = new Map();

const getClientIp = (req) => {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.ip || req.connection?.remoteAddress || '').toString().trim();
};

const getBucket = (key, windowMs) => {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const next = { count: 0, resetAt: now + windowMs };
    buckets.set(key, next);
    return next;
  }
  return existing;
};

const createRateLimiter = ({ windowMs, max, message, keyPrefix }) => {
  const safeWindow = Number(windowMs) > 0 ? Number(windowMs) : 60_000;
  const safeMax = Number(max) > 0 ? Number(max) : 100;
  const prefix = keyPrefix ? String(keyPrefix) : 'rate';
  const errorMessage = message || 'Too many requests';

  return (req, res, next) => {
    const ip = getClientIp(req) || 'unknown';
    const key = `${prefix}:${ip}`;
    const bucket = getBucket(key, safeWindow);
    bucket.count += 1;

    const remaining = Math.max(safeMax - bucket.count, 0);
    res.setHeader('X-RateLimit-Limit', String(safeMax));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));

    if (bucket.count > safeMax) {
      const retryAfter = Math.max(Math.ceil((bucket.resetAt - Date.now()) / 1000), 1);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ message: errorMessage });
    }

    return next();
  };
};

export { createRateLimiter, getClientIp };
