import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || env.smtpHost,
  port: Number(process.env.SMTP_PORT || env.smtpPort || 587),
  secure: (process.env.SMTP_SECURE || String(env.smtpSecure || false)) === 'true',
  auth: {
    user: process.env.SMTP_USER || env.smtpUser,
    pass: process.env.SMTP_PASS || env.smtpPass
  }
});

transporter.verify().then(() => {
  console.log('✅ SMTP transporter verified');
}).catch((err) => {
  console.warn('⚠️ SMTP transporter verify failed', err?.message || err);
});

export async function sendMail({ to, subject, text, html, from }) {
  const mailOptions = {
    from: from || process.env.EMAIL_FROM || env.emailFrom,
    to,
    subject,
    text,
    html
  };
  return transporter.sendMail(mailOptions);
}

export default transporter;
