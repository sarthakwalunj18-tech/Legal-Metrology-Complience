"use client";

/**
 * Personnel and role administration.
 *
 * Rows come from `GET /api/users` (ADMIN only) and are created through
 * `POST /api/users`, which requires USER_CREATE. Provisioning a platform row is
 * a separate step from creating the Supabase identity.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { UserPlus, X, Loader2 } from "lucide-react";
import { ApiRequestError, apiFetch, useSession } from "@/lib/session";

interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: "INSPECTOR" | "SUPERVISOR" | "ADMIN";
  department?: string | null;
  status?: string | null;
  lastLoginAt?: string | null;
}

interface UserListPayload {
  users: PlatformUser[];
  total: number;
  page: number;
  pageCount: number;
}

const ROLE_STYLES: Record<string, string> = {
  ADMIN: "bg-purple-50 text-purple-700 border-purple-200",
  SUPERVISOR: "bg-blue-50 text-blue-700 border-blue-200",
  INSPECTOR: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const EMPTY_FORM = { name: "", email: "", role: "INSPECTOR", department: "" };

export default function UsersPage() {
  const { can } = useSession();
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<UserListPayload>("/users");
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } catch (cause) {
      setUsers([]);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not have user administration access."
            : cause.message
          : "Unable to reach the enforcement API.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch<PlatformUser>("/users", {
        method: "POST",
        json: {
          name: form.name,
          email: form.email,
          role: form.role,
          department: form.department || undefined,
        },
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (cause) {
      setFormError(
        cause instanceof ApiRequestError ? cause.message : "The officer could not be provisioned.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Users & Role Permissions" }]} onRefresh={load} isRefreshing={loading} />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-6 flex-1">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2 border-b border-slate-200">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
                Enforcement Personnel &amp; RBAC Hierarchy
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Roles resolved from the platform <code className="font-mono">users</code> table and enforced by
                Fastify authorization middleware. Roles are never read from client-supplied metadata.
              </p>
            </div>

            {can("USER_CREATE") && (
              <Button variant="primary" icon={<UserPlus className="w-4 h-4" />} onClick={() => setShowForm(true)}>
                Add Authorized Officer
              </Button>
            )}
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">{error}</div>
          )}

          {showForm && (
            <Card>
              <form onSubmit={createUser} className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-[#12304A]">Provision Platform Officer</h2>
                  <button type="button" onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {formError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                    {formError}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="name" className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Full name
                    </label>
                    <input
                      id="name"
                      required
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#12304A]"
                    />
                  </div>
                  <div>
                    <label htmlFor="email" className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Official email
                    </label>
                    <input
                      id="email"
                      type="email"
                      required
                      value={form.email}
                      onChange={(event) => setForm({ ...form, email: event.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#12304A]"
                    />
                  </div>
                  <div>
                    <label htmlFor="role" className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Role
                    </label>
                    <select
                      id="role"
                      value={form.role}
                      onChange={(event) => setForm({ ...form, role: event.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#12304A]"
                    >
                      <option value="INSPECTOR">INSPECTOR</option>
                      <option value="SUPERVISOR">SUPERVISOR</option>
                      <option value="ADMIN">ADMIN</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="department" className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Department
                    </label>
                    <input
                      id="department"
                      value={form.department}
                      onChange={(event) => setForm({ ...form, department: event.target.value })}
                      placeholder="Legal Metrology Zonal Office"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-[#12304A]"
                    />
                  </div>
                </div>

                <p className="text-[11px] text-slate-500">
                  The officer must also exist as a Supabase identity with this exact email address; the platform
                  refuses sign-in for unprovisioned accounts.
                </p>

                <div className="flex items-center gap-2">
                  <Button type="submit" variant="primary" disabled={saving}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Provision officer
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Officer Name &amp; Email</th>
                    <th className="px-6 py-3">Assigned Role</th>
                    <th className="px-6 py-3">Department Division</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Last Sign-in</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        Loading personnel…
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        {error ? "Personnel could not be loaded." : "No officers have been provisioned yet."}
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => (
                      <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-3.5">
                          <div className="font-semibold text-slate-900">{user.name}</div>
                          <div className="text-[11px] text-slate-500">{user.email}</div>
                        </td>
                        <td className="px-6 py-3.5">
                          <span
                            className={`font-bold px-2 py-0.5 rounded text-[11px] uppercase ${
                              ROLE_STYLES[user.role] ?? "bg-slate-100 text-slate-700 border-slate-200"
                            }`}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-slate-600">{user.department || "—"}</td>
                        <td className="px-6 py-3.5 text-slate-600">{user.status ?? "ACTIVE"}</td>
                        <td className="px-6 py-3.5 text-slate-500">
                          {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("en-IN") : "Never"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 text-xs text-slate-500 border-t border-slate-100">
              {users.length} of {total.toLocaleString()} provisioned officers
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}
