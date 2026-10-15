export const usd = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 });

export const pct = (n: number) => `${Math.round(n * 100)}%`;

export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const SERVER_LABEL: Record<string, string> = { claims_policy: 'Claims & Policy', damage_repair: 'Damage & Repair', knowledge_base: 'Claims Manual (KB)' };

export const DISPOSITION_LABEL: Record<string, string> = {
  APPROVE_REPAIR: 'Approve repair',
  APPROVE_REPAIR_WITH_ADJUSTMENTS: 'Approve repair with adjustments',
  FAST_TRACK_PAYMENT: 'Fast-track payment',
  TOTAL_LOSS_EVALUATION: 'Total loss evaluation',
  COVERAGE_REVIEW: 'Coverage review',
  DENY_FIRST_PARTY: 'Deny first-party coverage',
  SIU_REFERRAL: 'SIU referral',
  ESCALATE_INJURY: 'Escalate injury',
};

export const dispositionTone = (d?: string) =>
  d === 'APPROVE_REPAIR' || d === 'FAST_TRACK_PAYMENT'
    ? 'good'
    : d === 'APPROVE_REPAIR_WITH_ADJUSTMENTS' || d === 'TOTAL_LOSS_EVALUATION'
      ? 'warn'
      : 'bad';
