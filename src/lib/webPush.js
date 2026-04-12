import webpush from 'web-push';
import { env } from '../config/env.js';
import PushSubscription from '../models/PushSubscription.js';
import User from '../models/User.js';
import { decryptMessageContent } from './messageCrypto.js';

const DEFAULT_ICON = '/icons/icon-192.png';
const DEFAULT_BADGE = '/icons/icon-192.png';

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const normalizeIdentifier = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.includes('@') ? raw.toLowerCase() : raw;
};

const uniqIdentifiers = (values = []) => Array.from(new Set((values || []).map(normalizeIdentifier).filter(Boolean)));

const getAliasesFromUserDoc = (doc) => uniqIdentifiers([doc?._id, doc?.guestId, doc?.email]);

const buildRoomUrl = (roomId, type) => {
  const normalizedRoomId = String(roomId || '').trim();
  if (!normalizedRoomId) return '/dashboard';

  const encodedRoomId = encodeURIComponent(normalizedRoomId);
  const normalizedType = String(type || '').toLowerCase();

  if (normalizedType === 'dm' || normalizedRoomId.startsWith('dm-')) {
    return `/dashboard?dm=${encodedRoomId}`;
  }

  return `/chat/${encodedRoomId}`;
};

const getPushPreferenceForType = (notifications, type) => {
  const prefs = notifications && typeof notifications === 'object' ? notifications : {};

  if (prefs.webPushEnabled === false) return false;

  const normalizedType = String(type || '').toLowerCase();
  if (normalizedType === 'dm') return prefs.messages !== false;
  if (normalizedType === 'mention' || normalizedType === 'reply') return prefs.mentions !== false;
  if (normalizedType === 'system') return prefs.systemUpdates === true;
  if (normalizedType === 'groupinvite' || normalizedType === 'group_invite') return prefs.groupInvites !== false;

  return prefs.messages !== false;
};

const buildPushPayload = (notification) => {
  const title = String(notification?.title || 'Zoktu');
  const decryptedMsg = decryptMessageContent(notification?.message);
  const body = String(decryptedMsg || 'You have a new notification');
  const roomId = String(notification?.roomId || '').trim();
  const type = String(notification?.type || 'system').toLowerCase();
  const targetUrl = String(notification?.url || buildRoomUrl(roomId, type));

  return {
    title,
    body,
    icon: DEFAULT_ICON,
    badge: DEFAULT_BADGE,
    tag: `zoktu-${type || 'notification'}-${roomId || 'general'}`,
    renotify: true,
    vibrate: [120, 50, 120],
    data: {
      url: targetUrl,
      roomId: roomId || null,
      messageId: notification?.messageId ? String(notification.messageId) : null,
      type,
      actorId: notification?.actorId ? String(notification.actorId) : null
    }
  };
};

const resolveUsersByIdentifiers = async (identifiers = []) => {
  const normalized = uniqIdentifiers(identifiers);
  if (!normalized.length) return [];

  const objectIds = normalized.filter((id) => looksLikeObjectId(id));
  const emails = normalized.filter((id) => id.includes('@'));
  const guestIds = normalized.filter((id) => !id.includes('@') && !looksLikeObjectId(id));

  const or = [
    ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ...(guestIds.length ? [{ guestId: { $in: guestIds } }] : []),
    ...(emails.length ? [{ email: { $in: emails } }] : [])
  ];

  if (!or.length) return [];

  return await User.find({ $or: or })
    .select('_id guestId email settings')
    .lean()
    .exec()
    .catch(() => []);
};

let vapidConfigured = false;

export const isWebPushConfigured = () => Boolean(env.webPushPublicKey && env.webPushPrivateKey);

const ensureVapidConfigured = () => {
  if (!isWebPushConfigured()) return false;

  if (!vapidConfigured) {
    webpush.setVapidDetails(
      String(env.webPushSubject || 'mailto:noreply@zoktu.com'),
      String(env.webPushPublicKey),
      String(env.webPushPrivateKey)
    );
    vapidConfigured = true;
  }

  return true;
};

export const getWebPushPublicKey = () => String(env.webPushPublicKey || '');

export const normalizePushSubscription = (subscription) => {
  if (!subscription || typeof subscription !== 'object') return null;

  const endpoint = String(subscription.endpoint || '').trim();
  const p256dh = String(subscription?.keys?.p256dh || '').trim();
  const auth = String(subscription?.keys?.auth || '').trim();

  if (!endpoint || !p256dh || !auth) return null;

  let expirationTime = null;
  if (subscription.expirationTime !== null && subscription.expirationTime !== undefined && subscription.expirationTime !== '') {
    const parsedExpiration = Number(subscription.expirationTime);
    expirationTime = Number.isFinite(parsedExpiration) ? parsedExpiration : null;
  }

  return {
    endpoint,
    expirationTime,
    keys: {
      p256dh,
      auth
    }
  };
};

