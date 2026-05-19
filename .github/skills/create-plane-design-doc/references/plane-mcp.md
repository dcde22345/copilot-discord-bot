# Plane MCP: project pages

## Tool

`create_project_page` on MCP server identifier **`user-plane`**.

## Before calling

List and read the tool descriptor under the Cursor MCP folder for `user-plane` / `create_project_page.json` so parameter names and types match the current schema.

## Required arguments

| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string | Plane project UUID |
| `name` | string | Page title shown in Plane |
| `description_html` | string | Full page body as HTML |

## Optional arguments

The tool may support optional fields (access, color, locks, external ids). Omit unless the user asks.

## Response

Expect a page object including at least `id`, `name`, and `description_html` on success. Surface `id` to the user.

## Payload size

Very large `description_html` strings may hit limits. If a call fails, shorten content or split into multiple pages only when the user agrees.
