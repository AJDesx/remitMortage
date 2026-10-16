"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useId, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { LifeBuoy, Search } from "lucide-react";
import { HELP_ARTICLES, searchArticles, type HelpCategory } from "@/lib/help-articles";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

const CATEGORY_ORDER: HelpCategory[] = ["Borrowing", "Verification", "Contractor", "Admin"];

export default function HelpCenterPage() {
  const [query, setQuery] = useState("");
  const searchInputId = useId();

  const results = useMemo(() => searchArticles(query), [query]);

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      articles: HELP_ARTICLES.filter((article) => article.category === category),
    })).filter((group) => group.articles.length > 0);
  }, []);

  const searching = query.trim().length > 0;

  return (
    <main data-testid="help-center-page" className="min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <div className="pt-32 px-6 max-w-4xl mx-auto">
        <header className="mb-10">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-cyan-500/20">
            <LifeBuoy className="w-3.5 h-3.5" aria-hidden="true" />
            Help Center
          </span>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white mb-3">
            How can we help?
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-2xl">
            Search our guides for borrowing, verification, contractor payouts, and admin reviews.
          </p>
        </header>

        {/* Search */}
        <div className="mb-8">
          <label htmlFor={searchInputId} className="sr-only">
            Search help articles
          </label>
          <div className="relative">
            <Search
              className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500"
              aria-hidden="true"
            />
            <input
              id={searchInputId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='Search articles… e.g. "payout setup" or "rejected application"'
              className="w-full bg-[#0b0f1d] border border-slate-700 rounded-xl pl-12 pr-4 py-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
              autoComplete="off"
            />
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {searching
              ? `${results.length} ${results.length === 1 ? "article" : "articles"} found for ${query.trim()}.`
              : ""}
          </p>
        </div>

        {/* Results */}
        {searching ? (
          <section aria-label="Search results">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">
              {results.length} {results.length === 1 ? "result" : "results"} for &ldquo;
              {query.trim()}&rdquo;
            </h2>
            {results.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-[#0b0f1d] p-8 text-center">
                <p className="text-slate-300 font-medium mb-1">No articles matched your search</p>
                <p className="text-sm text-slate-500">
                  Try different keywords, or browse all articles below.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {results.map(({ article }) => (
                  <li key={article.slug}>
                    <Link
                      href={`/help/articles/${article.slug}`}
                      className="block rounded-xl border border-slate-700 bg-[#0b0f1d] p-5 hover:border-cyan-500/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                          {article.category}
                        </span>
                      </div>
                      <h3 className="text-white font-semibold mb-1">{article.title}</h3>
                      <p className="text-sm text-slate-400">{article.summary}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          /* Browse by category */
          grouped.map(({ category, articles }) => (
            <section key={category} aria-label={`${category} articles`} className="mb-10">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">
                {category}
              </h2>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {articles.map((article) => (
                  <li key={article.slug}>
                    <Link
                      href={`/help/articles/${article.slug}`}
                      className="block h-full rounded-xl border border-slate-700 bg-[#0b0f1d] p-5 hover:border-cyan-500/50 transition-colors"
                    >
                      <h3 className="text-white font-semibold mb-1">{article.title}</h3>
                      <p className="text-sm text-slate-400">{article.summary}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </main>
  );
}
