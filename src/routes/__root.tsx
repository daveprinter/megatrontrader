import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { getState, hydrate, nairobiTime, useApp } from "../lib/store";
import { connectAccount, resumeIfLaunched } from "../lib/engine";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page doesn't exist.</p>
        <Link to="/" className="btn-primary mt-6">Go home</Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">This page didn't load</h1>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="btn-primary mt-6"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Megatron AI — Deriv Auto Trader" },
      { name: "description", content: "Megatron AI automated Deriv trading hub." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#0b0f1a" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Megatron AI" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Clock() {
  const [t, setT] = useState("");
  useEffect(() => {
    const i = setInterval(() => setT(nairobiTime()), 1000);
    setT(nairobiTime());
    return () => clearInterval(i);
  }, []);
  return <span className="num text-xs text-muted-foreground">{t} EAT</span>;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const launched = useApp((s) => s.session.launched);
  const conn = useApp((s) => s.conn.status);

  useEffect(() => {
    hydrate();
    if (getState().settings.token) connectAccount().then(resumeIfLaunched);
  }, []);

  const tab = "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs font-semibold text-muted-foreground";
  return (
    <QueryClientProvider client={queryClient}>
      <div className="mx-auto min-h-screen max-w-2xl pb-24">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${launched ? "animate-pulse bg-success" : conn === "connected" ? "bg-accent" : "bg-muted-foreground"}`} />
            <span className="font-display text-lg font-bold tracking-wider glow-text">MEGATRON AI</span>
          </div>
          <Clock />
        </header>
        <main className="space-y-4 p-4">
          <Outlet />
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          {(
            [
              ["/", "Home"],
              ["/settings", "Settings"],
              ["/history", "History"],
            ] as const
          ).map(([to, label]) => (
            <Link key={to} to={to} className={tab} activeProps={{ className: "text-primary" }} activeOptions={{ exact: true }}>
              <span className="text-sm">{label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </QueryClientProvider>
  );
}
