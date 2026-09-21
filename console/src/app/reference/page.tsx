import type { Metadata } from "next";
import { Fragment } from "react";

import { apiBaseUrl } from "@/lib/api";
import { apiVersion, reference, schemas, type Endpoint, type Field } from "@/lib/openapi";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "API reference · Cachet",
  description:
    "Every route of the Cachet registry API: assets, sealed metadata, the relay, signed snapshots. No key, no account. Testnet.",
  path: "/reference",
});

/** One run of the contract's prose: `code` spans are all the markup it uses. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .replace(/\n/g, " ")
        .split(/(`[^`]+`)/)
        .map((part, position) =>
          part.startsWith("`") && part.endsWith("`") ? (
            <code key={position} className="font-data text-[0.92em] text-neutral-200">
              {part.slice(1, -1)}
            </code>
          ) : (
            <Fragment key={position}>{part}</Fragment>
          ),
        )}
    </>
  );
}

/** Its paragraphs. */
function Prose({ text, className = "" }: { text: string; className?: string }) {
  if (!text.trim()) return null;
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} className={className}>
          <Inline text={paragraph} />
        </p>
      ))}
    </>
  );
}

const sub = "font-data mt-6 text-[13px] uppercase tracking-[0.18em] text-neutral-500";

function Fields({ fields }: { fields: (Field & { where?: string })[] }) {
  return (
    <dl className="mt-2">
      {fields.map((field) => (
        <div
          key={`${field.where ?? ""}${field.name}`}
          className="grid gap-x-6 gap-y-1 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[15rem_minmax(0,1fr)]"
        >
          <dt className="font-data min-w-0 text-sm [overflow-wrap:anywhere]">
            <span className="text-neutral-100">{field.name}</span>
            <span className="block text-[13px] text-neutral-500">
              {field.type}
              {field.where ? ` · ${field.where}` : ""}
              {field.required ? " · required" : ""}
            </span>
          </dt>
          <dd className="min-w-0 text-sm leading-relaxed text-neutral-400">
            <Prose text={field.description} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function curl(endpoint: Endpoint): string {
  const url = `${apiBaseUrl}${endpoint.path}`;
  if (endpoint.method === "GET") return `curl "${url}"`;
  const lines = [`curl -X ${endpoint.method} "${url}"`];
  if (endpoint.body) {
    lines.push(`  -H "content-type: application/json"`);
    lines.push(`  -d '${endpoint.body.example ?? "{ ... }"}'`);
  }
  return lines.join(" \\\n");
}

function EndpointBlock({ endpoint }: { endpoint: Endpoint }) {
  return (
    <article id={endpoint.id} className="scroll-mt-8 border-t border-line py-9 first:border-t-0">
      <h3 className="font-data flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
        <span className={endpoint.method === "GET" ? "text-accent" : "text-neutral-100"}>
          {endpoint.method}
        </span>
        <span className="min-w-0 text-neutral-100 [overflow-wrap:anywhere]">{endpoint.path}</span>
      </h3>
      <p className="mt-2.5 max-w-prose text-base leading-relaxed text-neutral-200">
        {endpoint.summary}
      </p>
      <div className="mt-2 flex max-w-prose flex-col gap-2.5">
        <Prose text={endpoint.description} className="text-sm leading-relaxed text-neutral-400" />
      </div>

      {endpoint.parameters.length > 0 && (
        <>
          <h4 className={sub}>Parameters</h4>
          <Fields fields={endpoint.parameters} />
        </>
      )}

      {endpoint.body && (
        <>
          <h4 className={sub}>Body{endpoint.body.schema ? ` · ${endpoint.body.schema}` : ""}</h4>
          <Fields fields={endpoint.body.fields} />
        </>
      )}

      <h4 className={sub}>Answers</h4>
      <dl className="mt-2">
        {endpoint.responses.map((response) => (
          <div
            key={response.status}
            className="grid gap-x-6 gap-y-1 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[15rem_minmax(0,1fr)]"
          >
            <dt className="font-data text-sm">
              <span
                className={response.status.startsWith("2") ? "text-accent" : "text-neutral-100"}
              >
                {response.status}
              </span>
              {response.schema && (
                <span className="block text-[13px] text-neutral-500 [overflow-wrap:anywhere]">
                  {response.schema}
                </span>
              )}
            </dt>
            <dd className="min-w-0 text-sm leading-relaxed text-neutral-400">
              <Prose
                text={
                  response.description ||
                  (response.type === "application/problem+json"
                    ? "A problem document (RFC 9457): `type`, `title`, `status`, `detail`."
                    : "")
                }
              />
              {response.headers.map((header) => (
                <p key={header.name} className="mt-1">
                  <code className="font-data text-[0.92em] text-neutral-200">{header.name}</code>{" "}
                  <Inline text={header.description} />
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>

      <pre className="font-data mt-5 overflow-x-auto rounded-md border border-white/[0.07] bg-black/40 px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-300">
        {curl(endpoint)}
      </pre>
    </article>
  );
}

export default function ReferencePage() {
  return (
    <div className="py-10">
      <h1 className="font-display text-5xl font-medium text-neutral-50">API reference</h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Everything the console does, it does through these routes, and so can you. No key, no
        account. Reads are public chain data; what is served can be checked against the chain rather
        than believed. This page is drawn from the contract the server exports (version {apiVersion}
        ).
      </p>
      <dl className="font-data mt-6 grid max-w-2xl gap-y-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="text-neutral-500">base</dt>
        <dd className="text-neutral-200 [overflow-wrap:anywhere]">{apiBaseUrl}</dd>
        <dt className="text-neutral-500">errors</dt>
        <dd className="text-neutral-300">application/problem+json, never cached</dd>
        <dt className="text-neutral-500">limit</dt>
        <dd className="text-neutral-300">
          30 requests a second per client, bursts of 60, then 429
        </dd>
        <dt className="text-neutral-500">contract</dt>
        <dd>
          <a
            href={`${apiBaseUrl}/api/openapi.json`}
            className="text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
          >
            openapi.json
          </a>
          <span className="text-neutral-500"> · </span>
          <a
            href={`${apiBaseUrl}/api/docs`}
            className="text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
          >
            try requests in Swagger
          </a>
        </dd>
      </dl>

      <div className="mt-12 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-14">
        <nav aria-label="Routes" className="hidden lg:block">
          <div className="sticky top-8 flex max-h-[calc(100vh-4rem)] flex-col gap-5 overflow-y-auto pr-2">
            {reference.map((group) => (
              <div key={group.tag}>
                <a
                  href={`#${group.tag}`}
                  className="text-sm font-medium text-neutral-200 transition hover:text-accent"
                >
                  {group.title}
                </a>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {group.endpoints.map((endpoint) => (
                    <li key={endpoint.id}>
                      <a
                        href={`#${endpoint.id}`}
                        className="font-data block truncate text-[13px] text-neutral-500 transition hover:text-accent"
                        title={`${endpoint.method} ${endpoint.path}`}
                      >
                        <span className="text-neutral-600">{endpoint.method.toLowerCase()}</span>{" "}
                        {endpoint.path.replace("/api/v1", "")}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <a
              href="#schemas"
              className="text-sm font-medium text-neutral-200 transition hover:text-accent"
            >
              Shapes
            </a>
          </div>
        </nav>

        <div className="min-w-0">
          {reference.map((group) => (
            <section key={group.tag} id={group.tag} className="scroll-mt-8 pb-10">
              <h2 className="font-display text-3xl font-medium text-neutral-50">{group.title}</h2>
              <p className="mt-2 max-w-prose text-base leading-relaxed text-neutral-400">
                {group.note}
              </p>
              <div className="mt-4">
                {group.endpoints.map((endpoint) => (
                  <EndpointBlock key={endpoint.id} endpoint={endpoint} />
                ))}
              </div>
            </section>
          ))}

          <section id="schemas" className="scroll-mt-8">
            <h2 className="font-display text-3xl font-medium text-neutral-50">Shapes</h2>
            <p className="mt-2 max-w-prose text-base leading-relaxed text-neutral-400">
              The documents the routes above take and answer with.
            </p>
            {schemas.map((schema) => (
              <article
                key={schema.name}
                id={`shape-${schema.name}`}
                className="scroll-mt-8 border-t border-line py-7 first:mt-4"
              >
                <h3 className="font-data text-base text-neutral-100">{schema.name}</h3>
                <div className="mt-2 flex max-w-prose flex-col gap-2">
                  <Prose
                    text={schema.description}
                    className="text-sm leading-relaxed text-neutral-400"
                  />
                </div>
                <Fields fields={schema.fields} />
              </article>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
