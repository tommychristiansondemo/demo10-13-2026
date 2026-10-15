// Any signed-in user of the class's Cognito user pool may use Class Insights (read-only).
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config.js';

let verifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; tokenUse: 'access'; clientId: string[] }>> | undefined;

export async function authenticate(token: string | undefined): Promise<string> {
  if (config.localDev) return 'local.dev';
  if (!token) throw new AuthError('Missing X-Auth-Token');
  verifier ??= CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: 'access', clientId: config.clientIds });
  try {
    return String((await verifier.verify(token.replace(/^Bearer\s+/i, ''))).username);
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}

export class AuthError extends Error {}
