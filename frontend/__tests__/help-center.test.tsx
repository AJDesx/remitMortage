// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/dynamic", () => () => () => null);
jest.mock("next/navigation", () => ({
  useParams: () => ({ slug: "payout-setup" }),
  usePathname: () => "/help",
}));

import HelpCenterPage from "../src/app/help/page";
import HelpArticlePage from "../src/app/help/articles/[slug]/page";
import HelpLink from "../src/components/help/HelpLink";
import ErrorSummary from "../src/components/forms/ErrorSummary";

describe("HelpCenterPage", () => {
  it("renders the search field and all articles grouped by category", () => {
    render(<HelpCenterPage />);
    expect(screen.getByTestId("help-center-page")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search help articles/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /how to apply for a loan/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /verification and kyc requirements/i })).toBeInTheDocument();
  });

  it("filters articles as the user types and announces the result count", () => {
    render(<HelpCenterPage />);
    const input = screen.getByRole("searchbox", { name: /search help articles/i });

    fireEvent.change(input, { target: { value: "payout setup" } });

    const results = screen.getByRole("link", { name: /setting up usdc payouts/i });
    expect(results).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /how the admin review process works/i })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/1 article found/i);
  });

  it("shows an empty state when nothing matches", () => {
    render(<HelpCenterPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "quantum blockchain metaverse" },
    });
    expect(screen.getByText(/no articles matched your search/i)).toBeInTheDocument();
  });
});

describe("HelpArticlePage", () => {
  it("renders the article body from Markdown", () => {
    render(<HelpArticlePage />);
    expect(screen.getByRole("heading", { name: /setting up usdc payouts/i })).toBeInTheDocument();
    // Markdown ordered list renders as <ol>
    expect(screen.getByText("Connect your payout wallet")).toBeInTheDocument();
    expect(document.querySelector(".help-article-body ol")).not.toBeNull();
  });

  it("lets users mark the article helpful and announces the feedback", () => {
    render(<HelpArticlePage />);
    const helpful = screen.getByRole("button", { name: /yes, helpful/i });

    fireEvent.click(helpful);

    expect(helpful).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/glad this article helped/i);
  });

  it("announces not-helpful feedback too", () => {
    render(<HelpArticlePage />);
    fireEvent.click(screen.getByRole("button", { name: /not really/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/keep improving this article/i);
  });
});

describe("HelpLink", () => {
  it("renders a deep link to the article for a known context", () => {
    render(<HelpLink context="loan-application" />);
    const link = screen.getByRole("link", { name: /need help/i });
    expect(link).toHaveAttribute("href", "/help/articles/apply-for-a-loan");
  });

  it("renders nothing for unknown contexts", () => {
    const { container } = render(<HelpLink context="not-a-real-context" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ErrorSummary contextual help", () => {
  it("embeds the help link inside the error summary when a context is given", () => {
    render(
      <ErrorSummary
        errors={{ amount: { message: "Amount is required" } }}
        labels={{ amount: "Requested principal" }}
        announcementKey={1}
        onFieldSelect={() => {}}
        helpContext="loan-application"
      />
    );
    expect(screen.getByRole("link", { name: /need help/i })).toHaveAttribute(
      "href",
      "/help/articles/apply-for-a-loan"
    );
  });
});
