/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, Meter, Spinner, Via } from '../components/ui';
import { humanize, pct, usd } from '../format';
import type { Me } from '../App';
import { AnalysisPanel } from './AnalysisPanel';

type ViaRow = { server: string; tool: string; ok: boolean; latencyMs: number };
type Detail = Record<'claim' | 'coverage' | 'estimate' | 'status' | 'damage' | 'severity', any> & { via: ViaRow[] };

export function ClaimView({ claimId, me, back }: { claimId: string; me: Me; back: () => void }) {
  const [d, setD] = useState<Detail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setD(undefined);
    api.get<Detail>(`/api/claims/${claimId}`).then(setD, (e) => setError(e.message));
  }, [claimId]);

  const via = (tool: string) => {
    const v = d?.via.find((x) => x.tool === tool);
    return v ? <Via server={v.server} tool={v.tool} latencyMs={v.latencyMs} /> : null;
  };

  if (error) return <div className="page"><div className="alert bad">{error}</div></div>;
  if (!d)
    return (
      <div className="page">
        <div className="loading"><Spinner /> Assembling the claim file from both MCP servers…</div>
      </div>
    );

  const c = d.claim.claim;
  const cov = d.coverage.coverage_check;
  const policy = d.coverage.policy;
  const est = d.estimate.estimate;
  const a = d.damage.assessment;
  const sev = d.severity;

  return (
    <div className="page claim-page">
      <div className="page-head">
        <div>
          <button className="link back" onClick={back}>← Work queue</button>
          <h1>
            {c.claim_id} <span className="muted thin">· {c.insured} · {c.vehicle_label}</span>
          </h1>
          <p className="muted">
            {c.status} · {humanize(c.loss_type)} loss on {c.loss_date} · adjuster {c.assigned_adjuster}
          </p>
        </div>
      </div>

      <div className="claim-grid">
        <div className="claim-file">
          <Card title="Incident" aside={via('get_claim')}>
            <p>{c.narrative}</p>
            <div className="untrusted">
              <div className="untrusted-label">Claimant statement · customer-supplied text (untrusted)</div>
              <p>“{c.claimant_statement}”</p>
            </div>
            <dl className="facts">
              <dt>Location</dt><dd>{c.loss_location}</dd>
              <dt>Driver</dt><dd>{c.driver_at_loss.name} ({humanize(c.driver_at_loss.relationship)})</dd>
              <dt>Police report</dt><dd>{c.police_report ? `${c.police_report.number}: ${c.police_report.summary}` : 'None'}</dd>
              <dt>Injuries</dt><dd>{c.injuries_reported ? (c.injuries ?? []).map((i: any) => `${i.person}: ${i.description}`).join('; ') || 'Reported' : 'None reported'}</dd>
              {c.third_parties.map((t: any, i: number) => (
                <FragmentRow key={i} k={humanize(t.role)} v={`${t.name}${t.vehicle ? ` · ${t.vehicle}` : ''}${t.carrier ? ` · ${t.carrier}` : ''}`} />
              ))}
              <dt>Repair facility</dt><dd>{c.repair_facility.name}{c.repair_facility.drp_partner && ' · DRP partner'}</dd>
            </dl>
          </Card>

          <Card
            title="Policy & coverage"
            aside={via('get_policy_coverage')}
          >
            <div className="verdict-row">
              <Badge tone={cov.first_party_verdict === 'COVERED' ? 'good' : 'bad'}>{cov.first_party_verdict.replace('_', ' ')}</Badge>
              <span>
                {humanize(cov.applicable_coverage)} · deductible {usd(cov.deductible)} · policy {policy.policy_number} ({policy.effective_date} → {policy.expiration_date})
              </span>
            </div>
            {cov.reasons_not_covered.map((r: string) => <div key={r} className="alert bad small">{r}</div>)}
            {cov.flags.map((f: string) => <div key={f} className="alert warn small">{f}</div>)}
            <dl className="facts">
              <dt>Driver status</dt><dd>{cov.driver_at_loss}: {humanize(cov.driver_status)}</dd>
              <dt>Rental</dt><dd>{cov.rental_reimbursement.available ? `${usd(cov.rental_reimbursement.daily_limit)}/day, max ${usd(cov.rental_reimbursement.max_total)}` : 'Not available'}</dd>
              <dt>Third-party liability</dt><dd>{humanize(cov.third_party_liability.verdict)} — {cov.third_party_liability.explanation}</dd>
              <dt>Endorsements</dt><dd>{policy.endorsements.join('; ') || 'None'}</dd>
            </dl>
          </Card>

          <Card title="Damage assessment (simulated)" aside={via('get_damage_assessment')}>
            <div className="verdict-row">
              <Badge tone={a.overall_severity === 'severe' ? 'bad' : a.overall_severity === 'moderate' ? 'warn' : 'good'}>{a.overall_severity}</Badge>
              <span>
                {a.photos_analyzed} photos · impact {a.impact_point} · model confidence {pct(a.confidence)}
              </span>
            </div>
            <div className="table-wrap">
            <table className="mini">
              <thead><tr><th>Part</th><th>Damage</th><th>Severity</th><th className="num">Conf.</th></tr></thead>
              <tbody>
                {a.damage_areas.map((x: any) => (
                  <tr key={x.part}>
                    <td>{x.part}</td>
                    <td className="muted">{x.damage_type}</td>
                    <td><Meter value={x.severity} /></td>
                    <td className="num">{pct(x.confidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="tags">
              {a.structural_damage && <Badge tone="bad">Structural</Badge>}
              {a.airbags_deployed && <Badge tone="bad">Airbag deployed</Badge>}
              <Badge tone={a.drivable ? 'good' : 'bad'}>{a.drivable ? 'Drivable' : 'Not drivable'}</Badge>
              {a.safety_systems_affected.map((s: string) => <Badge key={s} tone="warn">{s}</Badge>)}
            </div>
            {a.pre_existing_damage_indicators.length > 0 && (
              <ul className="indicators">{a.pre_existing_damage_indicators.map((p: string) => <li key={p}>{p}</li>)}</ul>
            )}
          </Card>

          <Card title="Severity & total-loss indicators" aside={via('get_severity_indicators')}>
            <div className="tl-meter">
              <div>
                <div className="big">{pct(sev.repair_cost_to_acv_ratio)}</div>
                <div className="muted small">projected repair {usd(sev.projected_repair_cost.total)} / ACV {usd(sev.actual_cash_value)}</div>
              </div>
              <div className="tl-bar">
                <Meter value={Math.min(sev.repair_cost_to_acv_ratio, 1.2)} max={1.2} tone={sev.total_loss_indicated ? 'bad' : sev.repair_cost_to_acv_ratio > 0.6 ? 'warn' : 'good'} />
                <span className="tl-threshold" style={{ left: `${(sev.total_loss_threshold_ratio / 1.2) * 100}%` }}>
                  {pct(sev.total_loss_threshold_ratio)} threshold
                </span>
              </div>
            </div>
            <div className="tags">
              {sev.indicator_flags.map((f: string) => <Badge key={f} tone={f.includes('TOTAL') || f.includes('CONSISTENCY') ? 'bad' : 'warn'}>{humanize(f.toLowerCase())}</Badge>)}
              <Badge tone="info">~{sev.estimated_repair_days} repair days</Badge>
            </div>
          </Card>

          {est && (
            <Card title={`Shop estimate ${est.estimate_id}`} aside={via('get_repair_estimate')}>
              <p className="muted small">{est.shop} · written {est.written_date} · {est.parts_type} parts{est.note && ` · ${est.note}`}</p>
              <div className="table-wrap">
                <table className="mini">
                  <thead><tr><th>Line</th><th>Op code</th><th>Description</th><th className="num">Hours</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {est.lines.map((l: any) => (
                      <tr key={l.line_id}>
                        <td>{l.line_id}</td>
                        <td><code>{l.op_code}</code></td>
                        <td>{l.description}</td>
                        <td className="num">{l.labor_hours || '—'}</td>
                        <td className="num">{usd(l.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={4}>Tax</td><td className="num">{usd(est.totals.tax)}</td></tr>
                    <tr className="strong"><td colSpan={4}>Grand total</td><td className="num">{usd(est.totals.grand_total)}</td></tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          )}

          <Card title="Status & history" aside={via('get_claim_status')}>
            <dl className="facts">
              <dt>Reserves</dt><dd>{usd(d.status.total_reserves)} ({Object.entries(d.status.reserves).map(([k, v]) => `${humanize(k)} ${usd(v as number)}`).join(', ')})</dd>
              <dt>Paid to date</dt><dd>{usd(d.status.payments_to_date)}</dd>
              <dt>Prior losses</dt><dd>{d.status.prior_losses_found ? d.status.prior_losses.map((p: any) => `${p.date} ${p.carrier}: ${p.damage_area} (${p.disposition})`).join('; ') : 'None found'}</dd>
            </dl>
            <ol className="timeline">
              {d.status.events.map((e: any, i: number) => <li key={i}><span className="muted">{e.date}</span> {e.event}</li>)}
            </ol>
          </Card>
        </div>

        <AnalysisPanel claimId={claimId} me={me} />
      </div>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
