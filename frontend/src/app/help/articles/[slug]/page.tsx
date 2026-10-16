"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { ArrowLeft, ThumbsDown, ThumbsUp } from "lucide-react";
import { findHelpArticle, HELP_ARTICLES } from "@/lib/help-articles";
import { renderMarkdown } from "@/lib/markdown";

const Navbar = dynamic(() => import("../../../../components/Navbar"), { ssr: false });

type Rating = "helpful" | "not-helpful";

function ratingStorageKey(slug: string): string {
  return `help-article-rating:${slug}`;
}

export default function HelpArticlePage() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const article = findHelpArticle(slug);

  const [rating, setRating] = useState<Rating | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // ratings persist in localStorage so the control reflects prior feedback
  useEffect(() => {
    if (!article) return;
    try {
      const stored = window.localStorage.getItem(ratingStorageKey(article.slug));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a persisted preference on mount
      if (stored === "helpful" || stored === "not-helpful") setRating(stored);
    } catch {
      // storage unavailable (private mode) — keep in-memory only
    }
  }, [article]);

  if (!article) {
    return (
      <main data-testid="help-article-page" className="min-h-screen bg-[#060913] text-slate-100 pb-20">
        <Navbar />
        <div className="pt-32 px-6 max-w-3xl mx-auto text-center">
          <h1 className="text-3xl font-extrabold text-white mb-3">Article not found</h1>
          <p className="text-slate-400 mb-6">
            The help article you are looking for does not exist or has been moved.
          </p>
          <Link href="/help" className="text-cyan-400 underline underline-offset-2">
            Browse all help articles
          </Link>
        </div>
      </main>
    );
  }

  const related = HELP_ARTICLES.filter(
    (candidate) => candidate.category === article.category && candidate.slug !== article.slug
  );

  function rate(next: Rating) {
    setRating(next);
    setAnnouncement(
      next === "helpful"
        ? "Thanks for your feedback! Glad this article helped."
        : "Thanks for your feedback. We will keep improving this article."
    );
    try {
      window.localStorage.setItem(ratingStorageKey(article!.slug), next);
    } catch {
      // ignore storage failures
    }
  }

  return (
    <main data-testid="help-article-page" className="min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <article className="pt-32 px-6 max-w-3xl mx-auto">
        <nav aria-label="Breadcrumb" className="mb-6">
          <Link
            href="/help"
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-cyan-400 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            All help articles
          </Link>
        </nav>

        <header className="mb-8 border-b border-slate-800 pb-6">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
            {article.category}
          </span>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mt-2">
            {article.title}
          </h1>
          <p className="text-slate-400 mt-3">{article.summary}</p>
        </header>

        {/* Article body (Markdown rendered; source is escaped before markup) */}
        <div
          className="help-article-body space-y-4 text-slate-300 text-sm leading-relaxed [&_a]:text-cyan-400 [&_a]:underline [&_a]:underline-offset-2 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-white [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-white [&_code]:bg-slate-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-cyan-300 [&_pre]:bg-slate-900 [&_pre]:border [&_pre]:border-slate-800 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:overflow-x-auto [&_blockquote]:border-l-2 [&_blockquote]:border-cyan-500/50 [&_blockquote]:pl-4 [&_blockquote]:text-slate-400 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(article.body) }}
        />

        {/* Rating */}
        <section
          aria-label="Rate this article"
          className="mt-10 rounded-xl border border-slate-700 bg-[#0b0f1d] p-6"
        >
          <h2 className="text-white font-semibold mb-1">Was this article helpful?</h2>
          <p className="text-sm text-slate-400 mb-4">
            Your feedback helps us improve the Help Center.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => rate("helpful")}
              aria-pressed={rating === "helpful"}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                rating === "helpful"
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                  : "bg-slate-800/60 text-slate-300 border-slate-700 hover:border-emerald-500/40"
              }`}
            >
              <ThumbsUp className="w-4 h-4" aria-hidden="true" />
              Yes, helpful
            </button>
            <button
              type="button"
              onClick={() => rate("not-helpful")}
              aria-pressed={rating === "not-helpful"}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                rating === "not-helpful"
                  ? "bg-red-500/15 text-red-400 border-red-500/40"
                  : "bg-slate-800/60 text-slate-300 border-slate-700 hover:border-red-500/40"
              }`}
            >
              <ThumbsDown className="w-4 h-4" aria-hidden="true" />
              Not really
            </button>
          </div>
          <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-400 min-h-[1.25rem]">
            {announcement}
          </p>
        </section>

        {/* Related articles */}
        {related.length > 0 && (
          <nav aria-label="Related articles" className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">
              Related articles
            </h2>
            <ul className="space-y-2">
              {related.map((candidate) => (
                <li key={candidate.slug}>
                  <Link
                    href={`/help/articles/${candidate.slug}`}
                    className="block rounded-lg border border-slate-700 bg-[#0b0f1d] p-4 hover:border-cyan-500/50 transition-colors"
                  >
                    <span className="text-white font-medium">{candidate.title}</span>
                    <span className="block text-sm text-slate-400 mt-0.5">
                      {candidate.summary}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </article>
    </main>
  );
}
