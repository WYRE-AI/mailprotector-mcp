/** Decode a JSON-RPC message from a streamable-HTTP response (JSON or SSE). */
export async function mcpJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`No data frame in SSE body: ${JSON.stringify(text)}`);
    return JSON.parse(last.slice("data:".length).trim());
  }
  return JSON.parse(text);
}
