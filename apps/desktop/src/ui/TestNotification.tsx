/**
 * 「テスト通知を送る」 in the settings' 「通知」 (PUSH_NOTIFICATIONS.md §15): this device shows its own notification at once,
 * the server pushes to my phones, and the list below says what happened on each device of mine.
 */
import { BellRing, CheckCircle2, CircleAlert, CircleMinus } from "lucide-react";
import { useState } from "react";

import { describeError } from "../api/errors";
import type { TestNotificationDevice, TestNotificationOut } from "../api/types";
import { isTauri } from "../platform/env";
import type { NotificationPermissionState } from "../platform/notify";
import type { AppController } from "../state/app";
import { Button, cn } from "./primitives";

const PLATFORM_NAMES: Record<string, string> = { ios: "iPhone / iPad", android: "Android", desktop: "デスクトップ", web: "ブラウザ" };

/** The device's name as its owner knows it, with 「(この端末)」 on the one that asked. */
export function testDeviceName(device: TestNotificationDevice): string {
  const name = device.device_name?.trim() || PLATFORM_NAMES[device.platform] || device.platform;
  return device.current ? `${name} (この端末)` : name;
}

/** sent / problem / neutral: the row's mark. */
export type TestTone = "ok" | "problem" | "none";

/** What happened on one device, in words (the same on iOS and Android). */
export function testDeviceStatus(device: TestNotificationDevice): { text: string; tone: TestTone } {
  switch (device.status) {
    case "sent":
      return { text: "送信しました", tone: "ok" };
    case "failed":
      return { text: device.detail ? `送れませんでした (${device.detail})` : "送れませんでした", tone: "problem" };
    case "no_token":
      return { text: "プッシュ未登録 (端末の通知がオフか、アプリをまだ開き直していません)", tone: "problem" };
    case "not_configured":
      return { text: device.push_provider === "fcm" ? "このサーバでは Android のプッシュが無効です" : "このサーバでは iOS のプッシュが無効です", tone: "problem" };
    case "in_app":
      return { text: "プッシュなし (アプリを開いていれば表示されます)", tone: "none" };
    case "disabled":
      return { text: device.detail === "session_expired" ? "ログインの期限切れ" : "ログアウト済み", tone: "none" };
    default:
      return { text: device.status, tone: "none" };
  }
}

/** Lines above the list: push off on this server, nothing that can take a push, DND. */
export function testNotificationNotes(out: TestNotificationOut): string[] {
  const notes: string[] = [];
  if (!out.apns_configured && !out.fcm_configured) notes.push("このサーバはプッシュ通知が設定されていません (iPhone・Android のアプリには、開いている間だけ通知が出ます)");
  else if (!out.apns_configured) notes.push("iOS のプッシュ (APNs) はこのサーバでは無効です");
  else if (!out.fcm_configured) notes.push("Android のプッシュ (FCM) はこのサーバでは無効です");
  const phones = out.devices.filter((d) => d.status !== "disabled" && (d.platform === "ios" || d.platform === "android"));
  if (phones.length === 0) notes.push("プッシュ通知を受け取れる端末 (iPhone・Android のアプリ) はありません");
  if (out.dnd_active) notes.push("通知を一時停止中ですが、テスト通知は送りました");
  return notes;
}

/** Where to turn the OS's notifications on for this app, when they are not on. */
export function permissionHint(permission: NotificationPermissionState | null, desktop: boolean = isTauri(), userAgent: string = navigator.userAgent): string | null {
  if (permission === null || permission === "granted") return null;
  if (!desktop) {
    if (permission === "unsupported") return "このブラウザは通知を出せません。デスクトップアプリかスマートフォンのアプリを使ってください";
    return permission === "denied" ? "ブラウザのサイト設定で通知を許可してください" : "上の「通知を許可」を押すと、このブラウザにも通知が出ます";
  }
  if (/Mac/i.test(userAgent)) return "macOS の「システム設定」→「通知」→「Taylis」で通知を許可してください";
  if (/Windows/i.test(userAgent)) return "Windows の「設定」→「システム」→「通知」で Taylis の通知をオンにしてください";
  return "OS の設定で Taylis の通知を許可してください";
}

const TONE_ICONS = {
  ok: <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />,
  problem: <CircleAlert size={16} className="shrink-0 text-danger" aria-hidden />,
  none: <CircleMinus size={16} className="shrink-0 text-muted" aria-hidden />,
} as const;

export function TestNotificationCard({ controller, permission }: { controller: AppController; permission: NotificationPermissionState | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestNotificationOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hint = permissionHint(permission);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await controller.sendTestNotification());
    } catch (err) {
      setResult(null);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" aria-label="テスト通知">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void send()}>
          <BellRing size={14} aria-hidden /> テスト通知を送る
        </Button>
        <span className="text-xs text-muted">この端末と、プッシュ通知を受け取れるスマートフォンに送ります</span>
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {result && (
        <div className="space-y-1.5" role="status">
          {testNotificationNotes(result).map((note) => (
            <p key={note} className="text-xs text-muted">{note}</p>
          ))}
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="端末ごとの結果">
            {result.devices.map((device) => {
              const status = testDeviceStatus(device);
              return (
                <li key={device.device_id} className="flex items-start gap-2 px-3 py-2 text-sm">
                  {TONE_ICONS[status.tone]}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{testDeviceName(device)}</span>
                    <span className={cn("block text-xs", status.tone === "problem" ? "text-danger" : "text-muted")}>{status.text}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
