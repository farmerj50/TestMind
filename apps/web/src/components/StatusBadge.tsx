export default function StatusBadge({ status }: { status: "queued"|"running"|"succeeded"|"failed" }) {
  const map: Record<string, string> = {
    queued:   "bg-slate-100 text-slate-700",
    running:  "bg-blue-100 text-blue-800",
    succeeded:"bg-emerald-100 text-emerald-800",
    failed:   "bg-rose-100 text-rose-800",
  };
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${map[status]}`}>
      {status}
    </span>
  );
}
