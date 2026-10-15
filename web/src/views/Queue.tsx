import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Spinner, Via } from '../components/ui';
import { humanize, usd } from '../format';

interface ClaimRow {
  claim_id: string;
  insured: string;
  vehicle: string;
  loss_type: string;
  loss_cause: string;
  loss_date: string;
  status: string;
  priority: string;
  injuries_reported: boolean;
  shop_estimate_total: number | null;
  assigned_adjuster: string;
}

interface ClaimList {
  claims: ClaimRow[];
  as_of: string;
  via: { server: string; tool: string; latencyMs: number };
}

export function Queue({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<ClaimList>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.get<ClaimList>('/api/claims').then(setData, (e) => setError(e.message));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Work queue</h1>
          <p className="muted">Open auto physical-damage claims assigned to your team{data && <> · as of {data.as_of}</>}</p>
        </div>
        {data && <Via {...data.via} />}
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!data && !error && (
        <div className="loading">
          <Spinner /> Loading claims from the Claims &amp; Policy MCP server…
        </div>
      )}
      {data && (
        <div className="table-wrap">
          <table className="queue">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Insured</th>
                <th>Vehicle</th>
                <th>Loss</th>
                <th>Status</th>
                <th>Priority</th>
                <th className="num">Shop estimate</th>
                <th>Adjuster</th>
              </tr>
            </thead>
            <tbody>
              {data.claims.map((c) => (
                <tr key={c.claim_id} onClick={() => open(c.claim_id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(c.claim_id)}>
                  <td>
                    <span className="claim-id">{c.claim_id}</span>
                    {c.claim_id === 'CLM-24817' && <span className="demo-tag">demo</span>}
                  </td>
                  <td>{c.insured}</td>
                  <td>{c.vehicle}</td>
                  <td>
                    <div>{humanize(c.loss_type)}</div>
                    <div className="muted small">
                      {c.loss_date} · {humanize(c.loss_cause)}
                    </div>
                  </td>
                  <td>
                    <span className="status">{c.status}</span>
                    {c.injuries_reported && <Badge tone="bad">Injury</Badge>}
                  </td>
                  <td>
                    <Badge tone={c.priority === 'high' ? 'bad' : c.priority === 'normal' ? 'info' : 'neutral'}>{c.priority}</Badge>
                  </td>
                  <td className="num">{usd(c.shop_estimate_total)}</td>
                  <td className="muted">{c.assigned_adjuster}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
