import fetch from 'node-fetch';
import { env } from '../config/env.js';

// assessIpRisk(ip) -> { risk: boolean, score?: number, reason?: string, provider?: string }
export const assessIpRisk = async (ip) => {
  if (!ip) return { risk: false };

  // 1) IPQualityScore if configured
  try {
    if (env.IPINTEL_PROVIDER === 'ipquality' && env.IPINTEL_KEY) {
      const url = `https://ipqualityscore.com/api/json/ip/${env.IPINTEL_KEY}/${encodeURIComponent(ip)}?strictness=1`;
      const res = await fetch(url, { timeout: 5000 });
      if (res.ok) {
        const json = await res.json();
        const isVpn = Boolean(json?.vpn || json?.proxy || json?.tor);
        const score = Number(json?.fraud_score || 0);
        // Only treat as high-risk when IP is explicitly a VPN/proxy/TOR exit node.
        // We keep fraud_score available for monitoring but do not auto-block on score alone.
        const risk = isVpn;
        return { risk, score, reason: isVpn ? 'vpn/proxy/tor' : (score ? `score:${score}` : 'ipquality'), provider: 'ipquality' };
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
