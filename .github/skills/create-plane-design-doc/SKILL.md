---
name: create-plane-design-doc
description: Author technical design pages as HTML and publish them to a Plane project using the user-plane MCP create_project_page tool. Use when the user wants a Plane wiki/design page with a sequential Mermaid flow, database schema tables, and API contracts derived from requirements plus the existing codebase; when publishing design docs from this repo; or when asked to sync documentation to Plane.
---

# Create Plane design doc

## When this applies

- The user wants a **design or specification page** on **Plane** (not only a local file).
- Content should be **HTML** (Plane stores `description_html`).
- Typical sections: overview, **sequential flow (Mermaid)**, schema tables, API contract tables.

## What the page must cover (content order)

Follow this **two-step analysis** before writing HTML:

1. **Map behavior to APIs and a sequential flow**
   From the **user’s requirements** and the **existing codebase** (routes, services, callers), identify:
   - Which **HTTP APIs** (or server actions) participate in the feature.
   - The **order of steps** (who calls what, after what). This becomes the **Flow** section as a **sequential** Mermaid diagram (see below).

2. **Derive schema and contracts from that flow**
   From the same flow, list only what is **in scope**:
   - **Schema** (tables touched or read): HTML table(s) in the **Schema** section.
   - **API contracts** (request/response shapes, auth, errors): HTML table(s) in the **API contracts** section.

If an endpoint or table is not used in the sequential flow, omit it unless the user explicitly wants a full system appendix.

## Workflow (authoring and publishing)

1. **Collect inputs**
   Ask or infer: Plane **project id** (UUID), **page title**, document **language** (match the user’s request), and the feature scope.

2. **Do the two-step analysis** (above) using the codebase; keep notes concise.

3. **Draft the body in HTML**
   - Use semantic headings (`h2`, `h3`). Suggested order: **Overview** → **Flow** → **Schema** → **API contracts**.
   - **Flow section**: one **sequential** Mermaid diagram. Prefer `sequenceDiagram` (participants = actor, UI, API routes, services, DB as needed). Show the **happy path** first; add alt/opt blocks only if the user cares about branches.
   - **Paste the Mermaid source** into the Flow subsection inside a monospace block, for example:

```html
<h2>2. Flow</h2>
<p><!-- One sentence: what this sequence shows. --></p>
<pre style="font-family:monospace;font-size:12px;background:#f4f4f5;padding:12px;border-radius:6px;line-height:1.45;overflow:auto;"><code>sequenceDiagram
  participant U as User
  participant A as Admin UI
  participant API as POST /api/...
  U-&gt;&gt;A: action
  A-&gt;&gt;API: request
</code></pre>
```

   - Escape `&gt;` for `>` inside HTML when you use `&lt;pre&gt;&lt;code&gt;` so the file stays valid HTML (as in the example).
   - **Schema** and **API contracts**: prefer **HTML `<table>`** matrices (not long bullet lists).
   - Escape JSON examples inside cells: use `&lt;code&gt;` and escape quotes in attributes as needed.
   - Omit **source file paths** from the page unless the user wants a pointer to extra examples.
   - Optional: add a one-line footer with the creation date.

4. **Optional repo copy**
   If the project keeps drafts under version control, save the same HTML beside other Plane drafts (naming: `*-design-v2-en.html` or similar). This is optional and separate from Plane.

5. **Publish to Plane**
   - Read the MCP tool schema for `create_project_page` before calling (see [references/plane-mcp.md](references/plane-mcp.md)).
   - Call **`create_project_page`** on server **`user-plane`** with:
     - `project_id` (UUID)
     - `name` (page title)
     - `description_html` (full HTML string)
   - Confirm success from the returned page object (e.g. `id`).

6. **Report back**
   Give the user the **page title** and Plane **page id** from the response. Do not claim the page exists if the MCP call failed.

## Conventions

| Topic | Convention |
| --- | --- |
| Flow | **Sequential** Mermaid (`sequenceDiagram` unless the user asks for `flowchart`); full source visible in a **Flow** `<pre><code>` block |
| Schema | Tables/columns tied to the **same** flow; Table / Role (or similar) |
| APIs | One row per operation: method/path, auth, body or query, success shape, client errors; only endpoints **on the path** unless scope says otherwise |
| Public vs admin | Separate rows or explicit columns when behavior differs |
| Sensitive fields | State omissions (e.g. public catalog omits `cost_price`) in the API table |

## Checklist (confirm before publish)

- [ ] APIs and order of calls reflect **codebase** behavior, not only the user’s guess.
- [ ] **Flow** section includes **Mermaid source** in a code-style block.
- [ ] **Schema** section lists tables **used by that flow**.
- [ ] **API contracts** section matches **those** endpoints.

## Assets

- [assets/design-doc-skeleton.html](assets/design-doc-skeleton.html) — HTML skeleton including a Mermaid Flow placeholder.

## References

- [references/plane-mcp.md](references/plane-mcp.md) — MCP tool name and required arguments.
