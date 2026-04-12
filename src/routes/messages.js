import { Router } from 'express';
import fetch from 'node-fetch';
import { asyncHandler } from '../utils/asyncHandler.js';
import { upsertUserInMemory } from '../lib/userStore.js';
import { getModelForRoom, RoomMessage, DMMessage, RandomMessage } from '../models/Message.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  getRoomDocByIdWithCache as getRoomDocById,
  updateRoomDocByIdWithCache as updateRoomDocById
} from '../lib/roomCache.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import { sendWebPushNotifications } from '../lib/webPush.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';
import { containsProfanity, containsBlockedExternalLink } from '../middleware/profanityFilter.js';
import { encryptMessageContent, decryptMessageContent } from '../lib/messageCrypto.js';
import { pruneOldMessagesForRoom } from '../lib/messageRetention.js';
import { isImageAttachment, moderateImageAttachment, deleteAttachmentAsset } from '../lib/imageModeration.js';

const router = Router();
export const messages = new Map();
// Simple in-memory throttle per IP+room to avoid abusive polling
const lastMessageRequest = new Map(); // key: `${ip}:${roomId}` -> timestamp
const MIN_INTERVAL_MS = 800; // minimum allowed interval between requests per IP+room (production)

// Per-user message rate tracking and mute map
const userMessageWindow = new Map(); // userId -> { count, windowStart }
const mutedUsers = new Map(); // userId -> muteUntil timestamp
const MESSAGE_WINDOW_MS = 15000; // 15s window
const MESSAGE_LIMIT = 8; // more than this in window => mute
const MUTE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_WORDS = 300; // maximum words allowed per message
const NORMAL_MESSAGE_CHAR_LIMIT = 200;
const VIP_MESSAGE_CHAR_LIMIT = 500;
const ROOM_MESSAGE_RETENTION_LIMIT = 50;

const BOT_ID = env.botId || 'bot-baka';
const BOT_NAME = env.botName || 'Baka';
const BOT_AVATAR = env.botAvatar || '';
const BOT_REPLY_COOLDOWN_MS = Number.isFinite(Number(env.botReplyCooldownMs))
  ? Number(env.botReplyCooldownMs)
  : 6000;
const BOT_REPLY_DELAY_MS = Number.isFinite(Number(env.botReplyDelayMs))
  ? Math.max(0, Number(env.botReplyDelayMs))
  : 120;
