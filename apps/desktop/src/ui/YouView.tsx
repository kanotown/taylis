import { ShieldCheck } from "lucide-react";

import type { AppController } from "../state/app";
import { SettingsBody } from "./Dialogs";
import { Button } from "./primitives";

/**
 * M34, the phone's 「自分」 tab: the settings (the wide layout's dialog body) as one page. M36 splits it into screens
 * (MOBILE_UI.md §6.5).
 */
export function YouView({ controller, onStatus, onAdmin }: { controller: AppController; onStatus: () => void; onAdmin: () => void }) {
  return (
    <section aria-label="自分" className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <strong className="min-w-0 flex-1 truncate text-[17px]">自分</strong>
        {controller.isAdmin && (
          <Button size="sm" variant="secondary" onClick={onAdmin}>
            <ShieldCheck size={14} /> 管理
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <SettingsBody controller={controller} onStatus={onStatus} />
      </div>
    </section>
  );
}
