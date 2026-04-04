import dotenv from 'dotenv';

dotenv.config();

const buildMongoUri = () => {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  const host = process.env.MONGO_HOST;
  const db = process.env.MONGO_DB || 'zoktu';
  if (user && pass && host) {
    return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${db}?retryWrites=true&w=majority`;
  }
  return 'mongodb://localhost:27017/zoktu';
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 4000,
  mongoUri: buildMongoUri(),
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  messageEncryptionKey: process.env.MESSAGE_ENCRYPTION_KEY || '',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  // Prefer explicit backend origin for building API links (e.g., email verification)
  apiOrigin: process.env.API_ORIGIN || process.env.BACKEND_ORIGIN || '',
  huggingFaceApiKey: process.env.HUGGINGFACE_API_KEY || '',
  huggingFaceModel: process.env.HUGGINGFACE_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
  botName: process.env.BOT_NAME || 'Baka',
  botId: process.env.BOT_ID || 'bot-baka',
  botAvatar: process.env.BOT_AVATAR || process.env.BOT_AVATAR_URL || '',
  botEnabled: process.env.BOT_ENABLED || '',
  botReplyCooldownMs: process.env.BOT_REPLY_COOLDOWN_MS || '',
  // IP risk detection provider settings
  ipIntelProvider: process.env.IPINTEL_PROVIDER || '',
  ipIntelKey: process.env.IPINTEL_KEY || '',
  maxmindDbPath: process.env.MAXMIND_DB_PATH || '',
  ipIntelStrictness: process.env.IPINTEL_STRICTNESS || '1',
  ipIntelAllowPublicAccessPoints: process.env.IPINTEL_ALLOW_PUBLIC_ACCESS_POINTS || 'true',
  ipIntelFraudBlockScore: process.env.IPINTEL_FRAUD_BLOCK_SCORE || '85',
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || 'rohitbansal23rk@gmail.com'
};

// Backward-compatible aliases used in existing code.
env.IPINTEL_PROVIDER = env.ipIntelProvider;
env.IPINTEL_KEY = env.ipIntelKey;
env.MAXMIND_DB_PATH = env.maxmindDbPath;
env.IPINTEL_STRICTNESS = env.ipIntelStrictness;
env.IPINTEL_ALLOW_PUBLIC_ACCESS_POINTS = env.ipIntelAllowPublicAccessPoints;
env.IPINTEL_FRAUD_BLOCK_SCORE = env.ipIntelFraudBlockScore;

// Redis URL for pub/sub and queues
env.redisUrl = process.env.REDIS_URL || process.env.REDIS_URI || '';

// Prerender service (optional) - e.g., https://service.prerender.io
env.prerenderServiceUrl = process.env.PRERENDER_SERVICE_URL || '';
env.prerenderToken = process.env.PRERENDER_TOKEN || '';

// Dev helpers (never enable in production)
env.emailDevMode = (process.env.EMAIL_DEV_MODE || '').toLowerCase() === 'true' || env.nodeEnv !== 'production';

// Optional SMTP/email configuration (read from .env when provided)
env.smtpEnabled = (process.env.SMTP_ENABLED || '').toLowerCase() === 'true';
env.smtpHost = process.env.SMTP_HOST || '';
env.smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
env.smtpUser = process.env.SMTP_USER || '';
env.smtpPass = process.env.SMTP_PASS || '';
env.smtpSecure = (process.env.SMTP_SECURE || 'false') === 'true';
env.emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost';

// Default behavior: enable SMTP only when credentials look present.
if (!process.env.SMTP_ENABLED) {
  env.smtpEnabled = Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
}

// Cloudflare Turnstile keys (set in your .env)
env.turnstileSecret = process.env.TURNSTILE_SECRET || '';
env.turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || '';

// Cashfree payment gateway configuration
env.cashfreeAppId = process.env.CASHFREE_APP_ID || '';
env.cashfreeSecret = process.env.CASHFREE_SECRET || '';
// 'PROD' or 'TEST' (sandbox)
env.cashfreeEnv = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
// URL where Cashfree will redirect after payment (set to your frontend callback)
env.cashfreeReturnUrl = process.env.CASHFREE_RETURN_URL || '';
// Optional admin secret for privileged payment actions (refunds)
env.adminSecret = process.env.ADMIN_SECRET || '';
