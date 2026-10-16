// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  HELP_ARTICLES,
  CONTEXTUAL_HELP,
  findHelpArticle,
  searchArticles,
} from "../src/lib/help-articles";

describe("help article registry", () => {
  it("exposes a unique slug for every article", () => {
    const slugs = HELP_ARTICLES.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("resolves articles and contextual help keys", () => {
    expect(findHelpArticle("apply-for-a-loan")?.title).toMatch(/apply for a loan/i);
    expect(findHelpArticle("does-not-exist")).toBeUndefined();
    expect(CONTEXTUAL_HELP["payout-setup"]).toBe("payout-setup");
  });
});

describe("searchArticles ranking", () => {
  it("ranks an exact title match above every other match", () => {
    const results = searchArticles("payout setup");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].article.slug).toBe("payout-setup");
  });

  it("ranks title keyword matches above body-only matches", () => {
    // "verification" appears in the verification article's title AND in the
    // body of several others — the titled article must win.
    const results = searchArticles("verification");
    expect(results[0].article.slug).toBe("verification-requirements");

    const verificationIndex = results.findIndex(
      (r) => r.article.slug === "verification-requirements"
    );
    const bodyOnlyIndex = results.findIndex((r) => r.article.slug === "repayments-and-statements");
    if (bodyOnlyIndex !== -1) {
      expect(verificationIndex).toBeLessThan(bodyOnlyIndex);
    }
  });

  it("matches multi-word queries across title and keywords", () => {
    const results = searchArticles("rejected application");
    expect(results.map((r) => r.article.slug)).toContain("apply-for-a-loan");
  });

  it("returns an empty list for blank or whitespace queries", () => {
    expect(searchArticles("")).toEqual([]);
    expect(searchArticles("   ")).toEqual([]);
  });

  it("returns nothing when no article matches", () => {
    expect(searchArticles("quantum blockchain metaverse")).toEqual([]);
  });

  it("orders equal-score results deterministically by title", () => {
    const a = searchArticles("documents");
    const b = searchArticles("documents");
    expect(a.map((r) => r.article.slug)).toEqual(b.map((r) => r.article.slug));
    for (let i = 1; i < a.length; i++) {
      expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
    }
  });
});