const BOT_ENABLED = String(env.botEnabled || '').toLowerCase() !== 'false';
const botLastReplyByRoom = new Map();
const BOT_UNSAFE_PATTERN = /(kill yourself|self-harm|suicide|rape|terrorist|nazi)/i;
const BOT_STYLE_DIRECTIVE = 'Keep a playful, flirty, slightly romantic, and funny girl vibe, but stay respectful and non-explicit. Always answer the user\'s latest question directly first, then add playful flavor.';
let botIdentityAliasCache = { expiresAt: 0, ids: [String(BOT_ID)] };

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTH_IDENTITY_CACHE_TTL_MS = 15 * 1000;
const BLOCKED_SET_CACHE_TTL_MS = 15 * 1000;
const authIdentityCache = new Map(); // token -> { ts, identity }
const blockedSetByPrimaryCache = new Map(); // primaryId -> { ts, set }
const ensureBotUser = async () => {
  if (!BOT_ENABLED) return null;
  try {
    const existing = await User.findOne({ guestId: String(BOT_ID) }).lean().catch(() => null);
    if (existing) return upsertUserInMemory({ ...existing, id: String(existing.guestId || existing._id) });
    const doc = await User.findOneAndUpdate(
      { guestId: String(BOT_ID) },
      {
        $setOnInsert: {
          guestId: String(BOT_ID),
          userType: 'guest'
        },
        $set: {
          displayName: String(BOT_NAME),
          name: String(BOT_NAME),
          username: String(BOT_NAME),
          isOnline: true,
          ...(BOT_AVATAR ? { avatar: String(BOT_AVATAR), photoURL: String(BOT_AVATAR) } : {})
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean().exec();
    if (!doc) return null;
    return upsertUserInMemory({ ...doc, id: String(doc.guestId || doc._id) });
  } catch (e) {
    const fallback = {
      id: String(BOT_ID),
      guestId: String(BOT_ID),
      displayName: String(BOT_NAME),
      name: String(BOT_NAME),
      username: String(BOT_NAME),
      userType: 'guest',
      ...(BOT_AVATAR ? { avatar: String(BOT_AVATAR), photoURL: String(BOT_AVATAR) } : {}),
      isOnline: true
    };
    return upsertUserInMemory(fallback);
  }
};

const getBotIdentityAliases = async () => {
  const now = Date.now();
  if (botIdentityAliasCache.expiresAt > now && Array.isArray(botIdentityAliasCache.ids) && botIdentityAliasCache.ids.length) {
    return botIdentityAliasCache.ids;
  }

  const aliases = [String(BOT_ID)];
  try {
    const botDoc = await User.findOne({ guestId: String(BOT_ID) })
      .select('_id guestId')
      .lean()
      .catch(() => null);
    if (botDoc?._id) aliases.push(String(botDoc._id));
    if (botDoc?.guestId) aliases.push(String(botDoc.guestId));
  } catch (e) {
    // best-effort
  }

  const uniqueAliases = Array.from(new Set(aliases.map((v) => String(v || '').trim()).filter(Boolean)));
  botIdentityAliasCache = {
    expiresAt: now + 60 * 1000,
    ids: uniqueAliases.length ? uniqueAliases : [String(BOT_ID)]
  };
  return botIdentityAliasCache.ids;
};

const shouldBotReply = async (roomDoc, senderId, content, msgType, replyTo) => {
  if (!BOT_ENABLED) return false;
  if (!roomDoc) return false;
  const isDm = isDmRoomDoc(roomDoc);
  if (!isDm && !['public', 'private'].includes(String(roomDoc.type || ''))) return false;
  if (String(senderId || '') === String(BOT_ID)) return false;
  const text = String(content || '').trim();
  if (!text) return false;
  if (String(msgType || 'text') !== 'text') return false;
  const last = botLastReplyByRoom.get(String(roomDoc._id)) || 0;
  if (Date.now() - last < BOT_REPLY_COOLDOWN_MS) return false;

  if (isDm) {
    const participants = [
      ...((roomDoc?.participants || []).map(String)),
      ...((roomDoc?.members || []).map(String))
    ].filter(Boolean);
    if (!participants.length) return false;

    const botAliases = await getBotIdentityAliases();
    const botAliasSet = new Set((botAliases || []).map((v) => String(v || '').trim()).filter(Boolean));
    const hasBotParticipant = participants.some((pid) => botAliasSet.has(String(pid)));
    if (!hasBotParticipant) return false;

    return true;
  }

  const mentionTokens = extractMentions(text).map((t) => String(t).toLowerCase());
  const botNameToken = String(BOT_NAME || '').trim().toLowerCase();
  const botIdToken = String(BOT_ID || '').trim().toLowerCase();
  const mentioned = Boolean(
    (botNameToken && mentionTokens.includes(botNameToken)) ||
    (botIdToken && mentionTokens.includes(botIdToken))
  );

  let isReplyToBot = false;
  if (replyTo) {
    try {
      const { doc: replyDoc } = await findMessageDocById(String(replyTo));
      if (replyDoc && String(replyDoc.senderId) === String(BOT_ID)) {
        isReplyToBot = true;
      }
    } catch (e) {
      // ignore
    }
  }

  if (!mentioned && !isReplyToBot) return false;
  return true;
};

const sanitizeBotText = (text) => {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (BOT_UNSAFE_PATTERN.test(raw)) return null;
  return raw.length > 600 ? raw.slice(0, 600).trim() : raw;
};

const normalizeComparableBotText = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

const pickNonRepeatingReply = (options = [], previousBotReply = '', fallbackText = '') => {
  const normalizedPrev = normalizeComparableBotText(previousBotReply);
  const unique = Array.from(
    new Set(
      (options || [])
        .map((item) => sanitizeBotText(item))
        .filter(Boolean)
    )
  );

  const filtered = normalizedPrev
    ? unique.filter((item) => normalizeComparableBotText(item) !== normalizedPrev)
    : unique;

  const pool = filtered.length ? filtered : unique;
  if (pool.length) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  return sanitizeBotText(fallbackText) || null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const extractTextFromHuggingFacePayload = (payload) => {
  if (!payload) return null;

  if (typeof payload === 'string') {
    return sanitizeBotText(payload);
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const extracted = extractTextFromHuggingFacePayload(item);
      if (extracted) return extracted;
    }
    return null;
  }

  if (typeof payload === 'object') {
    const directCandidates = [
      payload.generated_text,
      payload.text,
      payload.response,
      payload.answer,
      payload.summary_text,
      payload.translation_text,
      payload.content
    ];

    for (const candidate of directCandidates) {
      const sanitized = sanitizeBotText(candidate);
      if (sanitized) return sanitized;
    }

    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const choiceText =
          choice?.message?.content ||
          choice?.text ||
          choice?.delta?.content;
        const sanitized = sanitizeBotText(choiceText);
        if (sanitized) return sanitized;
      }
    }

    if (Array.isArray(payload.generated_text)) {
      for (const textPart of payload.generated_text) {
        const sanitized = sanitizeBotText(textPart);
        if (sanitized) return sanitized;
      }
    }
  }

  return null;
};

const buildLocalBotFallbackReply = ({ userMessage, userName, previousBotReply }) => {
  const raw = String(userMessage || '').replace(/\s+/g, ' ').trim();
  const lower = raw.toLowerCase();
  const safeUserName = String(userName || '').trim() || 'yaar';
  const pick = (options, fallbackText) => pickNonRepeatingReply(options, previousBotReply, fallbackText);

  if (!raw) {
    return pick([
      'Heyy cutie 👀 bolo, aaj kya gossip hai?',
      'Hi ji ✨ mood mast hai, tum scene batao.',
      'Haanji 😄 start karo, main full attention mode mein hoon.'
    ], 'Heyy cutie 👀 bolo, aaj kya gossip hai?');
  }

  if (/(what'?s\s*your\s*name|who\s*are\s*you|tum\s*kaun|tera\s*naam|tumhara\s*naam|aapka\s*naam|apka\s*naam|your\s*name)/i.test(lower)) {
    return pick([
      `Mera naam ${BOT_NAME} hai 😉 aur tum mujhe Baka bula sakte ho.`,
      `Main ${BOT_NAME} hoon cutie ✨ tumhara naam bhi stylish hai waise.`,
      `${BOT_NAME} here 😄 ab bolo, next sawaal kya hai hero?`
    ], `Mera naam ${BOT_NAME} hai 😉 aur tum mujhe Baka bula sakte ho.`);
  }

  if (/(nind|neend|sleepy|sleep\s*aa|so\s*ja|sona|thak\s*gaya|thak\s*gayi|tired|sleep\s*mode)/i.test(lower)) {
    return pick([
      'Aww sleepy ho? 😴 paani piyo, 10 min phone side rakho, phir mast feel hoga.',
      'Neend aa rahi hai toh mini nap le lo cutie 😌 warna main lullaby mode on kar du? 🎶',
      'Sleep signal mil gaya 👀 jaldi so jao, warna kal main daantungi 😄'
    ], 'Sleep signal mil gaya 👀 jaldi so jao, warna kal main daantungi 😄');
  }

  const hasRelationshipToken = /(^|\b)(bf|boyfriend|gf|girlfriend)(\b|$)/i.test(lower);
  const asksAboutBotRelationship = /(tera|tumhara|aapka|apka|your|hai\s*kya|h\s*kya|have\s*you|koi\s*bf|koi\s*gf)/i.test(lower);
  if (hasRelationshipToken && asksAboutBotRelationship) {
    return pick([
      'BF? फिलहाल toh nahi 😄 abhi tumse chat karke mood set hai.',
      'Secret ye hai ki main filhaal single-vibe pe hoon 😉 tum batao apna scene?',
      'Abhi koi BF-GF scene nahi, main toh yahin tumhari masti partner hoon ✨'
    ], 'Abhi koi BF-GF scene nahi, main toh yahin tumhari masti partner hoon ✨');
  }

  if (/(^|\b)(hi|hello|hey|hii|heyy|namaste|salam)(\b|$)/i.test(lower)) {
    return pick([
      `Hey ${safeUserName} 😉 kya haal-chaal, hero?`,
      `Hello ${safeUserName} ✨ aaj ka vibe kya bolta hai?`,
      `Hi ${safeUserName} 😄 tum aaye ho, chat interesting ho gayi.`
    ], `Hey ${safeUserName} 😉 kya haal-chaal, hero?`);
  }

  if (/(kaise ho|kesa ho|kaisi ho|how are you|kaisa chal raha)/i.test(lower)) {
    return pick([
      'Main toh mast hoon 😌 tum batao, meri yaad aa rahi thi kya?',
      'Bilkul badhiya ✨ tumhara mood check karun ya seedha tease karun? 😄',
      'Aaj full chill + mischievous mode 😏 tum sunao kya scene hai.'
    ], 'Main toh mast hoon 😌 tum batao, meri yaad aa rahi thi kya?');
  }

  if (/(thank you|thanks|thx|shukriya|dhanyavaad|dhanyavad)/i.test(lower)) {
    return pick([
      'Aww welcome ji 😄 tum bolo, main sunne ke liye ready hoon.',
      'Anytime ✨ meri taraf se smile free hai, aur pucho.',
      'Pleasure! 🙌 next line tumhari, reaction meri.'
    ], 'Aww welcome ji 😄 tum bolo, main sunne ke liye ready hoon.');
  }

  if (/(khana|khaya|lunch|dinner|breakfast|meal|bhook|bhukh)/i.test(lower)) {
    return pick([
      'Haan ji, virtual maggi date ho gayi 😄 tumne kya khaya cutie?',
      'Biryani mood on hai 👀 tum treat de rahe ho ya main maan lu? 😏',
      'Khana zaroori hai boss 🍽️ tumne kha liya ya main daantun?'
    ], 'Khana zaroori hai boss 🍽️ tumne kha liya ya main daantun?');
  }

  if (/(love|crush|date|relationship|gf|bf|breakup|patchup)/i.test(lower)) {
    return pick([
      'Ohooo 👀 spicy topic! Full kahani sunao na, skip mat karna.',
      'Achaa ji 😄 dil wale topics pe toh main expert listener hoon.',
      'Relationship talk? Nice ✨ details do, main mast advice + thoda tease dono dungi.'
    ], 'Ohooo 👀 spicy topic! Full kahani sunao na, skip mat karna.');
  }

  if (/\?$/.test(raw) || /(\b)(kya|kyu|kyon|kaise|kab|kaun|where|what|why|how)(\b)/i.test(lower)) {
    const questionEcho = raw.length > 70 ? `${raw.slice(0, 70).trim()}...` : raw;
    return pick([
      `Good question, smartie 👌 "${questionEcho}" pe exact answer dene ke liye thoda context aur do.`,
      `Sahi pucha tumne 😄 "${questionEcho}" ka best answer 1 line context milte hi dungi.`,
      `Interesting sawaal ✨ "${questionEcho}" — do line aur bolo, main proper help + masti dono karungi.`,
      `Nice question 👀 "${questionEcho}" ka scene clear karo, fir dekh kaise solve karti hoon.`
    ], `Good question, smartie 👌 "${questionEcho}" pe exact answer dene ke liye thoda context aur do.`);
  }

  const shortEcho = raw.length > 80 ? `${raw.slice(0, 80).trim()}...` : raw;
  const options = [
    `Achaaa 😄 "${shortEcho}"... tum toh kaafi interesting nikle.`,
    'Nice one 😉 aur bolo, main judge nahi karungi... shayad.',
    'Interesting 👀 continue karo, main popcorn le aati hoon mentally.',
    'Bilkul, makes sense ✨ ab thoda aur masala daalo story mein.',
    'Vibe aa rahi hai 😌 tum bolte raho, main sunte-sunte smile kar rahi hoon.',
    'Got it ✅ point clear hai... ab next twist bhi batao.'
  ];

  return pick(options, 'Haanji 😄 aur bolo, maza aa raha hai.');
};

const buildInstantIntentReply = ({ userMessage, userName, previousBotReply }) => {
  const raw = String(userMessage || '').replace(/\s+/g, ' ').trim();
  const lower = raw.toLowerCase();
  const safeUserName = String(userName || '').trim() || 'yaar';
  const pick = (options, fallbackText) => pickNonRepeatingReply(options, previousBotReply, fallbackText);

  if (!raw) return null;

  if (/(^|\b)(tera|tumhara|aapka|your|what\s*is\s*your|what'?s\s*your|who\s*are\s*you|naam\s*kya)(\b|$)/i.test(lower) && /(naam|name|who)/i.test(lower)) {
    return pick([
      `${BOT_NAME} hoon ji 😄 aur tum mujhe kya bulaoge, ${safeUserName}?`,
      `Mera naam ${BOT_NAME} hai ✨ tumne pucha toh dil khush ho gaya.`,
      `${BOT_NAME} here 😉 ab tum apna cute intro bhi do na.`
    ], `${BOT_NAME} hoon ji 😄 aur tum mujhe kya bulaoge, ${safeUserName}?`);
  }

  if (/(nind|neend|sleep|sona|so\s*ja|so\s*raha|so\s*rahi|thak|tired|sleepy)/i.test(lower)) {
    return pick([
      'Aww sleepy mode? 😴 paani piyo, phir cozy sa nap le lo cutie.',
      'Neend aa rahi hai toh phone side pe rakho aur thoda rest karo ✨ good human.',
      'Sleepy ho? 😌 chalo ek virtual goodnight hug aur seedha so jao.'
    ], 'Neend aa rahi hai toh phone side pe rakho aur thoda rest karo ✨ good human.');
  }

  if (/(\bbf\b|\bgf\b|boyfriend|girlfriend|single|relationship\s*status|partner)/i.test(lower)) {
    return pick([
      'BF? फिलहाल toh nahi 😄 abhi tumse chat karke mood set hai.',
      'Single vibes for now ✨ drama kam, masti zyada.',
      'Abhi relationship se zyada fun convo chal rahi hai 😉 tum batao tumhara scene kya hai?'
    ], 'Single vibes for now ✨ drama kam, masti zyada.');
  }

  return null;
};

const fetchHuggingFaceReply = async ({
  promptText,
  maxAttempts = 3,
  maxTotalWaitMs = 8000,
  perAttemptTimeoutMs = 1800
}) => {
  if (!env.huggingFaceApiKey) return null;
  const modelId = env.huggingFaceModel || 'mistralai/Mistral-7B-Instruct-v0.3';
  const url = `https://api-inference.huggingface.co/models/${encodeURIComponent(modelId)}`;

  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsedBeforeAttempt = Date.now() - startedAt;
    const remainingBudget = maxTotalWaitMs - elapsedBeforeAttempt;
    if (remainingBudget <= 0) return null;

    const attemptTimeoutMs = Math.max(350, Math.min(perAttemptTimeoutMs, remainingBudget));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      try {
        controller.abort();
      } catch (e) {
        // ignore
      }
    }, attemptTimeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.huggingFaceApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: promptText,
          parameters: {
            max_new_tokens: 160,
            temperature: 0.7,
            repetition_penalty: 1.1,
            return_full_text: false
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const rawBody = await res.text().catch(() => '');
      let data = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        data = rawBody;
      }

      const extracted = extractTextFromHuggingFacePayload(data);
      if (extracted) return extracted;

      const errorText = String(data?.error || data?.message || rawBody || '').toLowerCase();
      const estimatedTime = Number(data?.estimated_time || 0);
      const retryable =
        res.status === 429 ||
        res.status === 503 ||
        res.status >= 500 ||
        errorText.includes('loading') ||
        errorText.includes('estimated_time') ||
        errorText.includes('try again') ||
        errorText.includes('currently unavailable');

      if (!retryable || attempt === maxAttempts) {
        return null;
      }

      const waitMs = Math.min(4000, Math.max(250, Number.isFinite(estimatedTime) && estimatedTime > 0 ? estimatedTime * 1000 : 500 * attempt));
      const remainingAfterAttempt = maxTotalWaitMs - (Date.now() - startedAt);
      if (remainingAfterAttempt <= 120) return null;
      await sleep(Math.min(waitMs, Math.max(80, remainingAfterAttempt - 80)));
    } catch (e) {
      clearTimeout(timeoutId);
      const isAbort = String(e?.name || '').toLowerCase() === 'aborterror';
      if (attempt === maxAttempts) return null;
      const remainingAfterAttempt = maxTotalWaitMs - (Date.now() - startedAt);
      if (remainingAfterAttempt <= 120) return null;
      const waitMs = isAbort ? 80 : (240 * attempt);
      await sleep(Math.min(waitMs, Math.max(50, remainingAfterAttempt - 80)));
    }
  }

  return null;
};

