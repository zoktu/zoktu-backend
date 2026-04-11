import fetch from 'node-fetch';
import cloudinary from 'cloudinary';
import { env } from '../config/env.js';

const DEFAULT_BLOCKED_LABELS = [
  'adult',
  'nsfw',
  'porn',
  'hentai',
  'nudity',
  'sexual',
  'sexy',
  'violence',
  'blood',
  'gore',
  'graphic',
  'weapon',
  'harassment',
  'abuse',
  'hate'
];

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'heic',
  'heif',
  'jfif'
]);

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLabel = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[_\s-]+/g, ' ')
  .replace(/[^a-z0-9 ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const getBlockedLabels = () => {
  const custom = String(env.imageModerationBlockedLabels || '')
    .split(',')
    .map((item) => normalizeLabel(item))
    .filter(Boolean);

  const labels = custom.length ? custom : DEFAULT_BLOCKED_LABELS;
  return Array.from(new Set(labels.map((item) => normalizeLabel(item)).filter(Boolean)));
};

const labelMatchesBlocked = (candidateLabel, blockedLabels) => {
  const candidate = normalizeLabel(candidateLabel);
  if (!candidate) return false;

  for (const blocked of blockedLabels) {
    const token = normalizeLabel(blocked);
    if (!token) continue;
    if (candidate === token) return true;
    if (token.length >= 4 && candidate.includes(token)) return true;
  }

  return false;
};

const parseScore = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 0 && numeric <= 1) return numeric;
  if (numeric > 1 && numeric <= 100) return numeric / 100;
  return clamp(numeric, 0, 1);
};

const getImageUrlExtension = (url) => {
  try {
    const pathname = new URL(String(url || '')).pathname || '';
    const lastSegment = pathname.split('/').pop() || '';
    const candidate = lastSegment.split('.').pop() || '';
    return String(candidate).toLowerCase();
  } catch (e) {
    return '';
  }
};

const isLikelyImageUrl = (url) => {
  const normalizedUrl = String(url || '').trim().toLowerCase();
  if (!normalizedUrl) return false;
  if (normalizedUrl.includes('/image/upload/')) return true;
  const ext = getImageUrlExtension(normalizedUrl);
  return IMAGE_EXTENSIONS.has(ext);
};

export const isImageAttachment = (attachment = {}) => {
  const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  return isLikelyImageUrl(attachment?.url);
};

const toLabelEntry = (label, rawScore) => {
  const normalized = normalizeLabel(label);
  const score = parseScore(rawScore);
  if (!normalized || score === null) return null;
  return { label: normalized, score };
};

const mergeByMaxScore = (entries = []) => {
  const byLabel = new Map();
  for (const entry of entries) {
    if (!entry?.label || typeof entry.score !== 'number') continue;
    const prev = byLabel.get(entry.label);
    if (!prev || entry.score > prev.score) {
      byLabel.set(entry.label, entry);
    }
  }
  return Array.from(byLabel.values());
};

const extractLabelScores = (payload) => {
  const entries = [];
  const seen = new Set();

  const visit = (node, depth = 0) => {
    if (!node || depth > 5) return;
    if (seen.has(node)) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    if (typeof node !== 'object') return;

    seen.add(node);

    const direct = toLabelEntry(
      node.label || node.name || node.className || node.class || node.category || node.tag,
      node.score ?? node.confidence ?? node.probability ?? node.value ?? node.p
    );
    if (direct) entries.push(direct);

    const containers = [
      node.labels,
      node.predictions,
      node.categories,
      node.results,
      node.output,
      node.data,
      node.classes,
      node.classifications,
      node.scores
    ];

    for (const container of containers) {
      if (container) visit(container, depth + 1);
    }

    const objectEntries = Object.entries(node);
    const numericPairs = objectEntries
      .filter(([key, value]) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return false;
        const normalizedKey = normalizeLabel(key);
        if (!normalizedKey) return false;
        if (['score', 'confidence', 'probability', 'value', 'p'].includes(normalizedKey)) return false;
        return true;
      });

    if (numericPairs.length >= 2 && numericPairs.length === objectEntries.length) {
      for (const [label, score] of numericPairs) {
        const mapped = toLabelEntry(label, score);
        if (mapped) entries.push(mapped);
      }
    }
  };

  visit(payload, 0);
  return mergeByMaxScore(entries);
};

