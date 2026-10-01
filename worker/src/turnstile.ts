const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerificationInput {
  token: string;
  secretKey: string;
  remoteIp: string;
  expectedHostname?: string;
}

export type TurnstileVerifier = (input: TurnstileVerificationInput) => Promise<boolean>;

export const verifyTurnstile: TurnstileVerifier = async (input) => {
  if (!input.token || input.token.length > 2048 || !input.secretKey) return false;
  const body = new FormData();
  body.append('secret', input.secretKey);
  body.append('response', input.token);
  if (input.remoteIp !== 'unknown') body.append('remoteip', input.remoteIp);

  const response = await fetch(SITEVERIFY_URL, { method: 'POST', body });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean; hostname?: string };
  if (result.success !== true) return false;
  if (input.expectedHostname && result.hostname !== input.expectedHostname) return false;
  return true;
};
