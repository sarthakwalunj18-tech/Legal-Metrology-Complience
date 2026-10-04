"use client";

/**
 * Notification bell and inbox.
 *
 * Replaces the placeholder button that had no feed behind it. Polls the unread
 * count rather than streaming, and only while the tab is visible, so an idle
 * dashboard is not holding a connection open.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, ExternalLink, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/session";

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPayload {
  notifications: NotificationRow[];
  unread: number;
  count: number;
}

/** Badge is unread beyond 9, so the dot never widens the top bar. */
const badgeLabel = (unread: number) => (unread > 9 ? "9+" : String(unread));

const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

const POLL_MS = 60_000;

export function NotificationBell() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await apiFetch<NotificationPayload>("/notifications?limit=20");
      setRows(payload.notifications ?? []);
      setUnread(payload.unread ?? 0);
      setError(null);
    } catch {
      // A failed poll must not nag the officer; the badge simply stays as it was.
      setError("Notifications are unavailable right now.");
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openPanel = async () => {
    const next = !open;
    setOpen(next);
    if (!next || rows.length > 0) return;

    setLoading(true);
    await load();
    setLoading(false);
  };

  const markRead = async (row: NotificationRow) => {
    if (!row.readAt) {
      // Optimistic: the badge should respond immediately, and a failure just
      // leaves it unread until the next poll.
      setUnread((current) => Math.max(0, current - 1));
      setRows((current) =>
        current.map((item) => (item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item)),
      );
      void apiFetch(`/notifications/${encodeURIComponent(row.id)}/read`, { method: "PATCH" }).catch(
        () => void load(),
      );
    }

    if (row.href) {
      setOpen(false);
      router.push(row.href);
    }
  };

  const markAllRead = () => {
    const unreadRows = rows.filter((row) => !row.readAt);
    setUnread(0);
    setRows((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    for (const row of unreadRows) {
      void apiFetch(`/notifications/${encodeURIComponent(row.id)}/read`, { method: "PATCH" }).catch(
        () => void load(),
      );
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => void openPanel()}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors relative"
        title="Notifications"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Bell className="w-4 h-4" />
        )}
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-blue-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {badgeLabel(unread)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-[380px] max-w-[92vw] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-50">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-900">Notifications</h3>
            {unread > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline"
              >
                <Check className="w-3 h-3" />
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-xs text-slate-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading your inbox…
              </div>
            ) : error && rows.length === 0 ? (
              <p className="px-4 py-6 text-xs text-slate-500 text-center">{error}</p>
            ) : rows.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell className="w-5 h-5 text-slate-300 mx-auto mb-2" />
                <p className="text-xs font-semibold text-slate-700">Nothing needs your attention</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Review requests and non-compliances raised on your inspections appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => void markRead(row)}
                      className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                        row.readAt ? "" : "bg-blue-50/40"
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                            row.readAt ? "bg-transparent" : "bg-blue-600"
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-slate-800 leading-snug">
                            {row.title}
                          </p>
                          {row.body ? (
                            <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                              {row.body}
                            </p>
                          ) : null}
                          <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                            {relativeTime(row.createdAt)}
                            {row.href ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                                <span>open</span>
                              </>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}