import crypto from 'crypto';
import { env } from '../config/env.js';

const PREFIX = 'enc:v1:';

const resolveKey = () => {
  const raw = String(env.messageEncryptionKey || '').trim() || String(env.jwtSecret || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
};

const KEY = resolveKey();

const toBase64Url = (buffer) => buffer.toString('base64url');
const fromBase64Url = (value) => Buffer.from(String(value || ''), 'base64url');

export const isEncryptedMessageContent = (value) => {
  const text = String(value || '');
  return text.startsWith(PREFIX);
};

export const encryptMessageContent = (plainText) => {
  const text = String(plainText ?? '');
  if (!KEY || !text) return text;
  if (isEncryptedMessageContent(text)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(encrypted)}`;
};

export const decryptMessageContent = (cipherText) => {
  const raw = String(cipherText ?? '');
  if (!KEY || !raw) return raw;
  if (!isEncryptedMessageContent(raw)) return raw;

  try {
    const payload = raw.slice(PREFIX.length);
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) return raw;

    const iv = fromBase64Url(ivPart);
    const tag = fromBase64Url(tagPart);
    const encrypted = fromBase64Url(dataPart);

    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return raw;
  }
};