const evaluateModerationPayload = (payload, threshold, blockedLabels) => {
  const rawText = normalizeLabel(payload?.raw || payload?.message || payload?.verdict || '');
  const rawTokens = rawText ? rawText.split(' ').filter(Boolean) : [];

  const unsafeTokenSet = new Set([
    'unsafe',
    'nsfw',
    'porn',
    'hentai',
    'nudity',
    'sexual',
    'adult',
    'violence',
    'blood',
    'gore',
    'weapon',
    'harassment',
    'abuse',
    'hate',
    'blocked',
    'reject',
    'rejected',
    'flagged'
  ]);
  const safeTokenSet = new Set(['safe', 'clean', 'allowed', 'approved', 'ok', 'pass']);

  const rawIndicatesUnsafe = rawTokens.some((token) => unsafeTokenSet.has(token));
  const rawIndicatesSafe = rawTokens.some((token) => safeTokenSet.has(token));

  const explicitUnsafe = parseBoolean(
    payload?.unsafe ?? payload?.isUnsafe ?? payload?.blocked ?? payload?.reject ?? payload?.flagged,
    false
  );
  const explicitSafe = parseBoolean(
    payload?.safe ?? payload?.isSafe ?? payload?.allowed ?? payload?.ok,
    false
  );

  const scores = extractLabelScores(payload);
  const matchedCategories = scores
    .filter((entry) => labelMatchesBlocked(entry.label, blockedLabels) && entry.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (explicitUnsafe || rawIndicatesUnsafe || matchedCategories.length) {
    return {
      hasSignal: true,
      isSafe: false,
      matchedCategories
    };
  }

  if (explicitSafe || rawIndicatesSafe || scores.length) {
    return {
      hasSignal: true,
      isSafe: true,
      matchedCategories: []
    };
  }

  return {
    hasSignal: false,
    isSafe: true,
    matchedCategories: []
  };
};

export const moderateImageAttachment = async ({ attachment, roomId, senderId } = {}) => {
  const isEnabled = parseBoolean(env.imageModerationEnabled, false);
  const serviceUrl = String(env.imageModerationServiceUrl || '').trim();

  if (!isEnabled || !serviceUrl) {
    return {
      checked: false,
      isSafe: true,
      reason: 'disabled'
    };
  }

  const imageUrl = String(attachment?.url || '').trim();
  if (!imageUrl) {
    return {
      checked: false,
      isSafe: true,
      reason: 'missing-image-url'
    };
  }

  const threshold = clamp(parseNumber(env.imageModerationThreshold, 0.72), 0, 1);
  const timeoutMs = clamp(Math.round(parseNumber(env.imageModerationTimeoutMs, 4500)), 800, 30000);
  const failOpen = parseBoolean(env.imageModerationFailOpen, true);
  const blockedLabels = getBlockedLabels();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch (e) {
      // ignore
    }
  }, timeoutMs);

  const headers = {
    'Content-Type': 'application/json'
  };

  const apiKey = String(env.imageModerationApiKey || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        imageUrl,
        image_url: imageUrl,
        senderId: String(senderId || ''),
        roomId: String(roomId || ''),
        threshold,
        blockedLabels,
        attachment: {
          url: imageUrl,
          mimeType: String(attachment?.mimeType || ''),
          fileName: String(attachment?.fileName || ''),
          fileSize: Number(attachment?.fileSize || 0),
          publicId: String(attachment?.publicId || '')
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const rawText = await response.text().catch(() => '');
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      payload = { raw: rawText };
    }

    if (!response.ok) {
      if (failOpen) {
        return {
          checked: false,
          isSafe: true,
          reason: `service-http-${response.status}`
        };
      }
      return {
        checked: true,
        isSafe: false,
        reason: `service-http-${response.status}`,
        matchedCategories: []
      };
    }

    const evaluation = evaluateModerationPayload(payload, threshold, blockedLabels);
    if (!evaluation.hasSignal && !failOpen) {
      return {
        checked: true,
        isSafe: false,
        reason: 'invalid-moderation-response',
        matchedCategories: []
      };
    }

    return {
      checked: true,
      isSafe: Boolean(evaluation.isSafe),
      reason: evaluation.isSafe ? 'safe' : 'unsafe',
      matchedCategories: evaluation.matchedCategories || []
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (failOpen) {
      return {
        checked: false,
        isSafe: true,
        reason: 'service-unreachable'
      };
    }

    return {
      checked: true,
      isSafe: false,
      reason: 'service-unreachable',
      matchedCategories: []
    };
  }
};

let isCloudinaryConfigured = false;

const ensureCloudinaryConfigured = () => {
  if (isCloudinaryConfigured) return true;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return false;

  cloudinary.v2.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret
  });
  isCloudinaryConfigured = true;
  return true;
};

const inferCloudinaryResourceTypes = (attachment = {}) => {
  const out = [];
  const mimeType = String(attachment?.mimeType || '').trim().toLowerCase();
  const url = String(attachment?.url || '').trim().toLowerCase();

  if (mimeType.startsWith('image/')) out.push('image');
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) out.push('video');

  if (url.includes('/image/upload/')) out.push('image');
  if (url.includes('/video/upload/')) out.push('video');
  if (url.includes('/raw/upload/')) out.push('raw');

  if (!out.length) out.push('image');
  out.push('video', 'raw');

  return Array.from(new Set(out));
};

export const deleteAttachmentAsset = async (attachment = {}) => {
  const publicId = String(attachment?.publicId || '').trim();
  if (!publicId) {
    return { deleted: false, reason: 'missing-public-id' };
  }

  if (!ensureCloudinaryConfigured()) {
    return { deleted: false, reason: 'cloudinary-not-configured' };
  }

  const resourceTypes = inferCloudinaryResourceTypes(attachment);
  let lastError = null;

  for (const resourceType of resourceTypes) {
    try {
      const result = await cloudinary.v2.uploader.destroy(publicId, {
        resource_type: resourceType,
        invalidate: true
      });

      const outcome = String(result?.result || '').toLowerCase();
      if (outcome === 'ok') {
        return { deleted: true, resourceType, result: outcome };
      }

      if (outcome && outcome !== 'not found') {
        return { deleted: false, resourceType, result: outcome };
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (lastError) {
    return {
      deleted: false,
      reason: 'cloudinary-delete-failed',
      error: String(lastError?.message || lastError)
    };
  }

  return { deleted: false, reason: 'not-found' };
};
