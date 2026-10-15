// Everything Class Insights returns passes through redact(): design and deployment details are open to students,
// credentials are not. (The apps never log secrets; this is defense in depth.)
const PATTERNS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED-AWS-ACCESS-KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED-JWT]'],
  [/("?(?:password|secret|secretAccessKey|sessionToken|aws_secret_access_key|x-auth-token|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"[REDACTED]"'],
  [/(X-Amz-Security-Token|X-Amz-Signature|X-Amz-Credential)=[^&\s"]+/gi, '$1=[REDACTED]'],
];

export function redact<T>(value: T): T {
  if (typeof value === 'string') return PATTERNS.reduce<string>((s, [re, rep]) => s.replace(re, rep), value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(password|secret|token|authorization|x-auth-token)$/i.test(k) ? '[REDACTED]' : redact(v)])) as T;
  }
  return value;
}
