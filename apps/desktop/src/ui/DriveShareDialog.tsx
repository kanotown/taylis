/**
 * 「共有リンク」 (M163, docs/DRIVE.md §17.4): external links to a drive file or folder.
 *
 * The item's dialog makes a link (expiry: 1 / 7 / 30 / 90 days, a date, or none when the workspace allows it; an
 * optional password, required when the workspace says so; an optional download limit; who it is for) and shows its
 * address once, to copy: the server keeps only its hash, so a link cannot be shown again (§19 Q4) — the dialog says
 * so. Below: the item's links that are not revoked (mine; all of them for those who manage the location's links) with
 * their state, expiry, downloads and last use, how each was used, and 「取り消す」. When the workspace or the location
 * turned links off, the dialog says only that.
 *
 * MyLinksDialog (the drive's 「共有リンク」 in the locations column) lists every link I made, wherever it is.
 */
import { Check, Copy, History, KeyRound, Link2, Loader2, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { DriveItemLinksOut, DriveItemOut, DriveShareEventOut, DriveShareLinkCreatedOut, DriveShareLinkOut } from "../api/types";
import { originalsDefault } from "../drive/albums";
import { blockedReason, choiceKey, choiceLabel, defaultChoice, downloadsLabel, type ExpiryChoice, expiresAt, expiryChoices, formProblem, localDay, maxDate, shareUrl, stateLabel } from "../drive/shares";
import type { AppController } from "../state/app";
import { sinceLabel } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";

const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm text-ink";

/** The small sign of an item shared outside (the listing, the details pane). */
export function SharedMark({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span data-drive-shared={count} title={t("drive.share.sharedCount", { count })} aria-label={t("drive.share.sharedCount", { count })} className={cn("inline-flex shrink-0 items-center text-accent", className)}>
      <Link2 size={13} />
    </span>
  );
}

export function ShareLinksDialog({ controller, item, onClose, onChanged }: {
  controller: AppController;
  item: DriveItemOut;
  onClose: () => void;
  /** A link was made or revoked: the listing reads the folder again (its sign). */
  onChanged: () => void;
}) {
  const [data, setData] = useState<DriveItemLinksOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DriveShareLinkCreatedOut | null>(null);

  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      setData(await api.driveItemLinks(item.id));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api, item.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const blocked = data ? blockedReason(data.policy) : null;
  return (
    <Modal onClose={onClose} title={t("drive.share.title", { name: item.name })} description={t("drive.share.description")} growsDown className="w-[600px]">
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {data === null && !error ? (
        <div className="flex justify-center py-8 text-muted"><Loader2 size={18} className="animate-spin" /></div>
      ) : data ? (
        <>
          {created ? (
            <CreatedLink controller={controller} created={created} onAnother={() => setCreated(null)} />
          ) : blocked ? (
            <p data-share-blocked="" className="mt-4 flex items-start gap-2 rounded-xl border border-line px-3 py-2.5 text-sm text-muted">
              <ShieldOff size={16} className="mt-0.5 shrink-0" /> {blocked}
            </p>
          ) : (
            <NewLinkForm
              controller={controller}
              item={item}
              policy={data.policy}
              onCreated={(made) => {
                setCreated(made);
                onChanged();
                void load();
              }}
            />
          )}
          <LinkList
            controller={controller}
            links={data.links}
            title={t("drive.share.existing", { count: data.links.length })}
            onRevoked={() => {
              onChanged();
              void load();
            }}
            originalsToggle={item.kind === "folder" && !!item.album}
            onUpdated={() => void load()}
          />
        </>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}

function NewLinkForm({ controller, item, policy, onCreated }: {
  controller: AppController;
  item: DriveItemOut;
  policy: DriveItemLinksOut["policy"];
  onCreated: (created: DriveShareLinkCreatedOut) => void;
}) {
  const choices = expiryChoices(policy);
  const [choice, setChoice] = useState<ExpiryChoice>(() => defaultChoice(policy));
  const [date, setDate] = useState(() => localDay(new Date(Date.now() + policy.default_days * 86_400_000)));
  const [usePassword, setUsePassword] = useState(policy.password_required);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [limit, setLimit] = useState("");
  const [note, setNote] = useState("");
  // AL2 (docs/ALBUMS.md §7): an album's link hands out the display sizes only unless this is ticked.
  const album = item.kind === "folder" && !!item.album;
  const [originals, setOriginals] = useState(() => originalsDefault(item));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    const expiry = expiresAt(choice, date, policy);
    const wrong = formProblem({ usePassword, password, limit, note }, policy, expiry);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.createDriveLink(item.id, {
        expires_at: expiry ?? null,
        ...(usePassword || policy.password_required ? { password } : {}),
        ...(limit.trim() ? { max_downloads: Number(limit.trim()) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(album ? { originals } : {}),
      });
      onCreated(made);
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form data-share-form="" className="mt-4 space-y-3 rounded-xl border border-line p-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <strong className="block text-sm">{t("drive.share.newLink")}</strong>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("drive.share.expiry")}>
          <select aria-label={t("drive.share.expiry")} className={SELECT} value={choiceKey(choice)} onChange={(event) => setChoice(choices.find((c) => choiceKey(c) === event.target.value) ?? choice)}>
            {choices.map((c) => <option key={choiceKey(c)} value={choiceKey(c)}>{choiceLabel(c)}</option>)}
          </select>
        </Field>
        {choice.kind === "date" ? (
          <Field label={t("drive.share.expiryDate")}>
            <Input type="date" aria-label={t("drive.share.expiryDate")} value={date} min={localDay(new Date(Date.now() + 86_400_000))} max={maxDate(policy) || undefined} onChange={(event) => setDate(event.target.value)} />
          </Field>
        ) : (
          <Field label={t("drive.share.limit")} hint={t("drive.share.limitHint")}>
            <Input inputMode="numeric" aria-label={t("drive.share.limit")} placeholder={t("drive.share.noLimit")} value={limit} onChange={(event) => setLimit(event.target.value)} />
          </Field>
        )}
      </div>
      {choice.kind === "date" && (
        <Field label={t("drive.share.limit")} hint={t("drive.share.limitHint")}>
          <Input inputMode="numeric" aria-label={t("drive.share.limit")} placeholder={t("drive.share.noLimit")} value={limit} onChange={(event) => setLimit(event.target.value)} />
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={usePassword || policy.password_required} disabled={policy.password_required} onChange={(event) => setUsePassword(event.target.checked)} />
        {t("drive.share.usePassword")}
        {policy.password_required && <span className="text-xs text-muted">{t("drive.share.passwordRequired")}</span>}
      </label>
      {(usePassword || policy.password_required) && (
        <div className="flex items-center gap-2">
          <Input type={showPassword ? "text" : "password"} autoComplete="new-password" aria-label={t("drive.share.password")} placeholder={t("drive.share.passwordPlaceholder")} value={password} onChange={(event) => setPassword(event.target.value)} className="flex-1" />
          <Button type="button" size="sm" variant="ghost" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? t("drive.share.hidePassword") : t("drive.share.showPassword")}</Button>
        </div>
      )}
      {album && (
        <label data-share-originals="" className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={originals} onChange={(event) => setOriginals(event.target.checked)} />
          <span>
            {t("albums.share.originals")}
            <span className="block text-xs text-muted">{originals ? t("albums.share.originalsOn") : t("albums.share.originalsOff")}</span>
          </span>
        </label>
      )}
      <Field label={t("drive.share.note")}>
        <Input maxLength={80} aria-label={t("drive.share.note")} placeholder={t("drive.share.notePlaceholder")} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{item.kind === "folder" ? t("drive.share.folderHint") : t("drive.share.fileHint")}</p>
        <Button type="submit" disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} {t("drive.share.create")}</Button>
      </div>
    </form>
  );
}

function CreatedLink({ controller, created, onAnother }: { controller: AppController; created: DriveShareLinkCreatedOut; onAnother: () => void }) {
  const url = shareUrl(controller.api?.baseUrl ?? "", created.url);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await controller.copyToClipboard(url, t("drive.share.copied"))) setCopied(true);
  };
  return (
    <section data-share-created="" aria-label={t("drive.share.createdTitle")} className="mt-4 space-y-2 rounded-xl border border-line p-3">
      <strong className="block text-sm">{t("drive.share.createdTitle")}</strong>
      <div className="flex items-center gap-2">
        <Input readOnly value={url} aria-label={t("drive.share.url")} onFocus={(event) => event.currentTarget.select()} className="flex-1 font-mono text-[12.5px]" />
        <Button onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("drive.share.copiedShort") : t("drive.share.copy")}</Button>
      </div>
      <p className="text-xs text-muted">{t("drive.share.onlyNow")}</p>
      {created.link.has_password && <p className="text-xs text-muted">{t("drive.share.sendPasswordApart")}</p>}
      <Button size="sm" variant="ghost" onClick={onAnother}>{t("drive.share.another")}</Button>
    </section>
  );
}

export function LinkList({ controller, links, title, showItem = false, onRevoked, revoke, originalsToggle = false, onUpdated }: {
  controller: AppController;
  links: DriveShareLinkOut[];
  title: string;
  /** The item's and the location's names (lists of links of many items). */
  showItem?: boolean;
  onRevoked: (link: DriveShareLinkOut) => void;
  /** How to revoke (the administrators' route); the creator's / manager's by default. */
  revoke?: (link: DriveShareLinkOut) => Promise<void>;
  /** AL2: an album's links offer 「元の写真を許す」 / 「表示サイズだけにする」 (who may edit the link). */
  originalsToggle?: boolean;
  onUpdated?: () => void;
}) {
  const [confirm, setConfirm] = useState<DriveShareLinkOut | null>(null);
  const [events, setEvents] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggleOriginals = async (link: DriveShareLinkOut) => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    try {
      const changed = await api.updateDriveLink(link.id, { originals: link.originals === false });
      controller.setNotice(changed.originals ? t("albums.share.originalsAllowed") : t("albums.share.displayOnlyNow"));
      onUpdated?.();
    } catch (failure) {
      controller.setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const me = controller.store.me?.id;
  const doRevoke = async (link: DriveShareLinkOut) => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    try {
      if (revoke) await revoke(link);
      else await api.revokeDriveLink(link.id);
      controller.setNotice(t("drive.share.revoked"));
      setConfirm(null);
      onRevoked(link);
    } catch (failure) {
      controller.setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={title} className="mt-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {links.length === 0 ? (
        <p className="text-sm text-muted">{t("drive.share.none")}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {links.map((link) => (
            <li key={link.id} data-share-link={link.state} className="px-3 py-2 text-[13px]">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="truncate font-semibold">{showItem ? link.item_name : link.note || t("drive.share.untitled")}</strong>
                    {link.state !== "active" && <Badge tone={link.state === "paused" ? "neutral" : "danger"}>{stateLabel(link.state)}</Badge>}
                    {link.has_password && <KeyRound size={12} className="text-muted" aria-label={t("drive.share.hasPassword")} />}
                    {link.originals === false && <span data-share-display-only="" className="rounded-full bg-panel-2 px-1.5 text-[11px] text-muted">{t("albums.share.displayOnly")}</span>}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted">
                    {[
                      showItem ? link.location_name : null,
                      showItem && link.note ? link.note : null,
                      link.expires_at ? t("drive.share.until", { at: sinceLabel(link.expires_at) }) : t("drive.share.noExpiry"),
                      downloadsLabel(link),
                      link.last_used_at ? t("drive.share.lastUsed", { at: sinceLabel(link.last_used_at) }) : t("drive.share.neverUsed"),
                      link.created_by !== me ? t("drive.share.by", { name: link.created_by_name }) : null,
                    ].filter(Boolean).join(" · ")}
                  </div>
                  {link.state === "paused" && <p className="mt-0.5 text-[11.5px] text-muted">{t("drive.share.pausedHint")}</p>}
                </div>
                {(link.created_by === me || controller.can("drive.admin")) && (
                  <Button size="sm" variant="ghost" aria-expanded={events === link.id} onClick={() => setEvents((open) => (open === link.id ? null : link.id))}><History size={13} /> {t("drive.share.events")}</Button>
                )}
                {originalsToggle && link.can_edit && link.state !== "revoked" && (
                  // AL2 (docs/ALBUMS.md §7): PATCH /drive/links/{id} {originals}.
                  <Button size="sm" variant="ghost" data-share-toggle-originals="" disabled={busy} onClick={() => void toggleOriginals(link)}>
                    {link.originals === false ? t("albums.share.allowOriginals") : t("albums.share.onlyDisplay")}
                  </Button>
                )}
                {link.can_revoke && <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm(link)}>{t("drive.share.revoke")}</Button>}
              </div>
              {events === link.id && <EventList controller={controller} linkId={link.id} />}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} title={t("drive.share.revokeTitle")} description={t("drive.share.revokeText", { name: confirm.item_name })}>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void doRevoke(confirm)}>{t("drive.share.revoke")}</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function eventLabel(event: DriveShareEventOut): string {
  return t(`drive.share.event.${event.kind}` as const);
}

function EventList({ controller, linkId }: { controller: AppController; linkId: string }) {
  const [rows, setRows] = useState<DriveShareEventOut[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (after: string | null) => {
    const api = controller.api;
    if (!api) return;
    try {
      const page = await api.driveLinkEvents(linkId, after);
      setRows((held) => [...(after ? held ?? [] : []), ...page.events]);
      setCursor(page.next_cursor ?? null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api, linkId]);
  useEffect(() => {
    void load(null);
  }, [load]);
  if (error) return <p role="alert" className="mt-2 text-xs text-danger">{error}</p>;
  if (rows === null) return <div className="mt-2 text-muted"><Loader2 size={14} className="animate-spin" /></div>;
  if (rows.length === 0) return <p className="mt-2 text-xs text-muted">{t("drive.share.noEvents")}</p>;
  return (
    <div className="mt-2">
      <ul data-share-events="" className="space-y-0.5 text-[11.5px] text-muted">
        {rows.map((row) => (
          <li key={row.id} className="flex gap-2">
            <span className="w-28 shrink-0 tabular-nums">{sinceLabel(row.created_at)}</span>
            <span className={cn("w-28 shrink-0", row.kind === "password_failed" || row.kind === "refused" ? "text-danger" : "text-ink")}>{eventLabel(row)}</span>
            <span className="min-w-0 flex-1 truncate" title={row.user_agent ?? undefined}>{[row.item_name, row.ip, row.user_agent].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
      {cursor && <Button size="sm" variant="ghost" onClick={() => void load(cursor)}>{t("drive.share.moreEvents")}</Button>}
      <p className="mt-1 text-[11px] text-muted">{t("drive.share.eventsHint")}</p>
    </div>
  );
}

/** Every link I made that is not revoked (the drive's 「共有リンク」). */
export function MyLinksDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const [links, setLinks] = useState<DriveShareLinkOut[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (after: string | null) => {
    const api = controller.api;
    if (!api) return;
    try {
      const page = await api.myDriveLinks(after);
      setLinks((held) => [...(after ? held ?? [] : []), ...page.links]);
      setCursor(page.next_cursor ?? null);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api]);
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <Modal onClose={onClose} title={t("drive.share.mine")} description={t("drive.share.mineDescription")} growsDown className="w-[640px]">
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {links === null && !error ? (
        <div className="flex justify-center py-8 text-muted"><Loader2 size={18} className="animate-spin" /></div>
      ) : (
        <LinkList controller={controller} links={links ?? []} showItem title={t("drive.share.existing", { count: (links ?? []).length })} onRevoked={(gone) => setLinks((held) => (held ?? []).filter((link) => link.id !== gone.id))} />
      )}
      {cursor && <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load(cursor)}>{t("drive.share.moreLinks")}</Button>}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
