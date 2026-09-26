/** 「後で送信」 presets and labels (M12d). Times are local; the server stores UTC. */

export interface SchedulePreset {
  key: string;
  label: string;
  at: Date;
}

function at(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Slack-like choices that are always in the future relative to `now`. */
export function schedulePresets(now = new Date()): SchedulePreset[] {
  const presets: SchedulePreset[] = [];
  const inOneHour = new Date(now.getTime() + 60 * 60_000);
  inOneHour.setSeconds(0, 0);
  presets.push({ key: "1h", label: "1 時間後", at: inOneHour });
  const today18 = at(now, 0, 18);
  if (today18.getTime() > now.getTime() + 5 * 60_000) presets.push({ key: "today18", label: "今日 18:00", at: today18 });
  presets.push({ key: "tomorrow9", label: "明日 9:00", at: at(now, 1, 9) });
  const toMonday = (8 - now.getDay()) % 7 || 7; // next Monday, never today
  presets.push({ key: "monday9", label: "来週月曜 9:00", at: at(now, toMonday, 9) });
  return presets;
}

/** 「リマインド」 choices (M12e): a little later, or a fresh morning. */
export function reminderPresets(now = new Date()): SchedulePreset[] {
  const soon = (minutes: number) => {
    const d = new Date(now.getTime() + minutes * 60_000);
    d.setSeconds(0, 0);
    return d;
  };
  const presets: SchedulePreset[] = [
    { key: "20m", label: "20 分後", at: soon(20) },
    { key: "1h", label: "1 時間後", at: soon(60) },
    { key: "3h", label: "3 時間後", at: soon(180) },
    { key: "tomorrow9", label: "明日 9:00", at: at(now, 1, 9) },
  ];
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ key: "monday9", label: "来週月曜 9:00", at: at(now, toMonday, 9) });
  return presets;
}

const DAY = ["日", "月", "火", "水", "木", "金", "土"];

/** "今日 18:00" / "明日 9:00" / "10月3日(土) 9:00" / "2027年1月4日(月) 9:00". */
export function scheduleLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((d.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days === 0) return `今日 ${time}`;
  if (days === 1) return `明日 ${time}`;
  const year = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}年` : "";
  return `${year}${d.getMonth() + 1}月${d.getDate()}日(${DAY[d.getDay()]}) ${time}`;
}

/** The value for an <input type="datetime-local">, in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
