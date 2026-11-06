import { MESSAGES } from "../lib/messages";
import type { ComparisonRow } from "../lib/report-compare";

// The participant's own rating beside the evaluator's level. Every cell is a React text node.

export function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="report-compare">
      <h2 className="s" id="report-compare">{MESSAGES.compareHeading}</h2>
      <table className="compare">
        <caption className="muted">{MESSAGES.compareCaption}</caption>
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Evaluator&apos;s level</th>
            <th scope="col">Your rating</th>
            <th scope="col">Your note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.criterion}</th>
              <td>{r.evaluator}</td>
              <td>{r.yours}</td>
              <td>{r.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
