import assert from "node:assert/strict";
import { it } from "node:test";
import { reportRangeInTimeZone, reportRangeBoundInTimeZone } from "@starter/shared";
it("matches the existing server numeric Date constructor across timezone, DST and skipped/repeated-midnight boundaries", () => {
 const previous = process.env.TZ;
 try {
  for (const zone of ["UTC", "Europe/Berlin", "Australia/Sydney", "America/New_York", "America/Havana", "America/Sao_Paulo", "Pacific/Apia"]) {
   process.env.TZ = zone;
   for (const date of ["2026-03-29", "2026-10-25", "2026-10-04", "2015-03-08", "2018-11-04", "2011-12-29", "2011-12-30", "2011-12-31"]) {
    const [y, m, d] = date.split("-").map(Number), from = new Date(y!, m! - 1, d!), to = new Date(y!, m! - 1, d! + 1);
    if (to.getTime() <= from.getTime()) { assert.throws(() => reportRangeInTimeZone({ from: date, to: date }, zone), /after/); continue; }
    const actual = reportRangeInTimeZone({ from: date, to: date }, zone); assert.equal(actual.fromMs, from.getTime(), `${zone} ${date} start`); assert.equal(actual.toMs, to.getTime(), `${zone} ${date} end`);
   }
  }
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
it("keeps explicit timestamp bounds independent of device/calendar clocks and refuses invalid or inverted ranges", () => {
 const input = { from: "2026-03-28T23:00:00.000Z", to: "2026-03-29T22:00:00.000Z" };
 for (const zone of ["UTC", "Australia/Sydney", "Europe/Berlin"]) assert.equal(reportRangeInTimeZone(input, zone).toMs - reportRangeInTimeZone(input, zone).fromMs, 23 * 3600000);
 assert.throws(() => reportRangeInTimeZone(input, "not/a-zone")); assert.throws(() => reportRangeInTimeZone({ from: "invalid", to: input.to }, "UTC")); assert.throws(() => reportRangeInTimeZone({ from: input.to, to: input.from }, "UTC"));
});

it("resolves weekly start bounds even for skipped dates and midnight DST gaps", () => {
 const previous = process.env.TZ;
 try {
  for (const [zone, date] of [["Pacific/Apia", "2011-12-30"], ["America/Havana", "2015-03-08"], ["America/Sao_Paulo", "2018-11-04"]]) {
   process.env.TZ = zone; const [year, month, day] = date!.split("-").map(Number);
   assert.equal(reportRangeBoundInTimeZone(date!, false, zone!), new Date(year!, month! - 1, day!).getTime());
  }
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
