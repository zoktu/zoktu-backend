// Simple server-side profanity/explicit content detector
// Keeps a compact wordlist and provides helpers to detect disallowed tokens.

const DEFAULT_PROFANITY = [
  'nude','nudity','nudes','porn','pornography','xxx','adult','sex','sexual','sexuality',
  'fuck','fucked','fucking','fucker','fucks','cock','dick','pussy','boobs','tits','breasts','nipples',
  'anal','oral','blowjob','handjob','masturbate','masturbation','cum','semen','orgasm','chut','gand','chudai','land','lund','sexting','chod','muh'
];

// Precompute normalized bad words for faster checks
const normalizeWord = (w) => {
  if (!w) return '';
  return String(w || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');
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

const cleanAndTokenize = (text) => {
  if (!text) return [];
  let lowered = String(text).toLowerCase();
  // map leet chars first
  lowered = applyLeetMap(lowered);
  // replace non-alphanum with space to break tokens
  const cleaned = lowered.replace(/[^a-z0-9\s]/g, ' ');
  return cleaned.split(/\s+/).filter(Boolean);
};

// Normalize whole input to a dense form to catch obfuscated joined words
const normalizeForMatch = (text) => {
  if (!text) return '';
  let s = String(text).toLowerCase();
  s = applyLeetMap(s);
  // remove any non-letters/digits (including underscores, hyphens, spaces)
  s = s.replace(/[^a-z0-9]/g, '');
  // collapse repeated letters (fuuuuck -> fuck)
  s = s.replace(/(.)\1+/g, '$1');
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

export const containsProfanity = (text) => {
  if (!text) return false;

  // Token-level quick checks (handles spaced words)
  const tokens = cleanAndTokenize(text);
  for (const t of tokens) {
    const norm = normalizeWord(applyLeetMap(t));
    if (!norm) continue;
    if (PROFANITY_SET.has(norm)) return true;
  }

  // Dense normalized string check (handles underscores, punctuation, mixed-case, repeated chars, joined words)
  try {
    const dense = normalizeForMatch(text);
    if (dense) {
      for (const bad of PROFANITY_SET) {
        if (!bad) continue;
        if (dense.includes(bad)) return true;
      }
    }
  } catch (e) {
    // fail-open on unexpected errors
  }

  // Heuristic subsequence matching to catch obfuscation like `f*ck`, `f**k`, `f_ck`, `f.u.c.k` etc.
  try {
    const hay = applyLeetMap(String(text).toLowerCase()).replace(/[^a-z0-9\*]/g, '');
    for (const bad of PROFANITY_SET) {
      if (!bad) continue;
      const ratio = subsequenceMatchRatio(hay, bad);
      // Normal threshold: require most letters present in order
      if (ratio >= 0.66) return true;
      // If user used '*' or heavy punctuation obfuscation, be more lenient
      if (hay.includes('*') && ratio >= 0.5) return true;
    }
  } catch (e) {
    // ignore
  }

  return false;
};

export default containsProfanity;
