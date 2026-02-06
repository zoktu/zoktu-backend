import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const smtpConfig = {
  enabled: Boolean(env.smtpEnabled),
  host: process.env.SMTP_HOST || env.smtpHost,
  port: Number(process.env.SMTP_PORT || env.smtpPort || 587),
  secure: (process.env.SMTP_SECURE || String(env.smtpSecure || false)) === 'true',
  user: process.env.SMTP_USER || env.smtpUser,
  pass: process.env.SMTP_PASS || env.smtpPass,
  from: process.env.EMAIL_FROM || env.emailFrom
};

let transporter = null;

if (smtpConfig.enabled) {
  transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass
    }
  });

  transporter.verify().then(() => {
    console.log('✅ SMTP transporter verified');
  }).catch((err) => {
    // Do not crash server startup if SMTP is misconfigured.
    // Common causes: wrong password, provider requires app-password, SMTP access disabled.
    const msg = err?.message || String(err);
    console.warn('⚠️ SMTP transporter verify failed:', msg);
    console.warn('ℹ️ Emails will fail until SMTP credentials are fixed (or set SMTP_ENABLED=false).');
  });
} else {
  console.log('ℹ️ SMTP disabled (set SMTP_ENABLED=true to enable outgoing emails).');
}

export async function sendMail({ to, subject, text, html, from }) {
  if (!transporter) {
    throw new Error('SMTP is disabled or not configured');
  }
  const mailOptions = {
    from: from || smtpConfig.from,
    to,
    subject,
    text,
    html
  };
  return transporter.sendMail(mailOptions);
}

export default transporter;
