function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateTimeLocal(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(
    date.getMonth() + 1,
  )}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