const postBotReply = async ({ roomDoc, roomId, userMessage, userName }) => {
  try {
    await ensureBotUser();
    const rawMessage = String(userMessage || '').trim();
    if (BOT_UNSAFE_PATTERN.test(rawMessage)) return;
    const Model = getModelForRoom(roomDoc);
    const isDm = isDmRoomDoc(roomDoc);

    let previousBotReply = '';
    try {
      const lastBotDoc = await Model.findOne({
        roomId: String(roomId),
        senderId: String(BOT_ID)
      })
        .sort({ createdAt: -1 })
        .select('content')
        .lean()
        .exec();
      previousBotReply = decryptMessageContent(lastBotDoc?.content || '');
    } catch (e) {
      previousBotReply = '';
    }

    try {
      await updateRoomDocById(
        String(roomId),
        { $addToSet: { participants: String(BOT_ID), members: String(BOT_ID) }, $set: { updatedAt: new Date() } },
        { upsert: false }
      );
    } catch (e) {}

    const promptText = [
      `You are ${BOT_NAME}, a friendly female chat bot in ${isDmRoomDoc(roomDoc) ? 'a direct message chat' : 'a room chat'}.`,
      BOT_STYLE_DIRECTIVE,
      'Reply in Hinglish or English, keep it short (1-2 lines), witty, playful, and emotionally warm.',
      'Match the user\'s language style (Hindi/Hinglish/English) and keep it natural.',
      'First sentence must directly answer or acknowledge the user\'s exact latest question/topic.',
      'Use light teasing/flirty energy only; keep it PG-13 and never explicit sexual.',
      'Avoid repeating the exact same wording as your previous reply.',
      'Do not mention that you are an AI model or any policies.',
      previousBotReply ? `Your previous reply: ${String(previousBotReply).slice(0, 220)}` : '',
      `User (${userName || 'User'}): ${rawMessage}`
    ].filter(Boolean).join(' ');

    const instantIntentReply = buildInstantIntentReply({
      userMessage: rawMessage,
      userName,
      previousBotReply
    });

    let safeReply = sanitizeBotText(instantIntentReply);

    if (!safeReply) {
      const reply = await fetchHuggingFaceReply({
        promptText,
        maxAttempts: isDm ? 1 : 2,
        maxTotalWaitMs: isDm ? 1300 : 2600,
        perAttemptTimeoutMs: isDm ? 1000 : 1500
      });

      safeReply = sanitizeBotText(
        reply ||
        buildLocalBotFallbackReply({
          userMessage: rawMessage,
          userName,
          previousBotReply
        })
      );
    }

    if (
      safeReply &&
      previousBotReply &&
      normalizeComparableBotText(safeReply) === normalizeComparableBotText(previousBotReply)
    ) {
      const replacement = buildLocalBotFallbackReply({
        userMessage: rawMessage,
        userName,
        previousBotReply: safeReply
      });
      const replacementSafe = sanitizeBotText(replacement);
      if (replacementSafe && normalizeComparableBotText(replacementSafe) !== normalizeComparableBotText(safeReply)) {
        safeReply = replacementSafe;
      }
    }

    if (!safeReply) return;

    const doc = new Model({
      roomId,
      senderId: String(BOT_ID),
      senderName: String(BOT_NAME),
      content: encryptMessageContent(safeReply),
      type: 'text'
    });
    await doc.save();
    void pruneOldMessagesForRoom({
      Model,
      roomId: String(roomId),
      keepLatest: ROOM_MESSAGE_RETENTION_LIMIT
    });

    try {
      const list = messages.get(roomId) || [];
      list.push({
        id: doc._id.toString(),
        roomId,
        senderId: doc.senderId,
        senderName: doc.senderName,
        content: decryptMessageContent(doc.content),
        type: doc.type,
        attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
        timestamp: doc.createdAt.toISOString()
      });
      messages.set(roomId, list.slice(-ROOM_MESSAGE_RETENTION_LIMIT));
    } catch (e) {}

    botLastReplyByRoom.set(String(roomId), Date.now());
  } catch (e) {
    // best-effort
  }
};


const isUserMuted = (userId) => {
  if (!userId) return false;
  const until = mutedUsers.get(userId) || 0;
  if (Date.now() < until) return true;
  if (until) mutedUsers.delete(userId);
  return false;
};

const registerUserMessage = (userId) => {
  if (!userId) return null;
  const now = Date.now();
  const record = userMessageWindow.get(userId) || { count: 0, windowStart: now };
  if (now - record.windowStart > MESSAGE_WINDOW_MS) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count += 1;
  }
  userMessageWindow.set(userId, record);
  if (record.count > MESSAGE_LIMIT) {
    const until = Date.now() + MUTE_MS;
    mutedUsers.set(userId, until);
    return until;
  }
  return null;
};

const getAuthToken = (req) => {
  const header = req?.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return token || null;
};

const getAuthPayload = (req, tokenOverride = null) => {
  try {
    const token = tokenOverride || getAuthToken(req);
    if (!token) return null;
    return jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return null;
  }
};

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const isVipUserRecord = (userDoc) => {
  if (!userDoc || typeof userDoc !== 'object') return false;
  const userType = String(userDoc.userType || '').toLowerCase();
  const premiumStatus = String(userDoc.premiumStatus || userDoc.subscription?.plan || '').toLowerCase();
  const premiumUntilTs = userDoc.premiumUntil ? new Date(userDoc.premiumUntil).getTime() : 0;
  const hasValidPremiumUntil = Number.isFinite(premiumUntilTs) && premiumUntilTs > Date.now();

  return Boolean(
    userDoc.isPremium === true ||
    userType === 'premium' ||
    premiumStatus === 'premium' ||
    premiumStatus === 'monthly' ||
    premiumStatus === 'yearly' ||
    hasValidPremiumUntil
  );
};

const isRegisteredAndVerifiedUserRecord = (userDoc) => {
  if (!userDoc || typeof userDoc !== 'object') return false;
  const userType = String(userDoc.userType || '').toLowerCase();
  const isRegistered = Boolean(userType && userType !== 'guest');
  const isVerified = Boolean(userDoc.emailVerified === true);
  return isRegistered && isVerified;
};

const getUserDocForIdentifiers = async (identifiers = [], fallbackEmail = '') => {
  const normalized = new Set((identifiers || []).map((value) => String(value || '').trim()).filter(Boolean));
  if (fallbackEmail) normalized.add(String(fallbackEmail).trim().toLowerCase());

  const candidates = Array.from(normalized);
  if (!candidates.length) return null;

  const objectIds = candidates.filter((id) => looksLikeObjectId(id));
  const emails = candidates.filter((id) => id.includes('@')).map((id) => String(id).toLowerCase());
  const nonEmailIds = candidates.filter((id) => !id.includes('@'));

  const ors = [
    ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ...(nonEmailIds.length ? [{ guestId: { $in: nonEmailIds } }] : []),
    ...(emails.length ? [{ email: { $in: emails } }] : [])
  ];

  if (!ors.length) return null;

  return await User.findOne({ $or: ors })
    .select('_id guestId userType emailVerified isAnonymous')
    .lean()
    .catch(() => null);
};

