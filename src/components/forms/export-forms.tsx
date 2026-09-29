"use client";

import { useMemo, useState } from "react";
import type { ExportFilterName } from "@/lib/exports";

export type ExportDatasetSummary = {
  key: string;
  label: string;
  description: string;
  supports: ExportFilterName[];
};

/**
 * The export picker.
 *
 * It builds a URL and nothing else — there is no fetch, no blob and no client
 * state that could hold a copy of the data. Pressing Download is an ordinary
 * navigation to a route handler that streams the file, which is why a
 * hundred-thousand-row export does not need the browser to hold it in memory
 * any more than the server does.
 *
 * Note that the filter fields are all NARROWING fields. There is no field here
 * that names whose data to read: that is decided server-side from the session.
 */
export function ExportPanel({
  datasets,
  basePath,
  /** Appended to every URL, e.g. `scope=company`. */
  fixedParams,
}: {
  datasets: ExportDatasetSummary[];
  basePath: string;
  fixedParams?: Record<string, string>;
}) {
  const [selected, setSelected] = useState(datasets[0]?.key ?? "");
  const [filters, setFilters] = useState<Record<string, string>>({});

  const dataset = useMemo(
    () => datasets.find((d) => d.key === selected) ?? datasets[0],
    [datasets, selected],
  );

  if (!dataset) return null;

  const href = (format: "csv" | "json") => {
    const params = new URLSearchParams({ format, ...(fixedParams ?? {}) });
    for (const name of dataset.supports) {
      const value = filters[name];
      if (value && value.trim() !== "") params.set(name, value.trim());
    }
    return `${basePath}/${dataset.key}?${params.toString()}`;
  };

  const set = (name: string, value: string) =>
    setFilters((prev) => ({ ...prev, [name]: value }));

  const supports = (name: ExportFilterName) => dataset.supports.includes(name);

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <label htmlFor="exportDataset" className="mb-1 block text-sm font-medium">
          What to export
        </label>
        <select
          id="exportDataset"
          className="input"
          value={dataset.key}
          onChange={(e) => {
            setSelected(e.target.value);
            setFilters({});
          }}
        >
          {datasets.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-sm text-muted">{dataset.description}</p>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Filters</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {supports("from") && (
            <Field id="exFrom" label="From date">
              <input
                id="exFrom"
                type="date"
                className="input"
                value={filters.from ?? ""}
                onChange={(e) => set("from", e.target.value)}
              />
            </Field>
          )}
          {supports("to") && (
            <Field id="exTo" label="To date">
              <input
                id="exTo"
                type="date"
                className="input"
                value={filters.to ?? ""}
                onChange={(e) => set("to", e.target.value)}
              />
            </Field>
          )}
          {supports("type") && (
            <Field id="exType" label="Type">
              <input
                id="exType"
                className="input"
                placeholder="e.g. TRANSFER"
                value={filters.type ?? ""}
                onChange={(e) => set("type", e.target.value)}
              />
            </Field>
          )}
          {supports("status") && (
            <Field id="exStatus" label="Status">
              <input
                id="exStatus"
                className="input"
                placeholder="e.g. PAID"
                value={filters.status ?? ""}
                onChange={(e) => set("status", e.target.value)}
              />
            </Field>
          )}
          {supports("walletType") && (
            <Field id="exWallet" label="Wallet type">
              <select
                id="exWallet"
                className="input"
                value={filters.walletType ?? ""}
                onChange={(e) => set("walletType", e.target.value)}
              >
                <option value="">Any</option>
                <option value="USER">User</option>
                <option value="COMPANY">Company</option>
                <option value="GOVERNMENT">Government</option>
              </select>
            </Field>
          )}
          {supports("minAmount") && (
            <Field id="exMin" label="Minimum amount">
              <input
                id="exMin"
                type="number"
                className="input"
                value={filters.minAmount ?? ""}
                onChange={(e) => set("minAmount", e.target.value)}
              />
            </Field>
          )}
          {supports("maxAmount") && (
            <Field id="exMax" label="Maximum amount">
              <input
                id="exMax"
                type="number"
                className="input"
                value={filters.maxAmount ?? ""}
                onChange={(e) => set("maxAmount", e.target.value)}
              />
            </Field>
          )}
          {supports("user") && (
            <Field id="exUser" label="User (@username)">
              <input
                id="exUser"
                className="input"
                value={filters.user ?? ""}
                onChange={(e) => set("user", e.target.value)}
              />
            </Field>
          )}
          {supports("company") && (
            <Field id="exCompany" label="Company (@username)">
              <input
                id="exCompany"
                className="input"
                value={filters.company ?? ""}
                onChange={(e) => set("company", e.target.value)}
              />
            </Field>
          )}
          {supports("entity") && (
            <Field id="exEntity" label="Name contains">
              <input
                id="exEntity"
                className="input"
                value={filters.entity ?? ""}
                onChange={(e) => set("entity", e.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <a className="btn btn-primary text-sm" href={href("csv")} download data-testid="export-csv">
            Download CSV
          </a>
          <a className="btn btn-secondary text-sm" href={href("json")} download data-testid="export-json">
            Download JSON
          </a>
          {Object.values(filters).some((v) => v && v.trim() !== "") && (
            <button type="button" className="btn btn-secondary text-sm" onClick={() => setFilters({})}>
              Clear filters
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The one-click personal/company download used on the ordinary app pages.
 * A link, not a form: the response is a file, and a navigation is the right
 * primitive for a file.
 */
export function ExportLink({
  href,
  label,
  className = "btn btn-secondary text-sm",
  testId,
}: {
  href: string;
  label: string;
  className?: string;
  testId?: string;
}) {
  return (
    <a className={className} href={href} download data-testid={testId}>
      {label}
    </a>
  );
}
