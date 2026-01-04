import dotenv from 'dotenv';

dotenv.config();

const buildMongoUri = () => {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  const host = process.env.MONGO_HOST;
  const db = process.env.MONGO_DB || 'chitz';
  if (user && pass && host) {
    return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${db}?retryWrites=true&w=majority`;
  }
  return 'mongodb://localhost:27017/chitz';
};

export const env = {
  port: process.env.PORT || 4000,
  mongoUri: buildMongoUri(),
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173'
};

// Optional SMTP/email configuration (read from .env when provided)
env.smtpHost = process.env.SMTP_HOST || '';
env.smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
env.smtpUser = process.env.SMTP_USER || '';
env.smtpPass = process.env.SMTP_PASS || '';
env.smtpSecure = (process.env.SMTP_SECURE || 'false') === 'true';
env.emailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost';