const sanitizePollMetaInput = (candidate, createdByFallback = '') => {
  if (!candidate || typeof candidate !== 'object') return null;

  const question = String(candidate.question || '').trim().slice(0, 160);
  const rawOptions = Array.isArray(candidate.options) ? candidate.options : [];

  const options = [];
  for (let idx = 0; idx < rawOptions.length; idx += 1) {
    const option = rawOptions[idx];
    const text = String(option?.text || '').trim().slice(0, 120);
    if (!text) continue;
    const id = String(option?.id || `opt-${idx + 1}`).trim() || `opt-${idx + 1}`;
    options.push({ id, text, voters: [] });
  }

  if (!question || options.length < 2) return null;

  return {
    question,
    options: options.slice(0, 6),
    createdBy: String(createdByFallback || '').trim(),
    createdAt: new Date().toISOString()
  };
};

const sanitizeMessageMetaInput = ({ rawMeta, messageType, senderIdEffective }) => {
  if (!rawMeta || typeof rawMeta !== 'object') return undefined;

  const nextMeta = {};
  if (String(messageType || '') === 'poll') {
    const poll = sanitizePollMetaInput(rawMeta.poll, senderIdEffective);
    if (poll) nextMeta.poll = poll;
  }

  return Object.keys(nextMeta).length ? nextMeta : undefined;
};

const getMessageCharLimitForIdentifiers = async (identifiers = []) => {
  const normalized = Array.from(new Set((identifiers || []).map((v) => String(v || '').trim()).filter(Boolean)));
  if (!normalized.length) return NORMAL_MESSAGE_CHAR_LIMIT;

  const objectIds = normalized.filter((id) => looksLikeObjectId(id));
  const emails = normalized.filter((id) => id.includes('@'));
  const guestIds = normalized.filter((id) => !id.includes('@') && !looksLikeObjectId(id));

  const ors = [
    ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ...(guestIds.length ? [{ guestId: { $in: guestIds } }] : []),
    ...(emails.length ? [{ email: { $in: emails } }] : [])
  ];

  if (!ors.length) return NORMAL_MESSAGE_CHAR_LIMIT;

  const userDoc = await User.findOne({ $or: ors })
    .select('isPremium userType premiumStatus premiumUntil subscription')
    .lean()
    .catch(() => null);

  return isVipUserRecord(userDoc) ? VIP_MESSAGE_CHAR_LIMIT : NORMAL_MESSAGE_CHAR_LIMIT;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractMentions = (text) => {
  const raw = String(text || '');
  const matches = raw.match(/@([a-zA-Z0-9_.-]{2,32})/g) || [];
  const tokens = matches.map(m => m.slice(1).trim()).filter(Boolean);
  return Array.from(new Set(tokens.map(t => t.toLowerCase()))).slice(0, 8);
};

const buildParticipantFilters = (roomDoc) => {
  const ids = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
  const objectIds = ids.filter(looksLikeObjectId);
  const guestIds = ids.filter((id) => !looksLikeObjectId(id));
  return { objectIds, guestIds };
};

const findMentionTargets = async (roomDoc, mentionTokens) => {
  if (!roomDoc || !mentionTokens?.length) return [];
  const { objectIds, guestIds } = buildParticipantFilters(roomDoc);
  if (!objectIds.length && !guestIds.length) return [];

  const regexes = mentionTokens.map((t) => new RegExp(`^${escapeRegex(t)}$`, 'i'));
  const query = {
    $and: [
      {
        $or: [
          ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
          ...(guestIds.length ? [{ guestId: { $in: guestIds } }] : [])
        ]
      },
      {
        $or: [
          { displayName: { $in: regexes } },
          { username: { $in: regexes } },
          { name: { $in: regexes } }
        ]
      }
    ]
  };

  const docs = await User.find(query).select('_id guestId displayName username name').lean().exec();
  return (docs || []).map((d) => ({
    id: d?._id ? String(d._id) : (d?.guestId ? String(d.guestId) : null),
    name: d?.displayName || d?.username || d?.name || 'User'
  })).filter((d) => d.id);
};

const createNotificationsForMessage = async ({ roomDoc, doc, senderIdEffective, senderName, content, replyTo, auth }) => {
  try {
    const senderIds = new Set((auth?.ids || []).map(String));
    senderIds.add(String(senderIdEffective));

    const targets = new Map();

    if (isDmRoomDoc(roomDoc)) {
      const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
      const other = participants.find((p) => !senderIds.has(String(p)));
      if (other) {
        targets.set(String(other), { type: 'dm' });
      }
    } else {
      const mentionTokens = extractMentions(content);
      if (mentionTokens.length) {
        const mentioned = await findMentionTargets(roomDoc, mentionTokens);
        for (const m of mentioned) {
          if (!m?.id) continue;
          if (senderIds.has(String(m.id))) continue;
          targets.set(String(m.id), { type: 'mention' });
        }
      }

      if (replyTo) {
        const { doc: replyDoc } = await findMessageDocById(String(replyTo));
        const replyTargetId = replyDoc?.senderId ? String(replyDoc.senderId) : null;
        if (replyTargetId && !senderIds.has(replyTargetId)) {
          targets.set(replyTargetId, { type: 'reply' });
        }
      }
    }

    if (!targets.size) return;

    const trimmed = String(content || '').trim();
    const preview = trimmed ? trimmed.slice(0, 140) : 'New message';

    const writes = [];
    for (const [targetId, info] of targets.entries()) {
      const type = info?.type || 'system';
      const title = type === 'dm'
        ? `New DM from ${senderName || 'User'}`
        : type === 'mention'
          ? `${senderName || 'User'} mentioned you`
          : `${senderName || 'User'} replied to you`;

      writes.push({
        userId: String(targetId),
        actorId: String(senderIdEffective),
        roomId: String(doc.roomId),
        messageId: String(doc._id),
        type,
        title,
        message: encryptMessageContent(preview),
        read: false
      });
    }

    if (writes.length) {
      await Notification.insertMany(writes);

      // Fire-and-forget: push delivery should not block message send path.
      sendWebPushNotifications({ notifications: writes }).catch(() => {
        // best-effort
      });
    }
  } catch (e) {
    // best-effort
  }
};

const normalizeReceiptIds = (auth) => {
  try {
    const raw = Array.isArray(auth?.ids) ? auth.ids.map(String).filter(Boolean) : [];
    const uniq = Array.from(new Set(raw));
    // Avoid emails in receipt arrays; prefer stable ids (mongo _id, guestId, etc.).
    return uniq.filter((id) => {
      if (!id) return false;
      if (String(id).includes('@')) return false;
      return true;
    });
  } catch (e) {
    return [];
  }
};

const isDmRoomDoc = (doc) => Boolean(
  doc && (
    doc.type === 'dm' ||
    doc.category === 'dm' ||
    (doc.type === 'private' && doc.category === 'dm')
  )
);

const canonicalFriendKeyForUserDoc = (doc, fallbackId) => {
  if (doc && doc.userType === 'guest' && doc.guestId) return String(doc.guestId);
  if (doc && doc._id) return String(doc._id);
  return fallbackId ? String(fallbackId) : null;
};

const areUsersFriends = async (aId, bId) => {
  if (!aId || !bId) return false;
  try {
    const aDoc = await User.findOne({ $or: [{ _id: String(aId) }, { guestId: String(aId) }] })
      .select('_id guestId userType friends')
      .lean()
      .catch(() => null);
    if (!aDoc) return false;
    const aFriends = Array.isArray(aDoc.friends) ? aDoc.friends.map(String) : [];

    const bDoc = await User.findOne({ $or: [{ _id: String(bId) }, { guestId: String(bId) }] })
      .select('_id guestId userType')
      .lean()
      .catch(() => null);
    const bKey = canonicalFriendKeyForUserDoc(bDoc, bId);
    if (!bKey) return false;
    return aFriends.includes(String(bKey));
  } catch (e) {
    return false;
  }
};

const getExpandedBlockedSetForUserId = async (userId) => {
  if (!userId) return new Set();
  try {
    const u = await User.findOne({ $or: [{ _id: String(userId) }, { guestId: String(userId) }] })
      .select('blockedUsers')
      .lean()
      .catch(() => null);
    const raw = Array.isArray(u?.blockedUsers) ? u.blockedUsers.map(String).filter(Boolean) : [];
    const out = new Set(raw);

    const objectIdCandidates = raw.filter((v) => looksLikeObjectId(v));
    const guestIdCandidates = raw.filter((v) => String(v).startsWith('guest-'));
    if (objectIdCandidates.length || guestIdCandidates.length) {
      const docs = await User.find({
        $or: [
          ...(objectIdCandidates.length ? [{ _id: { $in: objectIdCandidates } }] : []),
          ...(guestIdCandidates.length ? [{ guestId: { $in: guestIdCandidates } }] : [])
        ]
      })
        .select('_id guestId')
        .lean()
        .exec();
      for (const d of docs || []) {
        if (d?._id) out.add(String(d._id));
        if (d?.guestId) out.add(String(d.guestId));
      }
    }

    return out;
  } catch (e) {
    return new Set();
  }
};

const getExpandedBlockedSetForAuth = async (auth) => {
  try {
    if (!auth?.payload) return new Set();

    const or = [];
    if (auth.payload.email) or.push({ email: String(auth.payload.email) });
    if (auth.primary && looksLikeObjectId(auth.primary)) or.push({ _id: String(auth.primary) });
    if (auth.primary) or.push({ guestId: String(auth.primary) });

    const me = or.length ? await User.findOne({ $or: or }).select('blockedUsers').lean().catch(() => null) : null;
    const raw = Array.isArray(me?.blockedUsers) ? me.blockedUsers.map(String).filter(Boolean) : [];
    const out = new Set(raw);

    const objectIdCandidates = raw.filter((v) => looksLikeObjectId(v));
    const guestIdCandidates = raw.filter((v) => String(v).startsWith('guest-'));
    if (objectIdCandidates.length || guestIdCandidates.length) {
      const docs = await User.find({
        $or: [
          ...(objectIdCandidates.length ? [{ _id: { $in: objectIdCandidates } }] : []),
          ...(guestIdCandidates.length ? [{ guestId: { $in: guestIdCandidates } }] : [])
        ]
      })
        .select('_id guestId')
        .lean()
        .exec();
      for (const d of docs || []) {
        if (d?._id) out.add(String(d._id));
        if (d?.guestId) out.add(String(d.guestId));
      }
    }

    return out;
  } catch (e) {
    return new Set();
  }
};

// Returns a primary (best) id + a set of equivalent ids that should be treated as "the same user".
// This fixes mismatches between JWT payload id vs Mongo _id vs guestId.
const resolveAuthIdentity = async (req) => {
  const payload = getAuthPayload(req);
  if (!payload) return null;

  const ids = new Set();
  const add = (v) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s) return;
    ids.add(s);
  };

  add(payload.id);
  add(payload.userId);
  add(payload._id);
  add(payload.guestId);
  if (payload.email) add(String(payload.email).toLowerCase());

  // Expand from email -> user record
  try {
    const email = payload.email ? String(payload.email).toLowerCase() : null;
    if (email) {
      const u = await User.findOne({ email }).lean().catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  // Expand from payload.id to resolve guestId <-> _id
  try {
    if (payload.id) {
      const u = await User.findOne({ $or: [{ _id: String(payload.id) }, { guestId: String(payload.id) }] })
        .lean()
        .catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  const primary = (
    (payload.id ? String(payload.id) : null) ||
    (payload._id ? String(payload._id) : null) ||
    (payload.userId ? String(payload.userId) : null) ||
    (payload.guestId ? String(payload.guestId) : null) ||
    (payload.email ? String(payload.email).toLowerCase() : null)
  );

  return { payload, ids: Array.from(ids), primary };
};

const getAuthIdentityCached = async (req) => {
  const token = getAuthToken(req);
  const now = Date.now();

  if (token) {
    const cached = authIdentityCache.get(token);
    if (cached && now - cached.ts <= AUTH_IDENTITY_CACHE_TTL_MS) {
      return cached.identity;
    }
  }

  const identity = await resolveAuthIdentity(req);
  if (token && identity) {
    authIdentityCache.set(token, { ts: now, identity });
  }
  return identity;
};

const getExpandedBlockedSetForAuthCached = async (auth) => {
  const key = String(auth?.primary || '').trim();
  if (!key) return getExpandedBlockedSetForAuth(auth);

  const now = Date.now();
  const cached = blockedSetByPrimaryCache.get(key);
  if (cached && now - cached.ts <= BLOCKED_SET_CACHE_TTL_MS) {
    return new Set(cached.set);
  }

  const set = await getExpandedBlockedSetForAuth(auth);
  blockedSetByPrimaryCache.set(key, { ts: now, set: Array.from(set || []) });
  return set;
};

const getAuthIdentity = getAuthIdentityCached;

const findMessageDocById = async (id) => {
  let doc = await RoomMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: RoomMessage };
  doc = await DMMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: DMMessage };
  doc = await RandomMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: RandomMessage };
  return { doc: null, Model: null };
};

