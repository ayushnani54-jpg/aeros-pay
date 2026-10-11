import fs from "node:fs";
import path from "node:path";

const repos = [
  {
    name: "aeros-archive-ledger",
    datasets: ["transactions_history", "exchange_purchases", "closed_refunds"],
    description:
      "Permanent historical archive for Aeros Pay Category C transactions, settled/cancelled Exchange package purchases, and closed Refund requests.",
  },
  {
    name: "aeros-archive-contracts",
    datasets: ["closed_invoices", "closed_contracts", "repaid_loans"],
    description:
      "Permanent historical archive for Aeros Pay paid/cancelled/expired invoices, completed/cancelled contracts, and repaid/defaulted/rejected loans.",
  },
  {
    name: "aeros-archive-market",
    datasets: ["settled_market_orders", "old_market_candles"],
    description:
      "Permanent historical archive for Aeros Pay settled synthetic market orders (BUY/SELL/SHORT/COVER) and historical OHLCV market candles (>48h old).",
  },
  {
    name: "aeros-archive-economy",
    datasets: ["completed_marketplace_orders", "settled_company_sales"],
    description:
      "Permanent historical archive for Aeros Pay completed goods marketplace orders and settled/cancelled/rejected company acquisition sales.",
  },
  {
    name: "aeros-archive-audit",
    datasets: ["historical_audit_logs"],
    description:
      "Permanent historical archive for Aeros Pay Government administrative audit trail logs.",
  },
];

const schemaDoc = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AerosPayGithubArchiveBatchManifestV4.1",
  version: "4.1.0",
  type: "object",
  required: [
    "schemaVersion",
    "application",
    "batchNumber",
    "datasetKey",
    "repoKey",
    "repoName",
    "shardGeneration",
    "recordCount",
    "sha256Jsonl",
    "verificationToken",
    "createdAt",
  ],
  properties: {
    schemaVersion: { type: "string", const: "4.1.0" },
    application: { type: "string", const: "Aeros Pay" },
    batchNumber: { type: "string" },
    datasetKey: { type: "string" },
    repoKey: { type: "string" },
    repoName: { type: "string" },
    shardGeneration: { type: "integer", minimum: 1 },
    recordCount: { type: "integer", minimum: 0 },
    sha256Jsonl: { type: "string", pattern: "^[a-f0-9]{64}$" },
    verificationToken: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

for (const repo of repos) {
  const baseDir = path.join(process.cwd(), "github-repos-bootstrap", repo.name);
  fs.mkdirSync(path.join(baseDir, "schema"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "index"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "batches"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "manifests"), { recursive: true });

  const readme = `# ${repo.name}

${repo.description}

## Architecture & Safety Rules

- **Managed by**: Aeros Pay V4.1 Automated 24-Hour Archival Engine
- **Mapped Datasets**: ${repo.datasets.map((d) => "`" + d + "`").join(", ")}
- **Directory Layout**:
  - \`schema/archive-schema-v4.1.json\`: JSON schema for batch manifests
  - \`index/catalog.json\`: Root repository metadata
  - \`index/<datasetKey>/<YYYY-MM>.json\`: Monthly batch lookup index
  - \`batches/<datasetKey>/<YYYY>/<MM>/<DD>/<batchNumber>.jsonl\`: Deterministic newline-delimited JSON records
  - \`manifests/<datasetKey>/<YYYY>/<MM>/<batchNumber>.manifest.json\`: Cryptographic SHA-256 manifest & accounting snapshot
- **Security**: Never store passwords, session tokens, or API keys in this repository. All records are sanitized by \`sanitizeRecordForArchive()\` prior to upload.
- **Shard Rotation**: Soft warning at 400 MB; automatic shard rotation to \`${repo.name}-002\` at 750 MB.
`;

  fs.writeFileSync(path.join(baseDir, "README.md"), readme, "utf8");
  fs.writeFileSync(
    path.join(baseDir, "schema", "archive-schema-v4.1.json"),
    JSON.stringify(schemaDoc, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(baseDir, "index", "catalog.json"),
    JSON.stringify(
      {
        schemaVersion: "4.1.0",
        repository: repo.name,
        shardGeneration: 1,
        datasets: repo.datasets,
        initializedAt: "2026-04-20T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(baseDir, "batches", ".gitkeep"), "", "utf8");
  fs.writeFileSync(path.join(baseDir, "manifests", ".gitkeep"), "", "utf8");
}

console.log("Successfully generated bootstrap files for all 5 GitHub archive repositories.");
