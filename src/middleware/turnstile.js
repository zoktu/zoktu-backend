// Turnstile verification disabled — middleware is a no-op to remove site verification.
export const verifyTurnstile = async (req, res, next) => {
  // Previously this validated Cloudflare Turnstile tokens. It's intentionally
  // disabled to remove site verification. Proceed without checks.
  return next();
};