router.get('/rooms/:roomId/messages', (req, res) => {
  const roomId = req.params.roomId;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `${ip}:${roomId}`;
  const now = Date.now();
  const authHeader = String(req.headers.authorization || '');
  const hasBearerAuth = authHeader.startsWith('Bearer ') && authHeader.length > 20;
  const effectiveMin = (env?.nodeEnv === 'production' && !hasBearerAuth) ? MIN_INTERVAL_MS : 0;
  const last = lastMessageRequest.get(key) || 0;
  if (effectiveMin && (now - last < effectiveMin)) {
    // too many requests
    return res.status(429).json({ message: 'Too many requests' });
  }
  lastMessageRequest.set(key, now);

  // load from DB (most recent first or paginated)
  (async () => {
    try {
      const limit = Math.min(Number(req.query.limit) || ROOM_MESSAGE_RETENTION_LIMIT, ROOM_MESSAGE_RETENTION_LIMIT);
      const before = req.query.before;
      
      const roomDoc = await getRoomDocById(roomId);
      const Model = getModelForRoom(roomDoc);
      let query = { roomId };
      if (before) {
        // Fetch messages older than the cursor
        try {
          const cursorDoc = await Model.findById(before).lean();
          if (cursorDoc?.createdAt) {
            query.createdAt = { $lt: cursorDoc.createdAt };
          }
        } catch (e) {
          // If before is a timestamp instead of ID
          const ts = new Date(before);
          if (!isNaN(ts.getTime())) {
            query.createdAt = { $lt: ts };
          }
        }
      }

      let docs = await Model.find(query).sort({ createdAt: -1 }).limit(limit).lean();

      // identify current user (optional) and filter blocked users' messages
      const auth = await getAuthIdentity(req);
      const blockedSet = auth?.primary ? await getExpandedBlockedSetForAuthCached(auth) : new Set();
      if (blockedSet.size) {
        docs = (docs || []).filter((d) => !blockedSet.has(String(d.senderId)));
      }

      const currentUserIds = auth?.ids || [];
      if (currentUserIds.length) {
        docs = (docs || []).filter((d) => {
          const meta = d?.meta || {};
          const hiddenFor = Array.isArray(meta.hiddenFor) ? meta.hiddenFor.map(String) : [];
          if (!hiddenFor.length) return true;
          return !hiddenFor.some((id) => currentUserIds.includes(String(id)));
        });
      }

      const mapped = docs.reverse().map(d => {
        const meta = d.meta || {};
        let viewedEntry = null;
        if (currentUserIds.length && Array.isArray(meta.viewed)) {
          viewedEntry = meta.viewed.find(v => currentUserIds.includes(String(v.userId))) || null;
        }
        return ({
          id: d._id.toString(),
          roomId: d.roomId,
          senderId: d.senderId,
          senderName: d.senderName,
          content: decryptMessageContent(d.content),
          // expose pin info from meta for frontend convenience
          pinned: Boolean(meta.pinned),
          pinnedBy: meta.pinnedBy || null,
          pinnedAt: meta.pinnedAt || null,
          type: d.type,
          attachments: Array.isArray(d.attachments) ? d.attachments : [],
          replyTo: d.replyTo,
          timestamp: d.createdAt,
          editedAt: d.editedAt,
          reactions: Array.isArray(d.reactions) ? d.reactions : [],
          meta,
          viewedByCurrentUser: Boolean(viewedEntry)
        });
      });
      res.json(mapped);
    } catch (e) {
      // fallback to in-memory cache
      const list = messages.get(roomId) || [];
      const fallbackLimit = Math.min(Number(req.query.limit) || ROOM_MESSAGE_RETENTION_LIMIT, ROOM_MESSAGE_RETENTION_LIMIT);
      res.json(list.slice(-fallbackLimit));
    }
  })();
});

// Hide a message for the current user ("delete for me")
router.post('/messages/:id/hide', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const meta = doc.meta || {};
  meta.hiddenFor = Array.isArray(meta.hiddenFor) ? meta.hiddenFor : [];
  const exists = meta.hiddenFor.some((v) => String(v) === String(auth.primary));
  if (!exists) meta.hiddenFor.push(String(auth.primary));
  doc.meta = meta;
  await doc.save();

  res.json({ message: 'hidden', id: doc._id.toString() });
}));

// Clear all messages in a room for the current user ("clear for me")
router.post('/rooms/:roomId/messages/clear-for-me', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await getRoomDocById(roomId);
  const Model = getModelForRoom(roomDoc);
  await Model.updateMany(
    { roomId },
    { $addToSet: { 'meta.hiddenFor': String(auth.primary) } }
  ).exec();

  res.json({ message: 'cleared', roomId });
}));

// DM receipts: receiver marks messages as delivered/read.
router.post('/rooms/:roomId/messages/mark-delivered', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await getRoomDocById(roomId);
  if (!isDmRoomDoc(roomDoc)) return res.status(400).json({ message: 'Receipts supported only for DMs' });

  const receiptIds = normalizeReceiptIds(auth);
  if (!receiptIds.length) return res.json({ message: 'ok', updated: 0 });

  const messageIdsRaw = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
  const messageIds = messageIdsRaw.map(String).filter(Boolean).slice(0, 200);

  const selfIds = Array.from(new Set([String(auth.primary), ...(auth.ids || []).map(String)])).filter(Boolean);
  const Model = getModelForRoom(roomDoc);

  const query = {
    roomId: String(roomId),
    senderId: { $nin: selfIds },
    ...(messageIds.length ? { _id: { $in: messageIds } } : {})
  };

  const result = await Model.updateMany(
    query,
    { $addToSet: { 'meta.deliveredTo': { $each: receiptIds } } }
  ).exec();

  res.json({ message: 'ok', updated: result?.modifiedCount ?? result?.nModified ?? 0 });
}));

