import { z } from "zod";
import { DomainError } from "./index";

export function localMidnight(date: string, timezone: string) {
  z.string().date().parse(date);
  const target = new Date(`${date}T00:00:00Z`).getTime();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instant = target;
  for (let n = 0; n < 3; n++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    instant += target - observed;
    if (observed === target) return new Date(instant);
  }
  throw new DomainError(
    "DATE",
    "This local date has no midnight in the configured timezone.",
    400,
  );
}
export function analyticsWindow(
  from: string | null,
  through: string | null,
  timezone: string,
) {
  const start = from ? localMidnight(from, timezone) : undefined;
  const end = through
    ? localMidnight(
        new Date(
          new Date(`${z.string().date().parse(through)}T00:00:00Z`).getTime() +
            86400000,
        )
          .toISOString()
          .slice(0, 10),
        timezone,
      )
    : undefined;
  if (start && end && start >= end)
    throw new DomainError(
      "DATE",
      "The end date must be on or after the start date.",
      400,
    );
  return { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
}
