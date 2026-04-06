import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../config/env.js';

const router = Router();

const SERVICE_LABELS = {
  'love-chat-support': 'Love Chat Support',
  'account-settings': 'Account & Settings',
  'billing-payments': 'Billing & Payments',
  'technical-issues': 'Technical Issues',
  'safety-privacy': 'Safety & Privacy',
  'general-questions': 'General Questions'
};

const MAX_MESSAGE_LENGTH = 2000;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 120;

const clamp = (value, max) => String(value || '').trim().slice(0, max);

const isValidEmail = (value) => {
  const email = String(value || '').trim();
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

router.post('/messages', asyncHandler(async (req, res) => {
  const service = String(req.body?.service || '').trim();
  const rawMessage = String(req.body?.message || '').trim();
  const name = clamp(req.body?.name, MAX_NAME_LENGTH);
  const email = clamp(req.body?.email, MAX_EMAIL_LENGTH);
  const source = clamp(req.body?.source, 120) || 'support-page';
  const userAgent = clamp(req.body?.userAgent || req.headers['user-agent'], 300) || 'Unknown';
  const ip = clamp((req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || '').toString().split(',')[0], 80) || 'Unknown';

  if (!service || !SERVICE_LABELS[service]) {
    return res.status(400).json({ message: 'Please select a valid service type.' });
  }

  if (!rawMessage) {
    return res.status(400).json({ message: 'Please write your message.' });
  }

  if (rawMessage.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }

  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: 'Please enter a valid email address.' });
  }

  const serviceLabel = SERVICE_LABELS[service];
  const message = clamp(rawMessage, MAX_MESSAGE_LENGTH);
  const supportInbox = String(process.env.SUPPORT_EMAIL || process.env.SUPPORT_INBOX_EMAIL || 'support@zoktu.com').trim();
  const subject = `[Zoktu Support] ${serviceLabel}`;

  const text = [
    'New support request from Zoktu.',
    '',
    `Service: ${serviceLabel}`,
    `Name: ${name || 'Not provided'}`,
    `Email: ${email || 'Not provided'}`,
    `Source: ${source}`,
    `IP: ${ip}`,
    `User-Agent: ${userAgent}`,
    '',
    'Message:',
    message
  ].join('\n');

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; line-height: 1.5; color: #111827;">
      <h2 style="margin: 0 0 12px;">New support request from Zoktu</h2>
      <p style="margin: 0 0 8px;"><strong>Service:</strong> ${escapeHtml(serviceLabel)}</p>
      <p style="margin: 0 0 8px;"><strong>Name:</strong> ${escapeHtml(name || 'Not provided')}</p>
      <p style="margin: 0 0 8px;"><strong>Email:</strong> ${escapeHtml(email || 'Not provided')}</p>
      <p style="margin: 0 0 8px;"><strong>Source:</strong> ${escapeHtml(source)}</p>
      <p style="margin: 0 0 8px;"><strong>IP:</strong> ${escapeHtml(ip)}</p>
      <p style="margin: 0 0 16px;"><strong>User-Agent:</strong> ${escapeHtml(userAgent)}</p>
      <p style="margin: 0 0 6px;"><strong>Message:</strong></p>
      <pre style="white-space: pre-wrap; word-break: break-word; background: #f3f4f6; padding: 12px; border-radius: 8px; margin: 0;">${escapeHtml(message)}</pre>
    </div>
  `;

  try {
    await sendMail({
      to: supportInbox,
      subject,
      text,
      html,
      ...(email && isValidEmail(email) ? { replyTo: email } : {})
    });

    return res.json({ message: 'Support message sent successfully.' });
  } catch (err) {
    if (env.nodeEnv !== 'production') {
      console.warn('⚠️ support-mail send failed (non-production):', err?.message || err);
      console.info('ℹ️ support-mail payload fallback:', { service: serviceLabel, name: name || null, email: email || null, message });
      return res.status(202).json({ message: 'Support message received (email transport unavailable in this environment).' });
    }

    return res.status(500).json({ message: 'Could not send support message right now. Please try again shortly.' });
  }
}));

export default router;