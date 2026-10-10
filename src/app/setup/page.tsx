export default function SetupPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-xl font-semibold">Configuration required</h1>
      <p className="mt-2 text-sm text-ink-3">
        Supabase isn&apos;t configured for this deployment yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
        <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> and <code>SUPABASE_SECRET_KEY</code> (see <code>.env.example</code> and the README), then redeploy.
      </p>
    </div>
  );
}
