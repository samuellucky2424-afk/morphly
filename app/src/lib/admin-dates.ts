const dateFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatAdminDate(value: unknown, formatter: Intl.DateTimeFormat, missing: string) {
  if (value == null || value === '') return missing;
  if (typeof value !== 'string') return 'Unknown';

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : 'Unknown';
}

export function formatDate(value: unknown) {
  return formatAdminDate(value, dateFormatter, 'Unknown');
}

export function formatDateTime(value: unknown) {
  return formatAdminDate(value, dateTimeFormatter, 'Never');
}