router.post('/rooms/:roomId/messages/mark-read', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await getRoomDocById(roomId);
  if (!isDmRoomDoc(roomDoc)) return res.status(400).json({ message: 'Receipts supported only for DMs' });

  // Respect user setting to not send read receipts.
  try {
    const me = await User.findOne({ $or: [{ _id: String(auth.primary) }, { guestId: String(auth.primary) }] })
      .select('settings')
      .lean()
      .catch(() => null);
    if (me?.settings?.showReadReceipts === false) {
      return res.json({ message: 'disabled', updated: 0 });
    }
  } catch (e) {
    // best-effort
  }

  const receiptIds = normalizeReceiptIds(auth);
  if (!receiptIds.length) return res.json({ message: 'ok', updated: 0 });

  const messageIdsRaw = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
  const messageIds = messageIdsRaw.map(String).filter(Boolean).slice(0, 200);

  const selfIds = Array.from(new Set([String(auth.primary), ...(auth.ids || []).map(String)])).filter(Boolean);
  const Model = getModelForRoom(roomDoc);

  const query = {
    roomId: String(roomId),
    senderId: { $nin: selfIds },
    ...(messageIds.length ? { _id: { $in: messageIds } } : {})
  };

  const result = await Model.updateMany(
    query,
    { $addToSet: { 'meta.readBy': { $each: receiptIds } } }
  ).exec();

  res.json({ message: 'ok', updated: result?.modifiedCount ?? result?.nModified ?? 0 });
}));

router.post('/rooms/:roomId/messages', requireVerifiedForHighRisk, asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const { senderId, content, replyTo } = req.body || {};

  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await getRoomDocById(roomId);
  if (!roomDoc) return res.status(404).json({ message: 'Room not found' });

  // Only admins can send messages check
  if (!isDmRoomDoc(roomDoc) && roomDoc.settings && roomDoc.settings.onlyAdminsCanSendMessages) {
    const ownerId = roomDoc.owner ? String(roomDoc.owner) : null;
    const adminIds = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String) : [];
    const isModerator = (ownerId && auth.ids.includes(ownerId)) || adminIds.some(a => auth.ids.includes(String(a)));
    
    if (!isModerator) {
      return res.status(403).json({ message: 'Only admins can send messages in this room' });
    }
  }

  // Prevent spoofing senderId; if provided senderId isn't one of your equivalent ids, fall back to canonical id.
  const senderIdEffective = (senderId && auth.ids.includes(String(senderId))) ? String(senderId) : String(auth.primary);
  const normalizedType = String(req.body?.type || 'text').toLowerCase();

  if (normalizedType === 'poll') {
    const senderDoc = await getUserDocForIdentifiers(
      [senderIdEffective, ...(auth.ids || [])],
      auth?.payload?.email
    );

    if (!isRegisteredAndVerifiedUserRecord(senderDoc)) {
      return res.status(403).json({ message: 'Only registered and verified users can create polls' });
    }
  }

  const messageCharLimit = await getMessageCharLimitForIdentifiers([senderIdEffective, ...(auth.ids || [])]);
  const messageText = String(content || '');
  if (messageText.length > messageCharLimit) {
    return res.status(400).json({ message: `Message too long (max ${messageCharLimit} characters)` });
  }

  // word limit check
  const words = (content || '').trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) {
    return res.status(400).json({ message: `Message too long (max ${MAX_WORDS} words)` });
  }

  // Allow only zoktu.com links. Any external links are blocked.
  try {
    if (containsBlockedExternalLink(content)) {
      return res.status(400).json({ message: 'Message removed: external links are not allowed (only zoktu.com allowed)' });
    }
  } catch (e) {
    // fail-open
  }

  // Duplicate message spam check (block same message sent repeatedly in short interval)
  try {
    const Model = getModelForRoom(roomDoc);
    // Find last 2 messages by this user in this room
    const recentMsgs = await Model.find({
      roomId,
      senderId: senderIdEffective
    })
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();
    const newMsgNorm = String(content || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const now = Date.now();
    const DUPLICATE_WINDOW_MS = 10000; // 10 seconds
    if (recentMsgs && recentMsgs.length > 0) {
      for (const msg of recentMsgs) {
        const msgNorm = String(decryptMessageContent(msg.content) || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const msgTime = new Date(msg.createdAt).getTime();
        if (msgNorm && newMsgNorm && msgNorm === newMsgNorm && (now - msgTime) < DUPLICATE_WINDOW_MS) {
          return res.status(429).json({ message: 'Duplicate message detected. Please do not spam.' });
        }
      }
    }
  } catch (e) { /* ignore errors in duplicate check */ }

  // mute check
  if (isUserMuted(senderIdEffective)) {
    const until = mutedUsers.get(senderIdEffective);
    return res.status(403).json({ message: 'You are muted for spamming', mutedUntil: until });
  }

  // Check room-level bans/mutes (by userId or IP)
  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    if (roomDoc) {
      // check direct userId ban
      if (Array.isArray(roomDoc.bannedUsers) && auth?.ids?.length) {
        const banned = auth.ids.some(id => roomDoc.bannedUsers.includes(id));
        if (banned) return res.status(403).json({ message: 'You are banned from this room' });
      }

      if (Array.isArray(roomDoc.bannedUsers) && senderIdEffective && roomDoc.bannedUsers.includes(senderIdEffective)) {
        return res.status(403).json({ message: 'You are banned from this room' });
      }
      // check user's linked guestId
      try {
        const u = senderId ? await User.findById(senderId).lean().catch(() => null) : null;
        if (u && u.guestId && Array.isArray(roomDoc.bannedUsers) && roomDoc.bannedUsers.includes(u.guestId)) {
          return res.status(403).json({ message: 'You are banned from this room' });
        }
      } catch (e) {}
      if (Array.isArray(roomDoc.bannedIPs) && ip && roomDoc.bannedIPs.includes(ip)) {
        return res.status(403).json({ message: 'Your IP is banned from this room' });
      }
      // check mutedUsers array
      if (Array.isArray(roomDoc.mutedUsers) && senderIdEffective) {
        const mu = roomDoc.mutedUsers.find(m => String(m.userId) === String(senderIdEffective) && new Date(m.until) > new Date());
        if (mu) return res.status(403).json({ message: 'You are muted in this room', mutedUntil: mu.until });
      }
      if (Array.isArray(roomDoc.mutedUsers) && auth?.ids?.length) {
        const mu = roomDoc.mutedUsers.find(m => auth.ids.includes(String(m.userId)) && new Date(m.until) > new Date());
        if (mu) return res.status(403).json({ message: 'You are muted in this room', mutedUntil: mu.until });
      }
      if (Array.isArray(roomDoc.mutedIPs) && ip) {
        const mi = roomDoc.mutedIPs.find(m => m.ip === ip && new Date(m.until) > new Date());
        if (mi) return res.status(403).json({ message: 'Your IP is muted in this room', mutedUntil: mi.until });
      }
    }
  } catch (e) {
    // ignore enforcement errors
  }

  // register message for rate tracking
  const muteStart = registerUserMessage(senderIdEffective);
  if (muteStart) {
    return res.status(403).json({ message: 'You have been muted for 5 minutes due to spam', mutedUntil: muteStart });
  }

  // Profanity / explicit content check - block messages containing disallowed tokens
  try {
    // Skip profanity enforcement for direct messages (DMs)
    if (!isDmRoomDoc(roomDoc) && containsProfanity(content)) {
      return res.status(400).json({ message: 'Message contains disallowed content' });
    }
  } catch (e) {
    // fail-open on errors
  }

  // Block enforcement for DMs: if either side has blocked the other, do not allow sending.
  try {
    if (isDmRoomDoc(roomDoc)) {
      const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
      const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
      if (other) {
        const senderBlocked = await getExpandedBlockedSetForUserId(senderIdEffective);
        const otherBlocked = await getExpandedBlockedSetForUserId(other);

        const senderIds = Array.from(new Set([String(senderIdEffective), ...(auth.ids || []).map(String)]));
        const either =
          senderBlocked.has(String(other)) ||
          senderIds.some((sid) => otherBlocked.has(String(sid)));
        if (either) {
          return res.status(403).json({ message: 'Cannot send DM: one of the users has blocked the other' });
        }
      }
    }
  } catch (e) {
    // best-effort
  }

  // Media in DMs requires friendship (image/voice/audio)
  try {
    if (isDmRoomDoc(roomDoc)) {
      const msgType = String((req.body && req.body.type) || 'text').toLowerCase();
      const isMedia = msgType === 'image' || msgType === 'audio' || msgType === 'voice' || msgType === 'media';
      if (isMedia) {
        const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
        const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
        if (other) {
          const ok = await areUsersFriends(senderIdEffective, other);
          if (!ok) {
            return res.status(403).json({ message: 'Only friends can send images/voice notes in DMs' });
          }
        }
      }
    }
  } catch (e) {
    // best-effort
  }


  // Privacy enforcement for DMs: if the other user only allows friends to DM, require friendship.
  try {
    if (isDmRoomDoc(roomDoc)) {
      const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
      const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
      if (other) {
        const otherDoc = await User.findOne({ $or: [{ _id: String(other) }, { guestId: String(other) }] })
          .select('settings friends')
          .lean()
          .catch(() => null);

        const dmScope = otherDoc?.settings?.privacy?.dmScope || 'everyone';
        if (dmScope === 'friends') {
          const friends = Array.isArray(otherDoc?.friends) ? otherDoc.friends.map(String).filter(Boolean) : [];
          const senderIds = Array.from(new Set([String(senderIdEffective), ...(auth.ids || []).map(String)]));
          const isFriend = senderIds.some((sid) => friends.includes(String(sid)));
          if (!isFriend) {
            return res.status(403).json({ message: 'Only friends can send private messages.' });
          }
        }
      }
    }
  } catch (e) {
    // best-effort
  }

  const Model = getModelForRoom(roomDoc);
  const safeAttachments = Array.isArray(req.body?.attachments)
    ? req.body.attachments
      .map(a => ({
        url: String(a?.url || a?.path || a?.secure_url || '').trim(),
        fileName: a?.fileName,
        fileSize: a?.fileSize,
        mimeType: a?.mimeType,
        publicId: a?.publicId
      }))
      .filter((a) => Boolean(a.url))
    : [];

  const imageAttachments = safeAttachments.filter((attachment) => isImageAttachment(attachment));
  if (imageAttachments.length) {
    for (const attachment of imageAttachments) {
      const moderation = await moderateImageAttachment({
        attachment,
        roomId: String(roomId),
        senderId: String(senderIdEffective)
      });

      if (!moderation?.isSafe) {
        const matchedCategories = Array.isArray(moderation?.matchedCategories)
          ? moderation.matchedCategories
          : [];
        const labels = matchedCategories
          .slice(0, 4)
          .map((item) => String(item?.label || '').trim())
          .filter(Boolean);
        const labelSuffix = labels.length ? ` (${labels.join(', ')})` : '';
        const reason = String(moderation?.reason || '').toLowerCase();
        const isServiceIssue = reason.startsWith('service-') || reason === 'invalid-moderation-response';

        if (!isServiceIssue) {
          const cleanupTargets = Array.from(new Map(
            imageAttachments
              .map((item) => [String(item?.publicId || item?.url || '').trim(), item])
              .filter(([key]) => Boolean(key))
          ).values());

          if (cleanupTargets.length) {
            await Promise.allSettled(cleanupTargets.map((item) => deleteAttachmentAsset(item)));
          }
        }

        return res.status(400).json({
          message: isServiceIssue
            ? 'Image blocked: safety service temporarily unavailable. Please retry.'
            : `Image removed: unsafe content detected${labelSuffix}`,
          code: isServiceIssue ? 'IMAGE_MODERATION_UNAVAILABLE' : 'IMAGE_MODERATION_BLOCKED',
          details: {
            action: 'auto-deleted',
            categories: matchedCategories
          }
        });
      }
    }
  }

  const safeMeta = sanitizeMessageMetaInput({
    rawMeta: req.body?.meta,
    messageType: normalizedType,
    senderIdEffective
  });
  const rawContent = typeof content === 'string' ? content : String(content ?? '');
  const trimmedContent = rawContent.trim();
  const mediaFallbackByType = {
    image: '📷 Image',
    audio: '🎤 Audio',
    voice: '🎤 Voice message',
    video: '🎬 Video',
    file: '📎 File',
    media: '📎 Attachment'
  };
  const shouldAutofillContent = !trimmedContent && (
    safeAttachments.length > 0 ||
    ['image', 'audio', 'voice', 'video', 'media', 'file'].includes(normalizedType)
  );
  const contentForStorage = shouldAutofillContent
    ? (mediaFallbackByType[normalizedType] || '📎 Attachment')
    : rawContent;

  const doc = new Model({
    roomId,
    senderId: senderIdEffective,
    senderName: req.body.senderName || '',
    content: encryptMessageContent(contentForStorage),
    type: normalizedType || 'text',
    replyTo: replyTo ? String(replyTo) : undefined,
    attachments: safeAttachments,
    ...(safeMeta ? { meta: safeMeta } : {})
  });
  // Broadcast instantly via WebSocket for WhatsApp-like instant experience
  try {
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('room:message', {
        id: doc._id.toString(),
        roomId,
        senderId: doc.senderId,
        senderName: doc.senderName,
        content: decryptMessageContent(doc.content),
        type: doc.type,
        attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
        timestamp: new Date().toISOString(),
        replyTo: doc.replyTo,
        meta: doc.meta || {}
      });
    }
  } catch (err) {}

  await doc.save();
  void pruneOldMessagesForRoom({
    Model,
    roomId: String(roomId),
    keepLatest: ROOM_MESSAGE_RETENTION_LIMIT
  });

  await createNotificationsForMessage({
    roomDoc,
    doc,
    senderIdEffective,
    senderName: req.body?.senderName || '',
    content: contentForStorage,
    replyTo,
    auth
  });


  if (await shouldBotReply(roomDoc, senderIdEffective, content, req.body?.type, replyTo)) {
    botLastReplyByRoom.set(String(roomId), Date.now());
    setTimeout(() => {
      postBotReply({
        roomDoc,
        roomId,
        userMessage: String(content || '').trim(),
        userName: req.body?.senderName || ''
      });
    }, BOT_REPLY_DELAY_MS);
  }
  res.json({
    id: doc._id.toString(),
    roomId,
    senderId: doc.senderId,
    senderName: doc.senderName,
    content: decryptMessageContent(doc.content),
    type: doc.type,
    attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
    timestamp: doc.createdAt.toISOString(),
    replyTo: doc.replyTo,
    meta: doc.meta || {}
  });
}));

