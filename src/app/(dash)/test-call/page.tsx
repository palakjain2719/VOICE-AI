import { Suspense } from "react";
import { PageHeader, PageSkeleton } from "@/components/ui";
import { requirePageRole } from "@/server/auth";
import { TestCallConsole } from "./console";

export default function TestCallPage() {
  return (
    <>
      <PageHeader eyebrow="Run the flow" title="Test call" description="Talk to the assistant as a caller would. Every step of the flow runs for real — understanding, approved answers, qualification rules, booking and outputs — and is kept out of live figures." />
      <Suspense fallback={<PageSkeleton />}>
        <Gate />
      </Suspense>
    </>
  );
}

async function Gate() {
  await requirePageRole("founder", "operator");
  return <TestCallConsole />;
}
