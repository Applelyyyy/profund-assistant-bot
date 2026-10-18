import { Suspense } from "react";
import Console from "./console";
export default function Page() {
  return (
    <Suspense
      fallback={<div className="loading-page">Loading administration…</div>}
    >
      <Console />
    </Suspense>
  );
}
