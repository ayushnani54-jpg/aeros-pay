import { getActingContext, getCurrentGovernment } from "@/lib/auth";
import { getPublicMediaFeed } from "@/lib/media";
import { MEDIA_RETENTION_DAYS } from "@/lib/constants";
import {
  AerosMediaFeedClient,
  type SerializedMediaPost,
} from "@/components/v5/aeros-media-feed";

export default async function AerosMediaPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const [feedRows, gov] = await Promise.all([
    getPublicMediaFeed({
      currentUserId: ctx.user.id,
      limit: 60,
    }).catch(() => []),
    getCurrentGovernment().catch(() => null),
  ]);

  const retentionMs = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const serializedPosts: SerializedMediaPost[] = feedRows.map((r) => ({
    id: r.post.id,
    postNumber: r.post.postNumber,
    authorId: r.post.authorId,
    authorUsername: r.authorUsername,
    authorDisplayName: r.authorDisplayName,
    isOfficialGov: r.isOfficialGov,
    content: r.post.content,
    moderationStatus: r.post.moderationStatus,
    moderatorReason: r.post.moderatorReason,
    likesCount: r.post.likesCount,
    commentsCount: r.post.commentsCount,
    sharesCount: r.post.sharesCount,
    likedByMe: r.likedByMe,
    mentions: r.mentions,
    createdAt: r.post.createdAt.toISOString(),
    expiresAt: new Date(r.post.createdAt.getTime() + retentionMs).toISOString(),
    comments: r.comments.map((c) => ({
      id: c.comment.id,
      authorUsername: c.authorUsername,
      authorDisplayName: c.authorDisplayName,
      content: c.comment.content,
      createdAt: c.comment.createdAt.toISOString(),
    })),
  }));

  return (
    <AerosMediaFeedClient
      posts={serializedPosts}
      currentUsername={ctx.user.username}
      canModerate={Boolean(gov) || Boolean(ctx.user.isOfficialGovernmentUser)}
    />
  );
}

