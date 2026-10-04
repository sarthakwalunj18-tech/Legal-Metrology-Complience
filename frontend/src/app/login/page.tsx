"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Shield, AlertTriangle, Loader2, LogIn, KeyRound } from "lucide-react";

const DEMO_IDENTITIES = [
  {
    role: "INSPECTOR",
    email: "inspector.sarthak@lm.gov.in",
    name: "Sarthak Verma",
    title: "Inspecting Officer",
    scope: "Own inspections only · cannot approve own review",
  },
  {
    role: "SUPERVISOR",
    email: "supervisor.anita@lm.gov.in",
    name: "Anita Rao",
    title: "Supervising Officer",
    scope: "Department-wide review · Legal Metrology Zonal Office",
  },
  {
    role: "ADMIN",
    email: "admin.director@lm.gov.in",
    name: "Director General",
    title: "Platform Administrator",
    scope: "Global scope · users, rules, audit and configuration",
  },
] as const;

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"credentials" | "demo">("demo");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    const next = searchParams.get("next");
    router.replace(next && next.startsWith("/") ? next : "/");
    router.refresh();
  };

  const submit = async (payload: Record<string, string>, key: string) => {
    setPending(key);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };

      if (!response.ok) {
        setError(body.error?.message ?? "Sign-in failed. Please try again.");
        return;
      }

      finish();
    } catch {
      setError("The session service is unreachable.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="w-full max-w-md">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-slate-100">
          <h1 className="text-lg font-bold text-[#12304A]">Officer Sign-in</h1>
          <p className="text-xs text-slate-500 mt-1">
            Authentication is issued by the backend. Session tokens are stored in
            httpOnly cookies and never exposed to the browser.
          </p>
        </div>

        <div className="p-6 space-y-5">
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
            {(["demo", "credentials"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  mode === option ? "bg-white text-[#12304A] shadow-xs" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {option === "demo" ? "Demo identities" : "Email & password"}
              </button>
            ))}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {mode === "demo" ? (
            <div className="space-y-2.5">
              <p className="text-[11px] text-slate-500">
                Role-based demo access is served by the backend and is hard-disabled
                whenever <code className="font-mono">ALLOW_DEV_AUTH</code> is off.
              </p>
              {DEMO_IDENTITIES.map((identity) => (
                <button
                  key={identity.role}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => submit({ role: identity.role }, identity.role)}
                  className="w-full text-left p-3.5 border border-slate-200 rounded-xl hover:border-[#12304A] hover:bg-slate-50 transition-colors disabled:opacity-60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        {identity.name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {identity.title} · {identity.email}
                      </div>
                    </div>
                    {pending === identity.role ? (
                      <Loader2 className="w-4 h-4 text-[#12304A] animate-spin" />
                    ) : (
                      <LogIn className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                  <div className="mt-1.5 text-[10.5px] text-slate-500">{identity.scope}</div>
                </button>
              ))}
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submit({ email, password }, "credentials");
              }}
            >
              <div>
                <label htmlFor="email" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Official email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="officer@lm.gov.in"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#12304A]/20 focus:border-[#12304A]"
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#12304A]/20 focus:border-[#12304A]"
                />
              </div>
              <button
                type="submit"
                disabled={pending !== null}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-[#12304A] rounded-lg hover:bg-[#0d2437] transition-colors disabled:opacity-60"
              >
                {pending === "credentials" ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Sign in
              </button>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Access requires an active Supabase identity that has been provisioned
                in the platform <code className="font-mono">users</code> table. Roles are
                never read from client-supplied metadata.
              </p>
            </form>
          )}
        </div>
      </div>

      <p className="mt-4 text-[10.5px] text-slate-500 text-center leading-relaxed">
        Government of India · Department of Consumer Affairs
        <br />
        Protected system. Authorised enforcement personnel only.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center px-4 py-10 gap-6">
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-[#12304A] text-white rounded-xl">
          <Shield className="w-6 h-6 text-blue-300" />
        </div>
        <div>
          <div className="text-sm font-bold uppercase tracking-wider text-[#12304A]">
            Legal Metrology
          </div>
          <div className="text-xs text-slate-500 font-medium">
            Packaged Commodities Compliance Portal
          </div>
        </div>
      </div>

      <Suspense
        fallback={
          <div className="w-full max-w-md h-96 bg-white rounded-2xl border border-slate-200 animate-pulse" />
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
