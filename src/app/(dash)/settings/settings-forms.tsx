"use client";
import { useState } from "react";
import { Btn, Feedback, fieldCls, useApi } from "@/components/actions";

export function JsonSettingForm({ settingKey, initial, help }: { settingKey: string; initial: unknown; help: string }) {
  const { call, pending, error, ok } = useApi();
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-ink-3">{help}</p>
      <textarea className={`${fieldCls} font-mono text-[12.5px]`} rows={Math.min(24, text.split("\n").length + 1)} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={settingKey} />
      <Btn variant="primary" disabled={pending} onClick={() => {
        try {
          const value = JSON.parse(text);
          setParseError(null);
          call("/api/admin/settings", { key: settingKey, value }, "PUT", "Saved as a new version");
        } catch {
          setParseError("That isn't valid JSON.");
        }
      }}>Save new version</Btn>
      <Feedback error={parseError ?? error} ok={ok} />
    </div>
  );
}

type Pipeline = { id: string; label: string; stages: { id: string; label: string; displayOrder: number; metadata: { probability?: string } }[] };
const STAGE_KEYS = [
  ["qualified", "Lead qualified by the voice agent"],
  ["consultation_booked", "Consultation booked"],
  ["consultation_completed", "Consultation completed (set by designers)"],
  ["deal_open", "Deal open / proposal stage (funnel “Open deals”)"],
] as const;

export function PipelineMappingForm({ pipelines, current }: { pipelines: Pipeline[]; current: { pipelineId: string; stages: Record<string, string> } | null }) {
  const { call, pending, error, ok } = useApi();
  const [pipelineId, setPipelineId] = useState(current?.pipelineId ?? pipelines[0]?.id ?? "");
  const [stages, setStages] = useState<Record<string, string>>(current?.stages ?? {});
  const p = pipelines.find((x) => x.id === pipelineId);
  return (
    <div className="space-y-3">
      <label className="block text-[13px] text-ink-3">Deal pipeline
        <select className={`${fieldCls} mt-1`} value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setStages({}); }}>
          {pipelines.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </label>
      {STAGE_KEYS.map(([k, label]) => (
        <label key={k} className="block text-[13px] text-ink-3">{label}
          <select className={`${fieldCls} mt-1`} value={stages[k] ?? ""} onChange={(e) => setStages({ ...stages, [k]: e.target.value })}>
            <option value="">Choose a stage…</option>
            {[...(p?.stages ?? [])].sort((a, b) => a.displayOrder - b.displayOrder).map((s) => <option key={s.id} value={s.id}>{s.label}{s.metadata.probability ? ` (${Math.round(Number(s.metadata.probability) * 100)}%)` : ""}</option>)}
          </select>
        </label>
      ))}
      <Btn variant="primary" disabled={pending || STAGE_KEYS.some(([k]) => !stages[k])} onClick={() => call("/api/admin/settings", { key: "hubspot_pipeline", value: { pipelineId, stages } }, "PUT", "Mapping saved")}>Save mapping</Btn>
      <Feedback error={error} ok={ok} />
    </div>
  );
}

type Designer = { id: string; name: string; email: string | null; hubspot_owner_id: string | null; calendar_id: string | null; google_credential_id: string | null; active: boolean; booking_enabled: boolean; app_user_id?: string | null };

