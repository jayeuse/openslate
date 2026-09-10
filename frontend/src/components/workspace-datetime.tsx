"use client";
import { datetimeOffsets } from "@/lib/date-time";
export function DatetimeOffsetChoice({
  id,
  value,
  timezone,
  offset,
  onChange,
}: {
  id: string;
  value: string;
  timezone: string;
  offset: string;
  onChange: (value: string) => void;
}) {
  const offsets = datetimeOffsets(value, timezone);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="text-muted-foreground">Timezone: {timezone}</span>
      {offsets.length > 1 && (
        <label htmlFor={`${id}-offset`}>
          This time occurs twice. UTC offset
          <select
            id={`${id}-offset`}
            className="border-input bg-card ml-2 rounded border p-2"
            value={offset}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Choose offset</option>
            {offsets.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
