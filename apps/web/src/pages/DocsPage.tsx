import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Check, Copy, Search } from "lucide-react";
import { docPages, docOrder, findDocPage, groupTitles, type Block, type DocPage } from "../docs";
import { Container, useMeta } from "../components/ui";
import { useCopy, useLocale, type Locale } from "../i18n";

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/(^-|-$)/g, "");
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const c = useCopy({ en: { copy: "Copy", copied: "Copied", label: "Copy code" }, ru: { copy: "Копировать", copied: "Скопировано", label: "Копировать код" } });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: ignore */
    }
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? "text"}</span>
        <button className="copy-btn" onClick={copy} aria-label={c.label}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? c.copied : c.copy}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function renderBlock(block: Block, i: number) {
  switch (block.type) {
    case "h2":
      return <h2 key={i} id={slugify(block.text)}>{block.text}</h2>;
    case "p":
      return <p key={i}>{block.text}</p>;
    case "list":
      return (
        <ul key={i}>
          {block.items.map((it) => <li key={it}>{it}</li>)}
        </ul>
      );
    case "code":
      return <CodeBlock key={i} code={block.code} lang={block.lang} />;
    case "note":
      return <div key={i} className="doc-note">{block.text}</div>;
  }
}

export default function DocsPage() {
  const { slug } = useParams();
  const { locale } = useLocale();
  const c = useCopy({
    en: {
      search: "Search docs",
      searchLabel: "Search documentation",
      nav: "Documentation",
      noMatch: "No matches.",
      onPage: "On this page",
      docs: "Docs",
      prev: "Previous",
      next: "Next",
      breadcrumb: "Breadcrumb",
      aside: "On this page",
    },
    ru: {
      search: "Поиск по документации",
      searchLabel: "Поиск по документации",
      nav: "Документация",
      noMatch: "Ничего не найдено.",
      onPage: "На этой странице",
      docs: "Документация",
      prev: "Назад",
      next: "Далее",
      breadcrumb: "Навигация",
      aside: "На этой странице",
    },
  });
  const page = findDocPage(slug);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const order: DocPage["group"][] = ["start", "account", "messaging", "platforms", "security", "developers"];
    const q = query.trim().toLowerCase();
    return order
      .map((g) => ({
        key: g,
        title: groupTitles[g][locale as Locale],
        pages: docPages.filter((p) => p.group === g && (!q || p.copy[locale].title.toLowerCase().includes(q))),
      }))
      .filter((g) => g.pages.length > 0);
  }, [query, locale]);

  const pageCopy = page?.copy[locale];
  useMeta(
    pageCopy ? `${pageCopy.title} — Luxora` : "Luxora",
    pageCopy?.summary ?? "Luxora documentation.",
  );

  if (!page || !pageCopy) return <Navigate to="/docs/introduction" replace />;

  const idx = docOrder.indexOf(page.slug);
  const prev = idx > 0 ? docPages[idx - 1] : undefined;
  const next = idx < docPages.length - 1 ? docPages[idx + 1] : undefined;
  const toc = pageCopy.blocks.filter((b): b is Extract<Block, { type: "h2" }> => b.type === "h2");
  const groupName = groupTitles[page.group][locale];

  return (
    <div className="docs">
      <Container className="docs-grid">
        <aside className="docs-sidebar" aria-label={c.nav}>
          <label className="docs-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder={c.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={c.searchLabel}
            />
          </label>
          {groups.map((g) => (
            <div key={g.key} className="docs-group">
              <p className="docs-group-title">{g.title}</p>
              {g.pages.map((p) => (
                <Link
                  key={p.slug}
                  to={`/docs/${p.slug}`}
                  className={`docs-link ${p.slug === page.slug ? "active" : ""}`}
                  aria-current={p.slug === page.slug ? "page" : undefined}
                >
                  {p.copy[locale].title}
                </Link>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="muted">{c.noMatch}</p>}
        </aside>

        <article className="docs-main">
          <nav className="breadcrumbs" aria-label={c.breadcrumb}>
            <Link to="/docs">{c.docs}</Link>
            <span aria-hidden="true">/</span>
            <span>{groupName}</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{pageCopy.title}</span>
          </nav>

          <h1>{pageCopy.title}</h1>
          <p className="lead">{pageCopy.summary}</p>

          <div className="doc-body">{pageCopy.blocks.map(renderBlock)}</div>

          <div className="doc-pager">
            {prev ? (
              <Link to={`/docs/${prev.slug}`} className="pager-link prev">
                <ChevronLeft size={18} aria-hidden="true" />
                <span><small>{c.prev}</small>{prev.copy[locale].title}</span>
              </Link>
            ) : <span />}
            {next ? (
              <Link to={`/docs/${next.slug}`} className="pager-link next">
                <span><small>{c.next}</small>{next.copy[locale].title}</span>
                <ChevronRight size={18} aria-hidden="true" />
              </Link>
            ) : <span />}
          </div>
        </article>

        <aside className="docs-toc" aria-label={c.aside}>
          {toc.length > 0 && (
            <>
              <p className="docs-group-title">{c.onPage}</p>
              {toc.map((h) => (
                <a key={h.text} href={`#${slugify(h.text)}`} className="toc-link">{h.text}</a>
              ))}
            </>
          )}
        </aside>
      </Container>
    </div>
  );
}

export type { DocPage };
