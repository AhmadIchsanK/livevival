// Single shared formatter for every match date/time shown across the site
// (home page, /matches, match page, admin matches list, tournament page) —
// one function so the format can't drift between call sites again.
//
// Renders as "YYYY MMMM DD, HH:MM AM/PM", e.g. "2026 August 04, 02:30 PM".
// Always rendered in the viewer's local timezone (matches every other
// date/time already shown on the site, which all use the browser's local
// time via toLocaleString/toLocaleTimeString).

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatMatchDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const year = d.getFullYear();
  const month = MONTH_NAMES[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${year} ${month} ${day}, ${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
}
