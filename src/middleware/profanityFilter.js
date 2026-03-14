// Simple server-side profanity/explicit content detector
// Keeps a compact wordlist and provides helpers to detect disallowed tokens.

const DEFAULT_PROFANITY = [
  // English / common (romanized)
  'nude','nudity','nudes','porn','pornography','xxx','adult','sex','sexual','sexuality',
  'fuck','fucked','fucking','fucker','fucks','cock','dick','pussy','boobs','tits','breasts','nipples', 'horny','sexting','lesbian','gay',
  'anal','oral','blowjob','handjob','masturbate','masturbation','cum','semen','orgasm','chut','chutiya','chuti','chudai','chod','choda','gand','gaand','lund','lunda','land','lond','lundoo','bhenchod','madarchod','madar','maderchod','bhosdike','bhosadi','bhosdika','randi','randa','chodna','mutth','mutthi','mutth'
];

// Precompute normalized bad words for faster checks
const normalizeWord = (w) => {
  if (!w) return '';
  return String(w || '')
    .toLowerCase()
    // keep Unicode letters and numbers, remove punctuation/spacing
    .replace(/[^\p{L}\p{N}]/gu, '')
    // collapse repeated characters (works across unicode with u flag)
    .replace(/(.)\1+/gu, '$1');
};

const PROFANITY_SET = new Set(DEFAULT_PROFANITY.map(s => normalizeWord(s)).filter(Boolean));

// Common leet replacements to deobfuscate obvious substitutions
const LEET_MAP = {
  '4': 'a',
  '@': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '0': 'o',
  '5': 's',
  '$': 's',
  '7': 't',
  '8': 'b'
};

const applyLeetMap = (s) => {
  return s.replace(/[0-9@!$]/g, (ch) => LEET_MAP[ch] || ch);
};

// Devanagari transliteration removed by request — no-op placeholder
const devanagariToLatin = (text) => String(text);

const cleanAndTokenize = (text) => {
  if (!text) return [];
  let lowered = String(text).toLowerCase();
  // map leet chars first
  lowered = applyLeetMap(lowered);
  // replace non-letter/digit (unicode-aware) with space to break tokens
  const cleaned = lowered.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned.split(/\s+/).filter(Boolean);
};

// Normalize whole input to a dense form to catch obfuscated joined words
const normalizeForMatch = (text) => {
  if (!text) return '';
  let s = String(text).toLowerCase();
  s = applyLeetMap(s);
  // remove any non-letter/digit (unicode-aware)
  s = s.replace(/[^\p{L}\p{N}]/gu, '');
  // collapse repeated letters (fuuuuck -> fuck)
  s = s.replace(/(.)\1+/gu, '$1');
  return s;
};

// Return proportion of characters in `bad` found as an ordered subsequence in `haystack`
const subsequenceMatchRatio = (haystack, bad) => {
  if (!haystack || !bad) return 0;
  let i = 0, j = 0, matched = 0;
  const H = String(haystack);
  const B = String(bad);
  while (i < H.length && j < B.length) {
    if (H[i] === B[j]) {
      matched += 1;
      j += 1;
    }
    i += 1;
  }
  return matched / B.length;
};

// Small allowlist of common short/safe tokens to avoid false positives (normalized form)
const SAFE_ALLOWLIST = new Set(['m','ya','ho','bhai','bro','dude','ok','okay','yes','no','ha','nah','hello','hi'].map(s => normalizeWord(s)));

export const containsProfanity = (text) => {
  if (!text) return false;

  // Token-level quick checks (handles spaced words)
  const tokens = cleanAndTokenize(text);
  for (const t of tokens) {
    const norm = normalizeWord(applyLeetMap(t));
    if (!norm) continue;
    if (PROFANITY_SET.has(norm)) return true;
  }

  // If input contains Devanagari, also check its romanized form
  try {
    const romanized = devanagariToLatin(text);
    if (romanized && romanized !== String(text)) {
      const tokens2 = cleanAndTokenize(romanized);
      for (const t of tokens2) {
        const norm = normalizeWord(applyLeetMap(t));
        if (!norm) continue;
        if (PROFANITY_SET.has(norm)) return true;
      }
    }
  } catch (e) {}

  // Dense normalized string check (handles underscores, punctuation, mixed-case, repeated chars, joined words)
  try {
    // Work per-token to avoid matching across unrelated long words
    const denseTokens = cleanAndTokenize(String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')).map(t => normalizeWord(applyLeetMap(t)));
    if (denseTokens && denseTokens.length) {
      for (const bad of PROFANITY_SET) {
        if (!bad) continue;
        for (const tok of denseTokens) {
          if (!tok) continue;
          // skip safe short tokens and extremely short words
          if (SAFE_ALLOWLIST.has(tok) || tok.length <= 2) continue;
          // require token to contain the bad term and not be an overly long unrelated word
          if (tok.includes(bad) && tok.length <= bad.length + 3) return true;
        }
      }
    }
  } catch (e) {
    // fail-open on unexpected errors
  }

  // Heuristic subsequence matching to catch obfuscation like `f*ck`, `f**k`, `f_ck`, `f.u.c.k` etc.
  try {
    // Tokenize and apply subsequence check per token to avoid cross-word false positives
    const raw = applyLeetMap(String(text).toLowerCase()).replace(/[^\p{L}\p{N}\*\s]/gu, ' ');
    const tokenHay = cleanAndTokenize(raw);
    for (const token of tokenHay) {
      if (!token) continue;
      const normTok = normalizeWord(applyLeetMap(token));
      // skip safe short tokens and extremely short words
      if (!normTok || SAFE_ALLOWLIST.has(normTok) || normTok.length <= 2) continue;
      for (const bad of PROFANITY_SET) {
        if (!bad) continue;
        const ratio = subsequenceMatchRatio(normTok, bad);
        // Tighten normal threshold to reduce false positives
        if (ratio >= 0.85) return true;
        // If token contains '*' allow a slightly lower threshold
        if (token.includes('*') && ratio >= 0.7) return true;
      }
    }
  } catch (e) {
    // ignore
  }

  return false;
};

const ALLOWED_LINK_HOSTS = new Set(['zoktu.com', 'www.zoktu.com']);

const normalizeHost = (raw) => {
  if (!raw) return '';
  const host = String(raw).toLowerCase().trim().replace(/\u0000/g, '');
  return host.replace(/:\d+$/, '');
};

const isAllowedHost = (host) => {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (ALLOWED_LINK_HOSTS.has(normalized)) return true;
  return normalized.endsWith('.zoktu.com');
};

const extractLinkCandidates = (text) => {
  const input = String(text || '');
  if (!input.trim()) return [];

  const out = [];
  const rx = /(?:https?:\/\/[^\s]+)|(?:www\.[^\s]+)|(?:\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s]*)?\b)/gi;
  let match = null;
  while ((match = rx.exec(input)) !== null) {
    const v = String(match[0] || '').trim();
    if (v) out.push(v);
  }
  return out;
};

const tryGetHostname = (candidate) => {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return normalizeHost(url.hostname || '');
  } catch (e) {
    return '';
  }
};

// Returns true when text contains a link that is not zoktu.com (or its subdomains).
export const containsBlockedExternalLink = (text) => {
  const links = extractLinkCandidates(text);
  if (!links.length) return false;

  for (const link of links) {
    const host = tryGetHostname(link);
    if (!host) continue;
    if (!isAllowedHost(host)) return true;
  }

  return false;
};
export default containsProfanity;
