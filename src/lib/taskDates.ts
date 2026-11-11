/**
 * Conversions between a task's stored `due_at` (an ISO instant) and
 * the `YYYY-MM-DD` value of an `<input type="date">` (#34).
 *
 * A due date is a calendar day in the viewer's time zone. It is stored
 * as local noon of that day, so a few hours of later time-zone travel
 * cannot move it to the neighboring day, and the sidebar's local "due
 * today" test reads it as the day the user picked.
 */

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → ISO instant at local noon, or `undefined` for blank/invalid. */
export function dateInputToIso(value: string): string | undefined {
  const m = DATE_INPUT.exec(value.trim());
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 12, 0, 0, 0);
  // Reject roll-overs such as 2026-02-31.
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d
  ) {
    return undefined;
  }
  return date.toISOString();
}

/** ISO instant → the local `YYYY-MM-DD` it falls on, or `""`. */
export function isoToDateInput(iso: string | undefined): string {
  if (iso === undefined) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short local label for a due date, e.g. "Oct 23". */
export function formatDueDate(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