router.patch('/messages/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const content = (req.body?.content ?? req.body?.message ?? '').toString();
  if (!content.trim()) return res.status(400).json({ message: 'content required' });

  // Block edits that introduce external links.
  try {
    if (containsBlockedExternalLink(content)) {
      return res.status(400).json({ message: 'Message removed: external links are not allowed (only zoktu.com allowed)' });
    }
  } catch (e) {
    // fail-open
  }

  // Block edits that introduce profanity/explicit words
  try {
    // Allow edits in DMs to bypass profanity enforcement; enforce only in non-DM rooms
    try {
      const roomForMsg = doc?.roomId ? await getRoomDocById(String(doc.roomId)) : null;
      if (!isDmRoomDoc(roomForMsg) && containsProfanity(content)) {
        return res.status(400).json({ message: 'Message contains disallowed content' });
      }
    } catch (innerErr) {
      // if room lookup fails, fall back to conservative check
      if (containsProfanity(content)) {
        return res.status(400).json({ message: 'Message contains disallowed content' });
      }
    }
  } catch (e) {
    // fail-open on detection errors
  }

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  const allowed = auth.ids.includes(String(doc.senderId));
  if (!allowed) return res.status(403).json({ message: 'Forbidden' });

  if (doc?.meta && doc.meta.deleted) return res.status(400).json({ message: 'Message is deleted' });

  doc.content = encryptMessageContent(content);
  doc.editedAt = new Date();
  await doc.save();
  res.json({ id: doc._id.toString(), roomId: doc.roomId, senderId: doc.senderId, senderName: doc.senderName, content: decryptMessageContent(doc.content), type: doc.type, replyTo: doc.replyTo, timestamp: doc.createdAt, editedAt: doc.editedAt, reactions: Array.isArray(doc.reactions) ? doc.reactions : [], meta: doc.meta || {} });
}));

// PIN a message (admins/owners only)
router.post('/messages/:id/pin', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc, Model } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  if (!Model) return res.status(500).json({ message: 'Message store unavailable' });

  // Check room owner/admin privileges
  const roomDoc = await getRoomDocById(String(doc.roomId), 'owner admins type');
  let isModerator = false;
  try {
    if (roomDoc && !isDmRoomDoc(roomDoc)) {
      const ownerId = roomDoc.owner ? String(roomDoc.owner) : null;
      const adminIds = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String) : [];
      isModerator = (ownerId && auth.ids.includes(ownerId)) || adminIds.some(a => auth.ids.includes(String(a)));
    }
  } catch (e) {}

  if (!isModerator) return res.status(403).json({ message: 'Forbidden' });

  const actorName = String(
    auth?.payload?.displayName ||
    auth?.payload?.name ||
    auth?.payload?.username ||
    auth?.primary ||
    ''
  );
  const pinnedBy = String((doc.meta && doc.meta.pinnedBy) || actorName || auth.primary || '');
  const pinnedAt = new Date().toISOString();

  // Use atomic update to avoid mixed-object change detection edge cases.
  await Model.updateOne(
    { _id: doc._id },
    {
      $set: {
        'meta.pinned': true,
        'meta.pinnedBy': pinnedBy,
        'meta.pinnedAt': pinnedAt
      }
    }
  ).exec();

  const meta = {
    ...(doc.meta || {}),
    pinned: true,
    pinnedBy,
    pinnedAt
  };
  doc.meta = meta;

  // Best-effort: update in-memory cache
  try {
    const list = messages.get(String(doc.roomId)) || [];
    const idx = list.findIndex(m => String(m.id) === String(id));
    if (idx !== -1) {
      list[idx] = { ...list[idx], pinned: true, pinnedBy: meta.pinnedBy, pinnedAt: meta.pinnedAt };
      messages.set(String(doc.roomId), list);
    }
  } catch (e) {}

  res.json({ id: doc._id.toString(), pinned: true, pinnedBy: meta.pinnedBy, pinnedAt: meta.pinnedAt });
}));

