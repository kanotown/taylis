import { AlertTriangle, Info } from "lucide-react";

import type { Priority } from "../api/types";
import { cn } from "./primitives";

/** M15e: 「重要」 / 「緊急」 above a message and in the composer. */
export function PriorityLabel({ priority, className }: { priority: Priority; className?: string }) {
  const urgent = priority === "urgent";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold leading-none",
        urgent ? "bg-danger/12 text-danger" : "bg-accent-soft text-accent",
        className,
      )}
    >
      {urgent ? <AlertTriangle size={11} /> : <Info size={11} />}
      {urgent ? "緊急" : "重要"}
    </span>
  );
}
