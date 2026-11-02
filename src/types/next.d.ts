/* eslint-disable @typescript-eslint/no-unused-vars */
import React from "react";

declare global {
  type PageProps<_Path extends string = string> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    searchParams?: Promise<any>;
  };

  type LayoutProps<_Path extends string = string> = {
    children: React.ReactNode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: Promise<any>;
  };
}

export {};