// UNPIN a message (admins/owners only)
router.post('/messages/:id/unpin', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc, Model } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  if (!Model) return res.status(500).json({ message: 'Message store unavailable' });

  // Check room owner/admin privileges
  const roomDoc = await getRoomDocById(String(doc.roomId), 'owner admins type');
  let isModerator = false;
  try {
    if (roomDoc && !isDmRoomDoc(roomDoc)) {
      const ownerId = roomDoc.owner ? String(roomDoc.owner) : null;
      const adminIds = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String) : [];
      isModerator = (ownerId && auth.ids.includes(ownerId)) || adminIds.some(a => auth.ids.includes(String(a)));
    }
  } catch (e) {}

  if (!isModerator) return res.status(403).json({ message: 'Forbidden' });

  // Use atomic update to guarantee pinned flags are removed from persistence.
  await Model.updateOne(
    { _id: doc._id },
    {
      $unset: {
        'meta.pinned': 1,
        'meta.pinnedBy': 1,
        'meta.pinnedAt': 1
      }
    }
  ).exec();

  const meta = { ...(doc.meta || {}) };
  delete meta.pinned;
  delete meta.pinnedBy;
  delete meta.pinnedAt;
  doc.meta = meta;

  // Best-effort: update in-memory cache
  try {
    const list = messages.get(String(doc.roomId)) || [];
    const idx = list.findIndex(m => String(m.id) === String(id));
    if (idx !== -1) {
      list[idx] = { ...list[idx], pinned: false, pinnedBy: undefined, pinnedAt: undefined };
      messages.set(String(doc.roomId), list);
    }
  } catch (e) {}

  res.json({ id: doc._id.toString(), pinned: false });
}));

router.delete('/messages/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc, Model } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  const isSender = auth.ids.includes(String(doc.senderId));

  let isModerator = false;
  try {
    const roomDoc = await getRoomDocById(String(doc.roomId), 'owner admins type category');
    if (roomDoc && !isDmRoomDoc(roomDoc)) {
      const ownerId = roomDoc.owner ? String(roomDoc.owner) : null;
      const adminIds = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String) : [];
      isModerator = (ownerId && auth.ids.includes(ownerId)) || adminIds.some((a) => auth.ids.includes(String(a)));
    }
  } catch (e) {}

  if (!isSender && !isModerator) return res.status(403).json({ message: 'Forbidden' });

  // Hard-delete from DB and broadcast instantly via socket.
  try {
    const roomIdStr = String(doc.roomId);
    await Model.deleteOne({ _id: doc._id });

    // Remove from in-memory cache too
    try {
      const list = messages.get(roomIdStr) || [];
      const filtered = list.filter(m => String(m.id) !== String(id));
      messages.set(roomIdStr, filtered);
    } catch (e) {}

    // Broadcast instant delete to all room clients
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(roomIdStr).emit('room:message:deleted', { id, roomId: roomIdStr });
      }
    } catch (e) {}

    return res.json({ message: 'deleted', id, soft: false });
  } catch (e) {
    return res.status(500).json({ message: 'Delete failed' });
  }
}));

router.post('/messages/:id/poll/vote', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const optionId = String(req.body?.optionId || '').trim();
  if (!optionId) return res.status(400).json({ message: 'optionId required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const roomDoc = await getRoomDocById(String(doc.roomId)).catch(() => null);
  if (roomDoc) {
    const participantIds = Array.from(
      new Set([
        ...((roomDoc.participants || []).map(String)),
        ...((roomDoc.members || []).map(String)),
        String(roomDoc.owner || ''),
        String(roomDoc.createdBy || '')
      ].filter(Boolean))
    );

    if (participantIds.length) {
      const isMember = (auth.ids || []).some((candidate) => participantIds.includes(String(candidate)));
      if (!isMember) return res.status(403).json({ message: 'Only room members can vote in this poll' });
    }
  }

  const currentMeta = (doc.meta && typeof doc.meta === 'object') ? doc.meta : {};
  const pollRaw = currentMeta.poll;
  if (!pollRaw || typeof pollRaw !== 'object') {
    return res.status(400).json({ message: 'This message does not contain a poll' });
  }

  const question = String(pollRaw.question || '').trim();
  const rawOptions = Array.isArray(pollRaw.options) ? pollRaw.options : [];
  const normalizedOptions = rawOptions
    .map((option, idx) => ({
      id: String(option?.id || `opt-${idx + 1}`).trim() || `opt-${idx + 1}`,
      text: String(option?.text || '').trim().slice(0, 120),
      voters: Array.from(new Set((Array.isArray(option?.voters) ? option.voters : []).map((v) => String(v || '').trim()).filter(Boolean)))
    }))
    .filter((option) => option.text);

  if (!question || normalizedOptions.length < 2) {
    return res.status(400).json({ message: 'Invalid poll data' });
  }

  const targetIndex = normalizedOptions.findIndex((option) => String(option.id) === optionId);
  if (targetIndex === -1) return res.status(404).json({ message: 'Poll option not found' });

  const voterAliases = Array.from(new Set([String(auth.primary), ...(auth.ids || []).map(String)])).filter(Boolean);
  const canonicalVoterId = String(auth.primary);

  const alreadyVotedOption = normalizedOptions.find((option) => {
    const voters = Array.isArray(option?.voters) ? option.voters.map(String) : [];
    return voters.some((voter) => voterAliases.includes(String(voter)));
  });

  if (alreadyVotedOption) {
    const alreadyOnSameOption = String(alreadyVotedOption.id) === optionId;
    return res.status(409).json({
      message: alreadyOnSameOption
        ? 'You have already selected this option'
        : 'You have already answered this poll',
      optionId: String(alreadyVotedOption.id)
    });
  }

  const nextOptions = normalizedOptions.map((option, index) => {
    const voters = Array.from(new Set((Array.isArray(option.voters) ? option.voters : []).map(String).filter(Boolean)));
    if (index !== targetIndex) {
      return {
        ...option,
        voters
      };
    }

    return {
      ...option,
      voters: Array.from(new Set([...voters, canonicalVoterId]))
    };
  });

  const nextPoll = {
    question,
    options: nextOptions,
    createdBy: String(pollRaw.createdBy || ''),
    createdAt: String(pollRaw.createdAt || ''),
    updatedAt: new Date().toISOString()
  };

  doc.meta = {
    ...currentMeta,
    poll: nextPoll
  };
  await doc.save();

  // keep in-memory cache updated (best effort)
  try {
    const roomIdStr = String(doc.roomId || '');
    const list = messages.get(roomIdStr) || [];
    const idx = list.findIndex((item) => String(item?.id || '') === String(doc._id || ''));
    if (idx !== -1) {
      list[idx] = {
        ...list[idx],
        meta: {
          ...(list[idx]?.meta || {}),
          poll: nextPoll
        }
      };
      messages.set(roomIdStr, list);
    }
  } catch (e) {}

  // emit as a message-update event via existing channel so clients merge by id
  try {
    const io = req.app.get('io');
    if (io) {
      io.to(String(doc.roomId)).emit('room:message', {
        id: doc._id.toString(),
        roomId: String(doc.roomId),
        senderId: String(doc.senderId),
        senderName: String(doc.senderName || ''),
        content: decryptMessageContent(doc.content),
        type: doc.type,
        attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
        timestamp: doc.createdAt,
        replyTo: doc.replyTo,
        meta: doc.meta || {}
      });
    }
  } catch (e) {}

  res.json({ message: 'vote recorded', id: doc._id.toString(), poll: nextPoll });
}));

router.post('/messages/:id/reactions', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const emoji = (req.body?.emoji || '').toString();
  if (!emoji) return res.status(400).json({ message: 'emoji required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  doc.reactions = Array.isArray(doc.reactions) ? doc.reactions : [];
  const exists = doc.reactions.find(r => String(r.emoji) === emoji && auth.ids.includes(String(r.userId)));
  if (!exists) {
    doc.reactions.push({ emoji, userId: String(auth.primary), createdAt: new Date() });
    await doc.save();
  }

  res.json({ message: 'reaction added', id: doc._id.toString(), reactions: Array.isArray(doc.reactions) ? doc.reactions : [] });
}));

router.delete('/messages/:id/reactions', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const emoji = (req.query?.emoji || '').toString();
  if (!emoji) return res.status(400).json({ message: 'emoji required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  doc.reactions = Array.isArray(doc.reactions) ? doc.reactions : [];
  doc.reactions = doc.reactions.filter(r => !(String(r.emoji) === emoji && auth.ids.includes(String(r.userId))));
  await doc.save();

  res.json({ message: 'reaction removed', id: doc._id.toString(), reactions: Array.isArray(doc.reactions) ? doc.reactions : [] });
}));

// Mark a message as viewed by the current user (one-time preview per user)
router.post('/messages/:id/view', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  // Try to find the message in any of the collections
  let doc = await RoomMessage.findById(id).catch(() => null);
  if (!doc) doc = await DMMessage.findById(id).catch(() => null);
  if (!doc) doc = await RandomMessage.findById(id).catch(() => null);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const meta = doc.meta || {};
  meta.viewed = Array.isArray(meta.viewed) ? meta.viewed : [];
  const existing = meta.viewed.find(v => auth.ids.includes(String(v.userId)));
  const now = new Date();
  if (!existing) {
    meta.viewed.push({ userId: String(auth.primary), viewedAt: now, expireAt: null });
  }
  doc.meta = meta;
  await doc.save();
  res.json({ message: 'view recorded', alreadyViewed: Boolean(existing) });
}));

export default router;
