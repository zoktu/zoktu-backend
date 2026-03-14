import fetch from 'node-fetch';
import { env } from '../config/env.js';

// assessIpRisk(ip, context) -> { risk: boolean, score?: number, reason?: string, provider?: string }
export const assessIpRisk = async (ip, context = {}) => {
  if (!ip) return { risk: false };

  // 1) IPQualityScore if configured
  try {
    if (env.IPINTEL_PROVIDER === 'ipquality' && env.IPINTEL_KEY) {
      const strictness = Number.isFinite(Number(env.IPINTEL_STRICTNESS))
        ? Math.min(3, Math.max(0, Number(env.IPINTEL_STRICTNESS)))
        : 1;
      const allowPublicAccessPoints = String(env.IPINTEL_ALLOW_PUBLIC_ACCESS_POINTS || 'true').toLowerCase() === 'true';
      const userAgent = String(context.userAgent || '').trim();
      const userLanguage = String(context.userLanguage || '').trim();

      const params = new URLSearchParams();
      params.set('strictness', String(strictness));
      params.set('allow_public_access_points', allowPublicAccessPoints ? 'true' : 'false');
      if (userAgent) params.set('user_agent', userAgent);
      if (userLanguage) params.set('user_language', userLanguage);

      const url = `https://ipqualityscore.com/api/json/ip/${env.IPINTEL_KEY}/${encodeURIComponent(ip)}?${params.toString()}`;
      const res = await fetch(url, { timeout: 5000 });
      if (res.ok) {
        const json = await res.json();
        if (json && json.success === false) {
          return { risk: false, reason: json?.message || 'ipquality-error', provider: 'ipquality' };
        }

        const isVpn = Boolean(
          json?.vpn ||
          json?.proxy ||
          json?.tor ||
          json?.active_vpn ||
          json?.active_tor ||
          json?.bot_status ||
          json?.recent_abuse ||
          json?.high_risk_attacks
        );
        const score = Number(json?.fraud_score || 0);
        const fraudBlockThreshold = Number.isFinite(Number(env.IPINTEL_FRAUD_BLOCK_SCORE))
          ? Number(env.IPINTEL_FRAUD_BLOCK_SCORE)
          : 85;
        const risk = isVpn || score >= fraudBlockThreshold;

        return {
          risk,
          score,
          reason: risk
            ? (isVpn ? 'vpn/proxy/tor-or-abuse' : `fraud_score:${score}`)
            : (score ? `score:${score}` : 'ipquality-ok'),
          provider: 'ipquality'
        };
      }
    }
  } catch (e) {
    // ignore provider errors
  }

  // 2) MaxMind local DB (optional)
  try {
    if (env.MAXMIND_DB_PATH) {
      const maxmind = await import('maxmind');
      const reader = await maxmind.open(env.MAXMIND_DB_PATH);
      const info = reader.get(ip);
      if (info && info.traits) {
        const traits = info.traits;
        const anon = Boolean(traits.is_anonymous || traits.is_anonymous_proxy || traits.is_anonymous_vpn || traits.is_proxy);
        if (anon) return { risk: true, reason: 'maxmind-anonymous', provider: 'maxmind' };
      }
    }
  } catch (e) {
    // ignore missing package/db
  }

  // 3) fallback: low confidence - no provider configured
  return { risk: false };
};

export default assessIpRisk;
