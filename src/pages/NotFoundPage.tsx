import { Link } from "react-router-dom";

import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/button";

export function NotFoundPage() {
  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-5 py-24 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full border border-cinnabar/30 bg-cinnabar/5 font-serif text-2xl text-cinnabar">
          沮
        </div>
        <h1 className="mt-5 font-serif text-2xl font-semibold tracking-wide">这一页不在书里</h1>
        <p className="mt-2 text-sm leading-7 text-ink-soft">地址可能已经失效，或者这本书还没有安装。</p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/">回到书架</Link>
        </Button>
      </div>
    </AppShell>
  );
}
