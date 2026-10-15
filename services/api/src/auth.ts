// Cognito access-token verification. CloudFront's Origin Access Control signs the request to the Lambda
// Function URL (overwriting Authorization), so the browser sends its token in X-Auth-Token instead.
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from './config.js';

export interface User {
  username: string;
  groups: string[];
  isAnalyst: boolean;
  isSupervisor: boolean;
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; tokenUse: 'access'; clientId: string }>> | undefined;

export class AuthError extends Error {}

export async function authenticate(token: string | undefined): Promise<User> {
  if (config.localDev) return toUser('local.dev', [config.analystGroup, config.supervisorGroup]);
  if (!token) throw new AuthError('Missing X-Auth-Token');
  verifier ??= CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: 'access', clientId: config.userPoolClientId });
  try {
    const claims = await verifier.verify(token.replace(/^Bearer\s+/i, ''));
    return toUser(String(claims.username), (claims['cognito:groups'] as string[] | undefined) ?? []);
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}

function toUser(username: string, groups: string[]): User {
  const isSupervisor = groups.includes(config.supervisorGroup);
  return { username, groups, isSupervisor, isAnalyst: isSupervisor || groups.includes(config.analystGroup) };
}
