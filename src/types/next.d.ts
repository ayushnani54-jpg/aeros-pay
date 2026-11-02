import React from "react";

declare global {
  // Next.js 16 App Router types fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PageProps<_Path extends string = string> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    searchParams?: Promise<any>;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type LayoutProps<_Path extends string = string> = {
    children: React.ReactNode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: Promise<any>;
  };
}

export {};
