// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { escapeHtml, renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, lists and blockquotes", () => {
    const html = renderMarkdown(
      ["## Title", "", "A paragraph.", "", "- one", "- two", "", "> quoted"].join("\n")
    );
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<p>A paragraph.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("renders ordered lists", () => {
    expect(renderMarkdown("1. first\n2. second")).toContain(
      "<ol><li>first</li><li>second</li></ol>"
    );
  });

  it("renders bold, inline code and fenced code blocks", () => {
    const html = renderMarkdown("**bold** and `code`\n```\nconst x = 1;\n```");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre><code>const x = 1;</code></pre>");
  });

  it("allows safe links and neutralizes unsafe ones", () => {
    const html = renderMarkdown("[docs](https://example.com) [bad](javascript:alert(1))");
    expect(html).toContain(
      '<a href="https://example.com" rel="noopener noreferrer" target="_blank">docs</a>'
    );
    expect(html).toContain('<a href="#">bad</a>');
    expect(html).not.toContain("javascript:");
  });

  it("escapes raw HTML in the source", () => {
    const html = renderMarkdown("<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});
