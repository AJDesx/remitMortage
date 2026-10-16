"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { contextualHelpSlug, findHelpArticle } from "@/lib/help-articles";

/**
 * Contextual help link. Embeds a deep link to the Help Center article that
 * explains the surrounding flow (loan application, verification, document
 * upload, payout setup, admin review, …).
 *
 * Renders nothing when the context key is unknown or the linked article has
 * been removed, so flows degrade silently.
 */
export default function HelpLink({
  context,
  className = "",
}: {
  /** Contextual help key, e.g. "loan-application" or "payout-setup". */
  context: string;
  className?: string;
}) {
  const slug = contextualHelpSlug(context);
  if (!slug) return null;
  const article = findHelpArticle(slug);
  if (!article) return null;

  return (
    <Link
      href={`/help/articles/${article.slug}`}
      className={`inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300 underline underline-offset-2 transition-colors ${className}`}
    >
      <CircleHelp className="w-3.5 h-3.5" aria-hidden="true" />
      Need help? Read &ldquo;{article.title}&rdquo;
    </Link>
  );
}
