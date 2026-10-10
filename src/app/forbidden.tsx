import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">You don&apos;t have access to this page</h1>
      <p className="mt-2 text-sm text-ink-3">Ask an administrator to grant the role you need.</p>
      <Link href="/" className="mt-6 inline-block text-sm font-medium text-accent">Back to overview</Link>
    </div>
  );
}
