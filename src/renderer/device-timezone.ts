/**
 * This device's zone as an IANA name (the host accepts nothing else). A device set to a bare offset reports it as
 * "+00:00" (Chrome 124 on an Android set to GMT): a whole-hour offset becomes its Etc zone, anything else UTC.
 */
export function deviceTimezone(): string {
  let zone: string | undefined;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(zone ?? '');
  if (!offset) return zone || 'UTC';
  const hours = Number(offset[2]);
  if (offset[3] !== '00' || hours === 0) return 'UTC';
  // Etc zones count the other way: UTC+9 is Etc/GMT-9.
  return `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`;
}