export const upsertPushSubscription = async ({
  userId,
  userAliases = [],
  subscription,
  userAgent = '',
  deviceId = ''
}) => {
  const normalizedSubscription = normalizePushSubscription(subscription);
  if (!normalizedSubscription) return null;

  const aliases = uniqIdentifiers([userId, ...(userAliases || [])]);
  const primaryUserId = normalizeIdentifier(userId) || aliases[0] || '';
  const now = new Date();

  return await PushSubscription.findOneAndUpdate(
    { 'subscription.endpoint': normalizedSubscription.endpoint },
    {
      $set: {
        userId: primaryUserId,
        userAliases: aliases,
        subscription: normalizedSubscription,
        userAgent: String(userAgent || '').slice(0, 500),
        deviceId: String(deviceId || '').slice(0, 200),
        disabledAt: null,
        updatedAt: now,
        failureReason: ''
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();
};

export const removePushSubscription = async ({ endpoint, userAliases = [], userId = '', deviceId = '' } = {}) => {
  const normalizedEndpoint = String(endpoint || '').trim();
  const normalizedDeviceId = String(deviceId || '').trim();
  const aliases = uniqIdentifiers([userId, ...(userAliases || [])]);

  if (!normalizedEndpoint && !normalizedDeviceId) return 0;

  const endpointOrDeviceFilters = [];
  if (normalizedEndpoint) endpointOrDeviceFilters.push({ 'subscription.endpoint': normalizedEndpoint });
  if (normalizedDeviceId) endpointOrDeviceFilters.push({ deviceId: normalizedDeviceId });

  const endpointOrDeviceQuery = endpointOrDeviceFilters.length === 1
    ? endpointOrDeviceFilters[0]
    : { $or: endpointOrDeviceFilters };

  const ownershipQuery = aliases.length
    ? {
        $or: [
          { userId: { $in: aliases } },
          { userAliases: { $in: aliases } }
        ]
      }
    : null;

  const query = ownershipQuery
    ? { $and: [endpointOrDeviceQuery, ownershipQuery] }
    : endpointOrDeviceQuery;

  const result = await PushSubscription.deleteMany(query).exec().catch(() => null);
  return Number(result?.deletedCount || 0);
};

export const sendWebPushNotifications = async ({ notifications = [] } = {}) => {
  if (!ensureVapidConfigured()) {
    return { attempted: 0, sent: 0, failed: 0, skipped: Array.isArray(notifications) ? notifications.length : 0 };
  }

  const normalizedNotifications = (notifications || [])
    .map((notification) => ({
      ...notification,
      userId: normalizeIdentifier(notification?.userId)
    }))
    .filter((notification) => notification.userId);

  if (!normalizedNotifications.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const recipientIds = uniqIdentifiers(normalizedNotifications.map((notification) => notification.userId));
  const users = await resolveUsersByIdentifiers(recipientIds);

  const usersByAlias = new Map();
  for (const user of users || []) {
    const aliases = getAliasesFromUserDoc(user);
    for (const alias of aliases) {
      if (!usersByAlias.has(alias)) {
        usersByAlias.set(alias, user);
      }
    }
  }

  const candidateAliasesByNotification = new Map();
  const filteredNotifications = [];

  for (const notification of normalizedNotifications) {
    const matchedUser = usersByAlias.get(notification.userId) || null;
    if (!getPushPreferenceForType(matchedUser?.settings?.notifications, notification.type)) {
      continue;
    }

    const aliases = uniqIdentifiers([
      notification.userId,
      ...(matchedUser ? getAliasesFromUserDoc(matchedUser) : [])
    ]);

    candidateAliasesByNotification.set(notification, aliases);
    filteredNotifications.push(notification);
  }

  if (!filteredNotifications.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: normalizedNotifications.length };
  }

  const allAliases = uniqIdentifiers(
    filteredNotifications.flatMap((notification) => candidateAliasesByNotification.get(notification) || [])
  );

  if (!allAliases.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: normalizedNotifications.length };
  }

  const subscriptions = await PushSubscription.find({
    disabledAt: null,
    userAliases: { $in: allAliases }
  })
    .lean()
    .exec()
    .catch(() => []);

  if (!subscriptions.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: normalizedNotifications.length };
  }

  const jobsByEndpoint = new Map();
  for (const subscriptionDoc of subscriptions) {
    const endpoint = String(subscriptionDoc?.subscription?.endpoint || '').trim();
    if (!endpoint || jobsByEndpoint.has(endpoint)) continue;

    const subscriptionAliases = uniqIdentifiers(subscriptionDoc?.userAliases || []);
    let matchedNotification = null;

    for (const notification of filteredNotifications) {
      const notificationAliases = candidateAliasesByNotification.get(notification) || [];
      if (notificationAliases.some((alias) => subscriptionAliases.includes(alias))) {
        matchedNotification = notification;
        break;
      }
    }

    if (!matchedNotification) continue;

    const payload = JSON.stringify(buildPushPayload(matchedNotification));
    jobsByEndpoint.set(endpoint, {
      subscriptionDoc,
      payload
    });
  }

  if (!jobsByEndpoint.size) {
    return { attempted: 0, sent: 0, failed: 0, skipped: normalizedNotifications.length };
  }

  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    Array.from(jobsByEndpoint.values()).map(async ({ subscriptionDoc, payload }) => {
      try {
        await webpush.sendNotification(subscriptionDoc.subscription, payload, {
          TTL: 120,
          urgency: 'high'
        });

        sent += 1;

        await PushSubscription.updateOne(
          { _id: subscriptionDoc._id },
          {
            $set: {
              lastSuccessAt: new Date(),
              lastFailureAt: null,
              failureReason: '',
              disabledAt: null,
              updatedAt: new Date()
            }
          }
        ).exec();
      } catch (error) {
        failed += 1;
        const statusCode = Number(error?.statusCode || 0);

        if (statusCode === 404 || statusCode === 410) {
          await PushSubscription.deleteOne({ _id: subscriptionDoc._id }).exec().catch(() => null);
          return;
        }

        await PushSubscription.updateOne(
          { _id: subscriptionDoc._id },
          {
            $set: {
              lastFailureAt: new Date(),
              failureReason: String(error?.message || 'push send failed').slice(0, 300),
              updatedAt: new Date()
            }
          }
        ).exec().catch(() => null);
      }
    })
  );

  return {
    attempted: jobsByEndpoint.size,
    sent,
    failed,
    skipped: Math.max(0, normalizedNotifications.length - jobsByEndpoint.size)
  };
};
