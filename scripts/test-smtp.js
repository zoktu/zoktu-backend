// Simple SMTP test sender using existing mailer
// Usage:
//   node scripts/test-smtp.js you@example.com
// or set TEST_EMAIL_TO in .env and run without args

import { sendMail } from '../src/lib/mailer.js';
import { env } from '../src/config/env.js';

const to = (process.argv[2] || process.env.TEST_EMAIL_TO || env.smtpUser || '').trim();

if (!to) {
  console.error('Recipient email is required. Pass as an arg or set TEST_EMAIL_TO in .env');
  process.exit(1);
}

console.log('Preparing SMTP test…');
console.log(`- Host: ${process.env.SMTP_HOST || env.smtpHost || 'n/a'}`);
console.log(`- Port: ${process.env.SMTP_PORT || env.smtpPort || 'n/a'}`);
console.log(`- Secure: ${(process.env.SMTP_SECURE || env.smtpSecure) ? 'true' : 'false'}`);
console.log(`- From: ${process.env.EMAIL_FROM || env.emailFrom || 'n/a'}`);
console.log(`- To: ${to}`);

const now = new Date();
const subject = `SMTP Test • ${now.toISOString()}`;
const text = `This is a plaintext SMTP test sent at ${now.toISOString()}.`;
const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">\
  <h2>SMTP Test</h2>\
  <p>Sent at <code>${now.toISOString()}</code></p>\
  <p>If you received this, outbound SMTP is working ✅</p>\
</div>`;

try {
  const info = await sendMail({ to, subject, text, html });
  console.log('✅ Test email sent');
  if (info && (info.messageId || info.response)) {
    console.log(`- MessageId: ${info.messageId || 'n/a'}`);
    if (info.response) console.log(`- Response: ${info.response}`);
  }
  process.exit(0);
} catch (err) {
  const msg = err?.message || String(err);
  console.error('❌ Failed to send test email');
  console.error(`Reason: ${msg}`);
  process.exit(1);
}
