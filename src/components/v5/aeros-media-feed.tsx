"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  createMediaPostAction,
  toggleMediaLikeAction,
  createMediaCommentAction,
  recordMediaShareAction,
  moderateMediaPostAction,
} from "@/actions/v5";
import { V5ActionForm } from "./action-feedback";
import {
  MEDIA_COMMENT_MAX_LENGTH,
  MEDIA_POST_MAX_LENGTH,
  MEDIA_RETENTION_DAYS,
} from "@/lib/constants";

export interface SerializedMediaComment {
  id: string;
  authorUsername: string;
  authorDisplayName: string;
  content: string;
  createdAt: string;
}

export interface SerializedMediaPost {
  id: string;
  postNumber: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  isOfficialGov: boolean;
  content: string;
  moderationStatus: "ACTIVE" | "FLAGGED" | "MODERATED_HIDDEN";
  moderatorReason: string | null;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  likedByMe: boolean;
  mentions: string[];
  comments: SerializedMediaComment[];
  createdAt: string;
  expiresAt: string;
}

function formatMediaTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderContentWithMentions(content: string) {
  const parts = content.split(/(@[a-zA-Z0-9_]{3,24})/g);
  return parts.map((part, idx) => {
    if (/^@[a-zA-Z0-9_]{3,24}$/.test(part)) {
      const handle = part.slice(1).toLowerCase();
      return (
        <Link
          key={idx}
          href={`/u/${handle}`}
          className="rounded bg-violet-100 px-1 py-0.5 font-mono text-xs font-semibold text-violet-900 hover:underline"
        >
          {part}
        </Link>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export function AerosMediaFeedClient({
  posts,
  currentUsername,
  canModerate = false,
}: {
  posts: SerializedMediaPost[];
  currentUsername: string;
  canModerate?: boolean;
}) {
  const [postText, setPostText] = useState("");
  const [openCommentsId, setOpenCommentsId] = useState<string | null>(null);
  const [filterMention, setFilterMention] = useState<string>("");

  const filteredPosts = filterMention
    ? posts.filter(
        (p) =>
          p.mentions.includes(filterMention.toLowerCase().replace(/^@/, "")) ||
          p.authorUsername.toLowerCase().includes(filterMention.toLowerCase().replace(/^@/, "")),
      )
    : posts;

  return (
    <div className="space-y-5">
      {/* Aeros Media Coordinated Header Banner */}
      <div className="theme-media-banner rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-violet-400/25 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-violet-100">
                Aeros Media · Text-Only Network
              </span>
              <span className="rounded bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white/95">
                {MEDIA_RETENTION_DAYS}-Day Public Feed Retention
              </span>
              <span className="rounded bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white/95">
                Archived to aeros-archive-media
              </span>
            </div>
            <h1 className="mt-1.5 text-xl font-semibold sm:text-2xl">
              Aeros Media — Community Updates &amp; Economic Discourse
            </h1>
            <p className="mt-0.5 text-xs text-violet-100/85">
              Share text updates, tag citizens with <code className="font-mono">@username</code>,
              discuss market movements, and tip creators directly in whole Aeros. Public posts
              remain live for {MEDIA_RETENTION_DAYS} days before permanent GitHub archival.
            </p>
          </div>
        </div>
      </div>

      {/* Compose New Text-Only Post Card */}
      <div className="card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Publish Text Post as @{currentUsername}
          </h2>
          <span className="text-[11px] text-muted">
            Text-only (no images) · {postText.length}/{MEDIA_POST_MAX_LENGTH}
          </span>
        </div>

        <V5ActionForm
          action={createMediaPostAction}
          operationKey="create-media-post"
          operationTitle="Publishing Aeros Media Post"
          processingDetail="Validating text-only post and indexing @mentions..."
          className="mt-2.5 space-y-3"
          onSuccessReset
        >
          {(pending) => (
            <>
              <textarea
                name="content"
                rows={3}
                maxLength={MEDIA_POST_MAX_LENGTH}
                required
                value={postText}
                onChange={(e) => setPostText(e.target.value)}
                placeholder="What is happening in the Aeros economy? Tag citizens using @username..."
                className="input text-sm"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted">
                  Posts automatically expire from the live public feed after {MEDIA_RETENTION_DAYS}{" "}
                  days.
                </span>
                <button
                  type="submit"
                  disabled={pending || postText.trim().length === 0}
                  onClick={() => {
                    setTimeout(() => setPostText(""), 150);
                  }}
                  className="btn btn-primary text-xs"
                >
                  {pending ? "Publishing..." : "Publish Post"}
                </button>
              </div>
            </>
          )}
        </V5ActionForm>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            value={filterMention}
            onChange={(e) => setFilterMention(e.target.value)}
            placeholder="Filter by @username or mention..."
            className="input max-w-xs py-1.5 text-xs"
          />
          {filterMention && (
            <button
              type="button"
              onClick={() => setFilterMention("")}
              className="btn btn-secondary py-1.5 text-xs"
            >
              Clear
            </button>
          )}
        </div>
        <span className="text-xs text-muted">
          Showing {filteredPosts.length} live post{filteredPosts.length === 1 ? "" : "s"} (last{" "}
          {MEDIA_RETENTION_DAYS} days)
        </span>
      </div>

      {/* Live Feed */}
      {filteredPosts.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No live posts in the last {MEDIA_RETENTION_DAYS} days match your view. Publish the first
          update above!
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredPosts.map((post) => {
            const commentsOpen = openCommentsId === post.id;

            return (
              <article key={post.id} className="card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/u/${post.authorUsername}`}
                      className="font-semibold hover:underline"
                    >
                      {post.authorDisplayName}
                    </Link>
                    <Link
                      href={`/u/${post.authorUsername}`}
                      className="font-mono text-xs text-muted hover:underline"
                    >
                      @{post.authorUsername}
                    </Link>
                    {post.isOfficialGov && (
                      <span className="rounded bg-black px-2 py-0.5 text-[10px] font-bold text-white">
                        OFFICIAL GOV
                      </span>
                    )}
                    {post.moderationStatus === "FLAGGED" && (
                      <span className="badge badge-suspended text-[10px]">
                        FLAGGED: {post.moderatorReason || "Under review"}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <time dateTime={post.createdAt} title={post.postNumber}>
                      {formatMediaTimestamp(post.createdAt)}
                    </time>
                    <span>·</span>
                    <Link
                      href={`/pay?to=${post.authorUsername}`}
                      className="rounded border border-border bg-surface px-2 py-0.5 font-semibold text-foreground hover:bg-black hover:text-white"
                    >
                      Send Aeros →
                    </Link>
                  </div>
                </div>

                {/* Post Content with clickable @mentions */}
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
                  {renderContentWithMentions(post.content)}
                </p>

                {/* Interaction Bar: Like, Comment, Share, Expiry */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <V5ActionForm
                      action={toggleMediaLikeAction}
                      operationKey={`like-${post.id}`}
                      operationTitle="Updating Like"
                      className="inline-block"
                    >
                      {(pending) => (
                        <>
                          <input type="hidden" name="postId" value={post.id} />
                          <button
                            type="submit"
                            disabled={pending}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                              post.likedByMe
                                ? "border-violet-700 bg-violet-700 text-white"
                                : "border-border bg-surface text-foreground hover:border-black"
                            }`}
                          >
                            ♥ {post.likesCount}
                          </button>
                        </>
                      )}
                    </V5ActionForm>

                    <button
                      type="button"
                      onClick={() => setOpenCommentsId(commentsOpen ? null : post.id)}
                      className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold hover:border-black"
                    >
                      💬 {post.commentsCount} Comment{post.commentsCount === 1 ? "" : "s"}
                    </button>

                    <V5ActionForm
                      action={recordMediaShareAction}
                      operationKey={`share-${post.id}`}
                      operationTitle="Sharing Post"
                      className="inline-block"
                    >
                      {(pending) => (
                        <>
                          <input type="hidden" name="postId" value={post.id} />
                          <button
                            type="submit"
                            disabled={pending}
                            className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold hover:border-black"
                          >
                            ↻ Share ({post.sharesCount})
                          </button>
                        </>
                      )}
                    </V5ActionForm>
                  </div>

                  <span className="text-[11px] text-muted">
                    7d public window · Expires {new Date(post.expiresAt).toLocaleDateString()}
                  </span>
                </div>

                {/* Expandable Comments Section */}
                {commentsOpen && (
                  <div className="mt-3 space-y-2.5 rounded-xl bg-surface p-3 text-xs">
                    {post.comments.length === 0 ? (
                      <p className="text-muted">No comments yet. Start the conversation below.</p>
                    ) : (
                      <div className="space-y-2 divide-y divide-border/60">
                        {post.comments.map((c) => (
                          <div key={c.id} className="pt-2 first:pt-0">
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex items-center gap-1.5">
                                <Link
                                  href={`/u/${c.authorUsername}`}
                                  className="font-semibold hover:underline"
                                >
                                  {c.authorDisplayName}
                                </Link>
                                <span className="font-mono text-[11px] text-muted">
                                  @{c.authorUsername}
                                </span>
                              </div>
                              <time dateTime={c.createdAt} className="text-[11px] text-muted">
                                {formatMediaTimestamp(c.createdAt)}
                              </time>
                            </div>
                            <p className="mt-0.5 text-foreground">
                              {renderContentWithMentions(c.content)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    <V5ActionForm
                      action={createMediaCommentAction}
                      operationKey={`comment-${post.id}`}
                      operationTitle="Posting Comment"
                      className="flex gap-2 pt-2"
                      onSuccessReset
                    >
                      {(pending) => (
                        <>
                          <input type="hidden" name="postId" value={post.id} />
                          <input
                            name="content"
                            maxLength={MEDIA_COMMENT_MAX_LENGTH}
                            required
                            placeholder="Write a comment..."
                            className="input py-1.5 text-xs"
                          />
                          <button
                            type="submit"
                            disabled={pending}
                            className="btn btn-primary shrink-0 px-3 py-1.5 text-xs"
                          >
                            {pending ? "..." : "Reply"}
                          </button>
                        </>
                      )}
                    </V5ActionForm>
                  </div>
                )}

                {/* Optional Moderator Controls */}
                {canModerate && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-xs">
                    <span className="font-semibold text-muted">Gov Moderation:</span>
                    <V5ActionForm
                      action={moderateMediaPostAction}
                      operationKey={`mod-flag-${post.id}`}
                      operationTitle={`Flagging ${post.postNumber}`}
                      className="inline-flex gap-1"
                    >
                      {(pending) => (
                        <>
                          <input type="hidden" name="postId" value={post.id} />
                          <input type="hidden" name="action" value="FLAG" />
                          <input
                            type="hidden"
                            name="reason"
                            value="Community guideline notice"
                          />
                          <button
                            type="submit"
                            disabled={pending}
                            className="btn btn-secondary px-2 py-1 text-[11px]"
                          >
                            Flag
                          </button>
                        </>
                      )}
                    </V5ActionForm>
                    <V5ActionForm
                      action={moderateMediaPostAction}
                      operationKey={`mod-hide-${post.id}`}
                      operationTitle={`Hiding ${post.postNumber}`}
                      className="inline-flex gap-1"
                    >
                      {(pending) => (
                        <>
                          <input type="hidden" name="postId" value={post.id} />
                          <input type="hidden" name="action" value="HIDE" />
                          <input
                            type="hidden"
                            name="reason"
                            value="Removed by Government moderation"
                          />
                          <button
                            type="submit"
                            disabled={pending}
                            className="btn btn-danger px-2 py-1 text-[11px]"
                          >
                            Hide Post
                          </button>
                        </>
                      )}
                    </V5ActionForm>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

