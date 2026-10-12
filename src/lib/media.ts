import "server-only";
import { db } from "@/db/client";
import {
  mediaComments,
  mediaLikes,
  mediaPosts,
  mediaShares,
  users,
  type MediaComment,
  type MediaPost,
} from "@/db/schema";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { canUserSend } from "./status";
import {
  MEDIA_COMMENT_MAX_LENGTH,
  MEDIA_POST_MAX_LENGTH,
  MEDIA_RETENTION_DAYS,
} from "./constants";

/**
 * AEROS PAY V5 — AEROS MEDIA (TEXT-ONLY SOCIAL PLATFORM)
 * ======================================================
 * - Strictly text-only (no image uploads).
 * - Public retention: 7 days (`MEDIA_RETENTION_DAYS = 7`), enforced server-side.
 * - Expired posts (> 7 days old) are excluded from the live public feed and
 *   become eligible for permanent archival in `aeros-archive-media` on GitHub.
 * - Transparent Government moderation (`ACTIVE`, `FLAGGED`, `MODERATED_HIDDEN`).
 */

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export function extractMentions(content: string): string[] {
  const regex = /@([a-zA-Z0-9_]{3,24})/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    found.add(match[1].toLowerCase());
  }
  return Array.from(found);
}

export function isMediaPostExpired(createdAt: Date, now: Date = new Date()): boolean {
  const retentionMs = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - createdAt.getTime() >= retentionMs;
}

export async function createMediaPost(params: {
  userId: string;
  content: string;
}): Promise<MediaPost> {
  const trimmed = params.content.trim();
  if (!trimmed || trimmed.length > MEDIA_POST_MAX_LENGTH) {
    throw new MediaError(`Post must be between 1 and ${MEDIA_POST_MAX_LENGTH} characters.`);
  }

  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, params.userId));
    if (!user || !canUserSend(user)) {
      throw new MediaError("Your account is not eligible to post on Aeros Media.");
    }

    const postNumber = `MED-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 899)}`;

    const [created] = await tx
      .insert(mediaPosts)
      .values({
        postNumber,
        authorId: user.id,
        content: trimmed,
        moderationStatus: "ACTIVE",
      })
      .returning();

    return created;
  });
}

export async function toggleMediaLike(params: {
  postId: string;
  userId: string;
}): Promise<{ liked: boolean; likesCount: number }> {
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select()
      .from(mediaPosts)
      .where(eq(mediaPosts.id, params.postId))
      .for("update");
    if (!post || post.moderationStatus === "MODERATED_HIDDEN") {
      throw new MediaError("Post not found.");
    }

    const [existing] = await tx
      .select()
      .from(mediaLikes)
      .where(and(eq(mediaLikes.postId, post.id), eq(mediaLikes.userId, params.userId)))
      .limit(1);

    if (existing) {
      await tx.delete(mediaLikes).where(eq(mediaLikes.id, existing.id));
      const nextCount = Math.max(0, post.likesCount - 1);
      await tx
        .update(mediaPosts)
        .set({ likesCount: nextCount })
        .where(eq(mediaPosts.id, post.id));
      return { liked: false, likesCount: nextCount };
    } else {
      await tx.insert(mediaLikes).values({
        postId: post.id,
        userId: params.userId,
      });
      const nextCount = post.likesCount + 1;
      await tx
        .update(mediaPosts)
        .set({ likesCount: nextCount })
        .where(eq(mediaPosts.id, post.id));
      return { liked: true, likesCount: nextCount };
    }
  });
}

export async function createMediaComment(params: {
  postId: string;
  userId: string;
  content: string;
}): Promise<MediaComment> {
  const trimmed = params.content.trim();
  if (!trimmed || trimmed.length > MEDIA_COMMENT_MAX_LENGTH) {
    throw new MediaError(`Comment must be between 1 and ${MEDIA_COMMENT_MAX_LENGTH} characters.`);
  }

  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, params.userId));
    if (!user || !canUserSend(user)) {
      throw new MediaError("Your account cannot comment.");
    }

    const [post] = await tx
      .select()
      .from(mediaPosts)
      .where(eq(mediaPosts.id, params.postId))
      .for("update");
    if (!post || post.moderationStatus === "MODERATED_HIDDEN") {
      throw new MediaError("Post not found.");
    }

    const [comment] = await tx
      .insert(mediaComments)
      .values({
        postId: post.id,
        authorId: user.id,
        content: trimmed,
      })
      .returning();

    await tx
      .update(mediaPosts)
      .set({ commentsCount: post.commentsCount + 1 })
      .where(eq(mediaPosts.id, post.id));

    return comment;
  });
}