export function DesignerRow({ d, owners, logins = [] }: { d: Designer; owners: { id: string; label: string }[]; logins?: { id: string; label: string }[] }) {
  const { call, pending, error, ok } = useApi();
  const [cals, setCals] = useState<{ id: string; summary: string; primary: boolean }[] | null>(null);
  const [calErr, setCalErr] = useState<string | null>(null);
  return (
    <div className="space-y-2 border-b border-line px-5 py-4 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{d.name}</span>
        <span className="text-[12.5px] text-ink-3">{d.email ?? "no email"}</span>
        <span className={`text-[12.5px] ${d.google_credential_id ? "text-good-ink" : "text-ink-3"}`}>{d.google_credential_id ? `Calendar: ${d.calendar_id ?? "not chosen"}` : "Calendar not connected"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/api/auth/google/start?designer_id=${d.id}`} className="inline-flex h-9 items-center rounded-xl border border-line bg-surface px-3 text-sm font-medium hover:border-line-strong">{d.google_credential_id ? "Reconnect Google" : "Connect Google Calendar"}</a>
        {d.google_credential_id ? (
          <Btn disabled={pending} onClick={async () => {
            setCalErr(null);
            const r = await fetch(`/api/admin/designers/${d.id}/calendars`);
            const j = await r.json();
            if (!r.ok) setCalErr(j.message ?? "Couldn't list calendars");
            else setCals(j.calendars);
          }}>Choose calendar</Btn>
        ) : null}
        {cals ? (
          <select className={`${fieldCls} h-9 max-w-xs py-0`} defaultValue={d.calendar_id ?? ""} onChange={(e) => call("/api/admin/designers", { id: d.id, calendar_id: e.target.value }, "POST", "Calendar saved")}>
            {cals.map((c) => <option key={c.id} value={c.id}>{c.summary}{c.primary ? " (primary)" : ""}</option>)}
          </select>
        ) : null}
        <select className={`${fieldCls} h-9 max-w-xs py-0`} aria-label="HubSpot owner" defaultValue={d.hubspot_owner_id ?? ""} onChange={(e) => call("/api/admin/designers", { id: d.id, hubspot_owner_id: e.target.value || null }, "POST", "Owner saved")}>
          <option value="">HubSpot owner: none</option>
          {owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select className={`${fieldCls} h-9 max-w-xs py-0`} aria-label="Designer login" defaultValue={d.app_user_id ?? ""} onChange={(e) => call("/api/admin/designers", { id: d.id, app_user_id: e.target.value || null }, "POST", "Login linked")}>
          <option value="">Login: none</option>
          {logins.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" defaultChecked={d.booking_enabled} onChange={(e) => call("/api/admin/designers", { id: d.id, booking_enabled: e.target.checked }, "POST", e.target.checked ? "Booking enabled" : "Booking disabled")} /> Bookable</label>
        <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" defaultChecked={d.active} onChange={(e) => call("/api/admin/designers", { id: d.id, active: e.target.checked }, "POST", "Saved")} /> Active</label>
      </div>
      <Feedback error={calErr ?? error} ok={ok} />
    </div>
  );
}

export function AddDesigner() {
  const { call, pending, error, ok } = useApi();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2 px-5 py-4">
      <label className="text-[13px] text-ink-3">Name<input className={`${fieldCls} mt-1 h-9 py-0`} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="text-[13px] text-ink-3">Email<input className={`${fieldCls} mt-1 h-9 py-0`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <Btn variant="primary" disabled={pending || name.trim().length < 2} onClick={async () => { if (await call("/api/admin/designers", { name, email: email || null }, "POST", "Designer added")) { setName(""); setEmail(""); } }}>Add designer</Btn>
      <Feedback error={error} ok={ok} />
    </div>
  );
}

export function UserRoles({ id, email, roles, active }: { id: string; email: string; roles: string[]; active: boolean }) {
  const { call, pending, error, ok } = useApi();
  const [r, setR] = useState(roles);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-0">
      <span className="min-w-[220px] text-sm">{email}</span>
      {(["founder", "operator", "designer", "admin"] as const).map((role) => (
        <label key={role} className="inline-flex items-center gap-1.5 text-sm capitalize">
          <input type="checkbox" checked={r.includes(role)} onChange={(e) => setR(e.target.checked ? [...r, role] : r.filter((x) => x !== role))} /> {role}
        </label>
      ))}
      <Btn disabled={pending} onClick={() => call(`/api/admin/users/${id}`, { roles: r }, "PATCH", "Roles saved")}>Save</Btn>
      <Btn disabled={pending} onClick={() => call(`/api/admin/users/${id}`, { active: !active }, "PATCH", active ? "Deactivated" : "Activated")}>{active ? "Deactivate" : "Activate"}</Btn>
      <Feedback error={error} ok={ok} />
    </div>
  );
}
