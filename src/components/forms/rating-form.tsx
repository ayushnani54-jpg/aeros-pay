"use client";

import { useActionState, useState } from "react";
import { rateOrderAction } from "@/actions/marketplace";
import { RATING_COMMENT_MAX_LENGTH } from "@/lib/constants";
import { VoiceInput } from "./voice-input";

/**
 * "Rate this order" (V3 Phase F, spec §22).
 *
 * Same shape as every other form here: a `.card`, the existing `.input` and
 * `.btn` classes, `useActionState` for the pending state, the server's message
 * rendered verbatim.
 *
 * The form is only RENDERED for the buyer of a completed order, but that is
 * cosmetic: `rateOrderAction` re-derives the buyer, the order's state and the
 * "once only" rule server-side, so reaching this form by any other route still
 * gets refused (and the one-rating-per-order rule is a unique index in
 * Postgres underneath that).
 *
 * The comment is explicitly labelled as temporary, because it is: the star
 * stays forever, the comment is cleared after 30 days.
 */
export function RateOrderForm({
  orderId,
  sellerName,
  commentRetentionDays,
}: {
  orderId: string;
  sellerName: string;
  commentRetentionDays: number;
}) {
  const [state, formAction, pending] = useActionState(rateOrderAction, null);
  const [stars, setStars] = useState(0);

  if (state?.ok) {
    return (
      <section className="card p-5" data-testid="rating-saved">
        <h2 className="font-medium text-success">Thanks — your rating is saved.</h2>
        <p className="mt-1 text-sm text-muted">
          It now counts towards {sellerName}&rsquo;s public rating.
        </p>
      </section>
    );
  }

  return (
    <form action={formAction} className="card space-y-3 p-5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="stars" value={stars} />

      <div>
        <h2 className="font-medium">Rate this order</h2>
        <p className="mt-1 text-sm text-muted">
          How did {sellerName} do? One rating per order, and only you can leave it.
        </p>
      </div>

      <div>
        <span className="mb-1 block text-sm font-medium">Stars</span>
        <div className="flex items-center gap-1" role="group" aria-label="Choose a star rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setStars(n)}
              aria-pressed={stars === n}
              aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
              data-testid={`rate-star-${n}`}
              className="rounded-md p-1 hover:bg-surface"
            >
              <svg
                width={26}
                height={26}
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill={n <= stars ? "#111111" : "none"}
                stroke={n <= stars ? "#111111" : "#9a9a9a"}
                strokeWidth="1.8"
              >
                <path
                  d="M12 3.5l2.6 5.6 6.1.8-4.4 4.2 1.1 6.1L12 17.4l-5.4 2.8 1.1-6.1L3.3 9.9l6.1-.8z"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
          {stars > 0 && (
            <span className="ml-2 text-sm text-muted">
              {stars} of 5
            </span>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="ratingComment" className="mb-1 block text-sm font-medium">
          Comment (optional)
        </label>
        <textarea
          id="ratingComment"
          name="comment"
          className="input"
          rows={3}
          maxLength={RATING_COMMENT_MAX_LENGTH}
          placeholder="What was good, what could be better?"
        />
        <VoiceInput targetId="ratingComment" />
        <p className="mt-1 text-xs text-muted">
          Comments are removed after {commentRetentionDays} days. Your star stays.
        </p>
      </div>

      {state && !state.ok && (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending || stars === 0}>
        {pending ? "Saving…" : "Submit rating"}
      </button>
    </form>
  );
}