export async function shareMediaPost(params: {
  postId: string;
  userId: string;
}): Promise<{ sharesCount: number }> {
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select()
      .from(mediaPosts)
      .where(eq(mediaPosts.id, params.postId))
      .for("update");
    if (!post || post.moderationStatus === "MODERATED_HIDDEN") {
      throw new MediaError("Post not found.");
    }

    await tx.insert(mediaShares).values({
      postId: post.id,
      userId: params.userId,
    });

    const nextShares = post.sharesCount + 1;
    await tx
      .update(mediaPosts)
      .set({ sharesCount: nextShares })
      .where(eq(mediaPosts.id, post.id));

    return { sharesCount: nextShares };
  });
}

export async function moderateMediaPost(params: {
  postId: string;
  action: "FLAG" | "HIDE" | "RESTORE";
  reason?: string;
  govId: string;
  govUsername: string;
}): Promise<MediaPost> {
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select()
      .from(mediaPosts)
      .where(eq(mediaPosts.id, params.postId))
      .for("update");
    if (!post) throw new MediaError("Post not found.");

    const nextStatus =
      params.action === "HIDE"
        ? "MODERATED_HIDDEN"
        : params.action === "FLAG"
          ? "FLAGGED"
          : "ACTIVE";

    const [updated] = await tx
      .update(mediaPosts)
      .set({
        moderationStatus: nextStatus,
        moderatorReason: params.reason?.trim() || null,
        moderatedAt: new Date(),
      })
      .where(eq(mediaPosts.id, post.id))
      .returning();

    await recordAudit(tx, {
      action: `MEDIA_POST_${params.action}`,
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "MEDIA_POST",
      targetId: post.id,
      previousValue: post.moderationStatus,
      newValue: `${nextStatus}${params.reason ? ` (${params.reason})` : ""}`,
    });

    return updated;
  });
}

/**
 * Server-side 7-day public feed query.
 * Automatically marks posts older than 7 days as `isExpired = true` and excludes
 * expired or hidden posts from the public feed.
 */
export async function getPublicMediaFeed(params: {
  currentUserId?: string | null;
  authorId?: string | null;
  includeModeratedForGov?: boolean;
  limit?: number;
}): Promise<
  Array<{
    post: MediaPost;
    authorUsername: string;
    authorDisplayName: string;
    isOfficialGov: boolean;
    likedByMe: boolean;
    mentions: string[];
    comments: Array<{
      comment: MediaComment;
      authorUsername: string;
      authorDisplayName: string;
    }>;
  }>
> {
  const cutoff = new Date(Date.now() - MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Enforce server-side 7-day expiry
  await db
    .update(mediaPosts)
    .set({ isExpired: true })
    .where(and(eq(mediaPosts.isExpired, false), lt(mediaPosts.createdAt, cutoff)));

  const conds = [];
  if (!params.includeModeratedForGov) {
    conds.push(eq(mediaPosts.isExpired, false));
    conds.push(gte(mediaPosts.createdAt, cutoff));
    conds.push(sql`${mediaPosts.moderationStatus} <> 'MODERATED_HIDDEN'`);
  }
  if (params.authorId) {
    conds.push(eq(mediaPosts.authorId, params.authorId));
  }

  const rows = await db
    .select({
      post: mediaPosts,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
      isOfficialGov: users.isOfficialGovernmentUser,
    })
    .from(mediaPosts)
    .innerJoin(users, eq(users.id, mediaPosts.authorId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(mediaPosts.createdAt))
    .limit(params.limit ?? 50);

  const out = [];
  for (const r of rows) {
    let likedByMe = false;
    if (params.currentUserId) {
      const [likeRow] = await db
        .select({ id: mediaLikes.id })
        .from(mediaLikes)
        .where(
          and(
            eq(mediaLikes.postId, r.post.id),
            eq(mediaLikes.userId, params.currentUserId),
          ),
        )
        .limit(1);
      likedByMe = Boolean(likeRow);
    }

    const commentRows = await db
      .select({
        comment: mediaComments,
        authorUsername: users.username,
        authorDisplayName: users.displayName,
      })
      .from(mediaComments)
      .innerJoin(users, eq(users.id, mediaComments.authorId))
      .where(eq(mediaComments.postId, r.post.id))
      .orderBy(desc(mediaComments.createdAt))
      .limit(10);

    out.push({
      ...r,
      likedByMe,
      mentions: extractMentions(r.post.content),
      comments: commentRows.reverse(),
    });
  }

  return out;
}

/**
 * Marks posts older than 7 days (`MEDIA_RETENTION_DAYS`) as expired so they no longer
 * appear on the public feed and become eligible for GitHub archival in `aeros-archive-media`.
 */
export async function cleanupExpiredMediaPosts(): Promise<number> {
  const cutoff = new Date(Date.now() - MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const updated = await db
    .update(mediaPosts)
    .set({ isExpired: true })
    .where(and(eq(mediaPosts.isExpired, false), lt(mediaPosts.createdAt, cutoff)))
    .returning({ id: mediaPosts.id });
  return updated.length;
}

