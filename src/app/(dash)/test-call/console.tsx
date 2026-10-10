"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Circle, Loader2, Mic, MicOff, PhoneCall, PhoneOff, Send, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";

type Turn = { role: "agent" | "caller"; text: string; at: string };
type Trace = { step: string; detail: string; at: string };
type State = { stage: string; intent: string; turns: Turn[]; trace: Trace[]; qualification: { status: string; uncertainties: string[]; closure?: string | null } | null; outcome: string | null; slots: { label: string; designer: string }[] };
type Input = { key: string; label: string; done: boolean; value: string | null; skipped: boolean };
type Outputs = {
  call: { id: string; status: string; duration: number | null; summary: string | null; hasTranscript: boolean };
  lead: { id: string; status: string; hubspot: string; handoffAt: string | null } | null;
  appointments: { id: string; status: string; start_at: string; confirmation_email_status: string; provider_event_id: string | null; designers: { name: string } | null }[];
  exceptions: { id: string; kind: string; title: string; lane: string; status: string }[];
  messages: { id: string; for_name: string | null; delivered_via: string | null; designers: { name: string } | null }[];
  jobs: { type: string; status: string; attempts: number; last_error: string | null }[];
};

// Minimal typing for the browser speech APIs (Chrome / Edge).
type SpeechRec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string; error?: string }).message ?? (json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

const STEPS = ["Trigger", "Voice AI answers", "Inputs collected", "Knowledge used", "AI processing", "Decision & actions", "Outputs"] as const;

export function TestCallConsole() {
  const [callId, setCallId] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [inputs, setInputs] = useState<Input[]>([]);
  const [outputs, setOutputs] = useState<Outputs | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOut, setVoiceOut] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRec | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const speechSupported = useSyncExternalStore(
    () => () => {},
    () => { const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }; return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition); },
    () => false,
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [state?.turns.length]);

  const speak = useCallback((t: string) => {
    if (!voiceOut || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang === "en-IN") ?? window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("en"));
    if (voice) u.voice = voice;
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  }, [voiceOut]);

  const refreshOutputs = useCallback(async (id: string) => {
    const res = await fetch(`/api/agent/outputs?callId=${id}`);
    if (res.ok) setOutputs(await res.json());
  }, []);

  async function start() {
    setBusy(true); setError(null); setOutputs(null);
    try {
      const r = await post<{ callId: string; say: string; state: State; inputs: Input[] }>("/api/agent/start", {});
      setCallId(r.callId); setState(r.state); setInputs(r.inputs); speak(r.say);
    } catch (e) { setError((e as Error).message === "integration_not_configured" ? "Gemini isn't configured, so the agent can't understand callers yet." : (e as Error).message); }
    setBusy(false);
  }

  async function send(utterance: string) {
    if (!callId || !utterance.trim() || state?.stage === "closed") return;
    setBusy(true); setError(null); setText(""); setInterim("");
    setState((s) => s && { ...s, turns: [...s.turns, { role: "caller", text: utterance, at: new Date().toISOString() }] });
    try {
      const r = await post<{ say: string; done: boolean; state: State; inputs: Input[] }>("/api/agent/turn", { callId, text: utterance });
      setState(r.state); setInputs(r.inputs); speak(r.say);
      if (r.done) { await refreshOutputs(callId); setTimeout(() => refreshOutputs(callId), 4000); }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  function toggleMic() {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = false;
    let final = "";
    rec.onresult = (e) => {
      let live = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript; else live += r[0].transcript;
      }
      setInterim(final + live);
    };
    rec.onend = () => { setListening(false); if (final.trim()) send(final.trim()); };
    rec.onerror = () => setListening(false);
    window.speechSynthesis?.cancel();
    recRef.current = rec; setListening(true); rec.start();
  }

  const closed = state?.stage === "closed";
  const trace = state?.trace ?? [];
  const knowledge = trace.filter((t) => t.step === "answer");
  const processing = trace.filter((t) => ["understand", "extract", "evaluate"].includes(t.step));
  const decisions = trace.filter((t) => ["decide", "availability", "book", "escalate", "message", "close"].includes(t.step));
  const q = state?.qualification?.status;
  const active = !state ? 0 : closed ? 7 : decisions.length ? 6 : processing.some((t) => t.step === "evaluate") ? 6 : inputs.some((i) => i.done) ? 3 : 2;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* Conversation */}
      <section aria-label="Conversation" className="flex min-h-[560px] flex-col rounded-[10px] border border-line bg-surface lg:sticky lg:top-[80px] lg:h-[calc(100vh-110px)]">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[14.5px] font-semibold">Conversation</h2>
            <p className="text-[12px] text-ink-3">{!state ? "Start a call, then talk or type as the caller" : closed ? `Ended · ${state.outcome}` : busy ? "Agent is thinking…" : listening ? "Listening…" : "Your turn"}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setVoiceOut((v) => !v)} className="inline-flex size-8 items-center justify-center rounded-md border border-line text-ink-2 hover:border-line-strong" aria-label={voiceOut ? "Mute agent voice" : "Unmute agent voice"}>
              {voiceOut ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
            {!state || closed ? (
              <button type="button" onClick={start} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-ink disabled:opacity-60"><PhoneCall className="size-4" />{state ? "New call" : "Start test call"}</button>
            ) : (
              <button type="button" onClick={() => send("Thank you, that's all, goodbye.")} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-crit/40 bg-crit-soft px-3 text-[13px] font-medium text-crit-ink disabled:opacity-60"><PhoneOff className="size-4" />Hang up</button>
            )}
          </div>
        </div>
        <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!state ? (
            <li className="mx-auto max-w-sm py-16 text-center text-[13.5px] text-ink-3">
              This runs the real flow: the agent understands you with Gemini, answers only from approved knowledge, applies the qualification rules and books from real calendars. Test calls are kept out of live figures.
            </li>
          ) : null}
          {state?.turns.map((t, i) => (
            <li key={i} className={cn("flex", t.role === "caller" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] rounded-xl px-3.5 py-2 text-[14px] leading-relaxed", t.role === "caller" ? "bg-accent text-accent-ink" : "border border-line bg-surface-2 text-ink")}>
                <div className={cn("mb-0.5 text-[11px] font-semibold tracking-wide uppercase", t.role === "caller" ? "text-accent-ink/80" : "text-ink-3")}>{t.role === "caller" ? "Caller (you)" : "Aangan assistant"}</div>
                {t.text}
              </div>
            </li>
          ))}
          {busy && state ? <li className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="size-3.5 animate-spin" /> understanding · checking knowledge and rules</li> : null}
          {interim ? <li className="text-right text-[13px] text-ink-3 italic">{interim}</li> : null}
          <div ref={endRef} />
        </ol>
        {error ? <p role="alert" className="mx-4 mb-2 rounded-md bg-crit-soft px-3 py-2 text-[12.5px] text-crit-ink">{error}</p> : null}
        <form className="flex items-center gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          {speechSupported ? (
            <button type="button" onClick={toggleMic} disabled={!state || closed || busy} className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full border disabled:opacity-50", listening ? "border-crit bg-crit text-white" : "border-line text-ink-2 hover:border-line-strong")} aria-label={listening ? "Stop listening" : "Speak"}>
              {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          ) : null}
          <input value={text} onChange={(e) => setText(e.target.value)} disabled={!state || closed || busy} placeholder={speechSupported ? "Type, or press the mic and speak" : "Type what the caller says"} className="h-10 flex-1 rounded-lg border border-line bg-surface px-3 text-[14px] outline-none focus:border-accent disabled:opacity-60" aria-label="Caller message" />
          <button type="submit" disabled={!state || closed || busy || !text.trim()} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink disabled:opacity-50" aria-label="Send"><Send className="size-4" /></button>
        </form>
      </section>

      {/* The flow map, live */}
      <section aria-label="Flow" className="space-y-3">
        <ol className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => (
            <li key={s} className={cn("rounded-full border px-2.5 py-1 text-[12px] font-medium", i + 1 <= active ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-3")}>{i + 1} · {s}</li>
          ))}
        </ol>

        <Step n={1} title="Trigger · incoming call" done={!!state}>
          {state ? <p>Test call started {new Date(state.turns[0].at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}. Real phone calls arrive the same way through Vaani — answered 24/7, including after hours.</p> : <p className="text-ink-3">Waiting for a call.</p>}
        </Step>

        <Step n={2} title="Voice AI answers" done={!!state}>
          {state ? <p>Greeted the caller and is asking one question at a time · {state.turns.filter((t) => t.role === "caller").length} caller turns so far.</p> : <p className="text-ink-3">—</p>}
        </Step>

        <Step n={3} title="Inputs collected" done={inputs.some((i) => i.done)}>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {(inputs.length ? inputs : []).map((i) => (
              <li key={i.key} className="flex items-baseline gap-2 text-[13px]">
                {i.done ? <Check aria-label="Collected" className="size-3.5 shrink-0 translate-y-0.5 text-good" /> : <Circle aria-label="Not yet" className="size-3 shrink-0 translate-y-0.5 text-line-strong" />}
                <span className="text-ink-2">{i.label}</span>
                <span className="truncate text-ink">{i.value ?? (i.skipped ? "not given" : "")}</span>
              </li>
            ))}
            {!inputs.length ? <li className="text-[13px] text-ink-3">Name, phone, location, home or office, project and scope, size, timeline, decision-maker. Budget is never asked.</li> : null}
          </ul>
        </Step>

        <Step n={4} title="Context & knowledge used" done={knowledge.length > 0}>
          {knowledge.length ? <ul className="space-y-1">{knowledge.map((k, i) => <li key={i}>{k.detail}</li>)}</ul> : <p className="text-ink-3">When the caller asks something, the answer comes only from approved knowledge; price questions get the approved reply.</p>}
        </Step>

        <Step n={5} title="AI processing" done={processing.length > 0}>
          {processing.length ? (
            <ol className="max-h-56 space-y-1 overflow-y-auto">
              {processing.map((t, i) => <li key={i} className="flex gap-2"><span className="w-20 shrink-0 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{t.step}</span><span>{t.detail}</span></li>)}
            </ol>
          ) : <p className="text-ink-3">Understand → extract → evaluate, on every turn.</p>}
        </Step>

        <Step n={6} title="Decision & actions" done={!!q || decisions.length > 0}>
          {q ? (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold", q === "green" ? "bg-good-soft text-good-ink" : q === "amber" ? "bg-warn-soft text-warn-ink" : q === "red" ? "bg-crit-soft text-crit-ink" : "bg-accent-soft text-accent")}>
                {q === "green" ? "● Green — qualified" : q === "amber" ? "● Amber — qualified, points to clarify" : q === "red" ? "● Red — not a fit" : "● Needs a designer's judgement"}
              </span>
              {state?.qualification?.uncertainties.length ? <span className="text-[12.5px] text-ink-3">to clarify: {state.qualification.uncertainties.join(", ").replace(/_/g, " ")}</span> : null}
            </div>
          ) : null}
          {decisions.length ? <ol className="space-y-1">{decisions.map((t, i) => <li key={i}>→ {t.detail}</li>)}</ol> : <p className="text-ink-3">Red closes politely and is logged. Green and Amber go to designer availability → booking → handoff.</p>}
        </Step>

        <Step n={7} title="Outputs" done={!!outputs}>
          {!closed ? <p className="text-ink-3">Shown when the call ends: confirmation email, HubSpot lead, designer brief, follow-up tasks.</p> : !outputs ? <p className="flex items-center gap-2 text-ink-3"><Loader2 className="size-3.5 animate-spin" /> running outputs…</p> : <OutputList o={outputs} />}
        </Step>

        {outputs ? (
          <div className="rounded-[10px] border border-line bg-surface-2 px-4 py-3 text-[13px]">
            <div className="eyebrow mb-1">Backend</div>
            Call record, transcript{outputs.call.hasTranscript ? " ✓" : ""}, structured lead data and status logs are saved.{" "}
            <Link href={`/calls/${outputs.call.id}`} className="font-medium text-accent">Open the call record →</Link>
            {outputs.call.summary ? <p className="mt-1 text-ink-2">Summary: {outputs.call.summary}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-[10px] border bg-surface px-4 py-3 text-[13.5px] leading-relaxed", done ? "border-line" : "border-dashed border-line")}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn("flex size-6 items-center justify-center rounded-full text-[12px] font-semibold", done ? "bg-accent text-accent-ink" : "bg-line/70 text-ink-3")}>{n}</span>
        <h3 className="text-[14px] font-semibold">{title}</h3>
      </div>
      <div className="text-ink">{children}</div>
    </div>
  );
}

function OutputList({ o }: { o: Outputs }) {
  const job = (prefix: string) => o.jobs.find((j) => j.type === prefix);
  const appt = o.appointments.find((a) => a.status === "confirmed") ?? o.appointments[0];
  const rows: { label: string; status: "done" | "blocked" | "n/a" | "pending"; detail: string }[] = [];
  if (appt) {
    rows.push({ label: "Calendar booking", status: appt.status === "confirmed" ? "done" : "blocked", detail: appt.status === "confirmed" ? `${new Date(appt.start_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} with ${appt.designers?.name ?? "designer"}` : appt.status });
    const ej = job("send_confirmation_email");
    rows.push({ label: "Confirmation email to customer", status: appt.confirmation_email_status === "sent" ? "done" : appt.confirmation_email_status === "not_possible" ? "n/a" : ej?.last_error ? "blocked" : "pending", detail: appt.confirmation_email_status === "sent" ? "sent" : appt.confirmation_email_status === "not_possible" ? "no email given → phone confirmation task" : ej?.last_error ?? appt.confirmation_email_status });
    const hj = job("designer_handoff");
    rows.push({ label: "Designer brief (handoff)", status: o.lead?.handoffAt ? "done" : hj?.last_error ? "blocked" : "pending", detail: o.lead?.handoffAt ? "emailed to the designer" : hj?.last_error ?? "queued" });
  }
  if (o.lead && (o.lead.status === "green" || o.lead.status === "amber")) rows.push({ label: "HubSpot lead (contact + deal)", status: "n/a", detail: "not sent for test calls, so the CRM stays clean — live calls sync automatically" });
  for (const m of o.messages) rows.push({ label: "Message for team", status: m.delivered_via === "email" ? "done" : "pending", detail: `for ${m.designers?.name ?? m.for_name ?? "the team"}${m.delivered_via === "email" ? " · emailed" : " · on the Callbacks list"}` });
  for (const e of o.exceptions) rows.push({ label: e.kind === "complaint" ? "Complaint escalation" : "Follow-up task", status: "done", detail: `${e.title} · ${e.lane} lane` });
  if (!rows.length) rows.push({ label: "Logged", status: "done", detail: o.lead ? `lead recorded as ${o.lead.status}` : "call recorded" });
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={i} className="flex gap-2">
          <span className={cn("mt-0.5 h-fit shrink-0 rounded px-1.5 text-[11px] font-semibold uppercase", r.status === "done" ? "bg-good-soft text-good-ink" : r.status === "blocked" ? "bg-crit-soft text-crit-ink" : r.status === "n/a" ? "bg-line/70 text-ink-3" : "bg-warn-soft text-warn-ink")}>{r.status}</span>
          <span><span className="font-medium">{r.label}</span> — <span className="text-ink-2">{r.detail}</span></span>
        </li>
      ))}
    </ul>
  );
}
