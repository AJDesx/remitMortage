// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Minimal Markdown renderer for Help Center articles.
 *
 * The help articles are authored in Markdown as plain strings; this module
 * renders the small subset we use (headings, paragraphs, ordered/unordered
 * lists, blockquotes, bold, inline code, code fences and links) into safe
 * HTML. All input is HTML-escaped before any Markdown syntax is applied, so
 * article content can never inject markup.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Render inline Markdown (bold, inline code, links) on already-escaped text. */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      // Only allow http(s) and in-app relative links.
      const safeHref = /^(https?:\/\/|\/)/.test(href) ? href : "#";
      const external = safeHref.startsWith("http");
      const rel = external ? ' rel="noopener noreferrer"' : "";
      const target = external ? ' target="_blank"' : "";
      return `<a href="${safeHref}"${rel}${target}>${label}</a>`;
    });
}

/**
 * Render a Markdown document to an HTML string. The output is intended for
 * `dangerouslySetInnerHTML` and is safe because the source is escaped first.
 */
export function renderMarkdown(markdown: string): string {
  const lines = escapeHtml(markdown.replace(/\r\n/g, "\n")).split("\n");
  const html: string[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let codeBlock: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }

  function flushList() {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      html.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      list = null;
    }
  }

  function flush() {
    flushParagraph();
    flushList();
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (codeBlock) {
      if (line.startsWith("```")) {
        html.push(`<pre><code>${codeBlock.join("\n")}</code></pre>`);
        codeBlock = null;
      } else {
        codeBlock.push(line);
      }
      continue;
    }

    if (line.startsWith("```")) {
      flush();
      codeBlock = [];
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      html.push(`<h${level + 1}>${renderInline(heading[2])}</h${level + 1}>`);
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(renderInline(unordered[1]));
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(renderInline(ordered[1]));
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      html.push(`<blockquote><p>${renderInline(quote[1])}</p></blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeBlock) {
    html.push(`<pre><code>${codeBlock.join("\n")}</code></pre>`);
  }
  flush();

  return html.join("\n");
}
