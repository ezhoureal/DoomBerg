import { ageLabel, refreshSuggested } from "../ui/workspace";

export default function Freshness({
  refreshedAt,
  needsRefresh,
  now,
}: {
  refreshedAt: string;
  needsRefresh: boolean;
  now: number;
}) {
  return (
    <span
      className={`freshness ${needsRefresh || refreshSuggested(refreshedAt, now) ? "needs-refresh" : ""}`}
      title={`Analysis completed ${new Date(refreshedAt).toLocaleString()}. This is snapshot age, not proof that every oracle or data source is current. Refresh is suggested after five minutes; this is a UI reminder, not a risk threshold.`}
    >
      Snapshot · {ageLabel(refreshedAt, now)}
      {needsRefresh
        ? " · refresh required"
        : refreshSuggested(refreshedAt, now)
          ? " · refresh suggested"
          : ""}
    </span>
  );
}
