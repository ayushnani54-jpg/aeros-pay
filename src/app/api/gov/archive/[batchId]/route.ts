import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { archiveBatches } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentGovernment } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { markArchiveBatchDownloaded, sha256Hex } from "@/lib/archive";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const gov = await getCurrentGovernment();
  if (!gov) {
    return NextResponse.json(
      { error: "Government authorization required." },
      { status: 401 },
    );
  }

  const { batchId } = await context.params;
  if (!batchId || !/^[0-9a-f-]{36}$/i.test(batchId)) {
    return NextResponse.json({ error: "Invalid archive batch ID." }, { status: 400 });
  }

  const [batch] = await db
    .select()
    .from(archiveBatches)
    .where(eq(archiveBatches.id, batchId))
    .limit(1);

  if (!batch) {
    return NextResponse.json({ error: "Archive batch not found." }, { status: 404 });
  }

  const zipBuffer = Buffer.from(batch.zipPayloadBase64, "base64");
  const actualSha256 = sha256Hex(zipBuffer);
  if (actualSha256 !== batch.sha256Checksum) {
    return NextResponse.json(
      { error: "Archive checksum verification failed." },
      { status: 500 },
    );
  }

  await markArchiveBatchDownloaded(batch.id);
  await recordAudit(db, {
    action: "ARCHIVE_BATCH_DOWNLOADED",
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    targetType: "ARCHIVE_BATCH",
    targetId: batch.id,
    metadata: {
      batchNumber: batch.batchNumber,
      datasetKey: batch.datasetKey,
      byteSize: zipBuffer.length,
      sha256Checksum: batch.sha256Checksum,
    },
  });

  const filename = `aeros-archive-${batch.batchNumber.toLowerCase()}-${batch.datasetKey}.zip`;

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBuffer.length),
      "Cache-Control": "no-store",
      "X-Archive-Batch": batch.batchNumber,
      "X-Archive-SHA256": batch.sha256Checksum,
      "X-Archive-Verification-Token": batch.verificationToken,
    },
  });
}
