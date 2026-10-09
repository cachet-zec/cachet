"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { BrowserWalletProvider } from "@/lib/browser-wallet";
import { SwapMakerProvider } from "@/lib/swap-maker";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain state changes at block cadence; there is no point
            // hammering the API faster than that.
            staleTime: 5_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserWalletProvider>
        <SwapMakerProvider>{children}</SwapMakerProvider>
      </BrowserWalletProvider>
    </QueryClientProvider>
  );
}
