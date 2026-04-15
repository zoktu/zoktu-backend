import nodemailer from 'nodemailer';
import sgMail from '@sendgrid/mail';
import { env } from '../config/env.js';

const sendgridApiKey = String(process.env.SENDGRID_API_KEY || '').trim();
const sendgridEnabled = Boolean(sendgridApiKey);
const sendgridResidency = String(process.env.SENDGRID_DATA_RESIDENCY || '').trim().toLowerCase();

const smtpConfig = {
  enabled: Boolean(env.smtpEnabled),
  host: process.env.SMTP_HOST || env.smtpHost,
  port: Number(process.env.SMTP_PORT || env.smtpPort || 587),
  secure: (process.env.SMTP_SECURE || String(env.smtpSecure || false)) === 'true',
  user: process.env.SMTP_USER || env.smtpUser,
  pass: process.env.SMTP_PASS || env.smtpPass,
  from: process.env.EMAIL_FROM || env.emailFrom,
  timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 10000)
};

let transporter = null;

if (sendgridEnabled) {
  sgMail.setApiKey(sendgridApiKey);
  if (sendgridResidency === 'eu') {
    sgMail.setDataResidency('eu');
  }
  console.log('✅ SendGrid mailer enabled');
} else if (smtpConfig.enabled) {
  transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass
    },
    connectionTimeout: smtpConfig.timeoutMs,
    greetingTimeout: smtpConfig.timeoutMs,
    socketTimeout: smtpConfig.timeoutMs
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

export async function sendMail({ to, subject, text, html, from, replyTo }) {
  let resolvedFrom = from || smtpConfig.from;

  // Improve deliverability for Yahoo/Outlook by ensuring the from address is fully qualified
  // If the from address is just an email (e.g., "noreply@domain.com") without a Name, wrap it.
  if (resolvedFrom && !resolvedFrom.includes('<') && resolvedFrom.includes('@')) {
    resolvedFrom = `"Zoktu" <${resolvedFrom}>`;
  }

  if (sendgridEnabled) {
    console.log(`📧 Attempting to send email via SendGrid to: ${to} | Subject: ${subject}`);
    try {
      const response = await sgMail.send({
        to,
        from: resolvedFrom,
        subject,
        text,
        html,
        replyTo: replyTo || resolvedFrom
      });
      console.log(`✅ Email sent successfully via SendGrid to: ${to}`);
      return response;
    } catch (error) {
      console.error('❌ SendGrid Error:', error.response?.body || error.message || error);
      throw error;
    }
  }

  if (!transporter) {
    throw new Error('SMTP is disabled or not configured');
  }

  const mailOptions = {
    from: resolvedFrom,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || resolvedFrom
  };
  return transporter.sendMail(mailOptions);
}

export default transporter;
