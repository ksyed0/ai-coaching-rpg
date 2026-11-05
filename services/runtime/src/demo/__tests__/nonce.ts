/** Test support: a fake OpenAI-compatible server answers the Game Master like a model that obeys the id instruction in its (JSON-encoded) request body. */
export function stampFromBody(text: string, body: string): string {
  const nonce = /copied unchanged: \\?"([0-9a-f]{8,})/.exec(body)?.[1];
  return nonce === undefined ? text : text.replace(/\{(\s*)("(?:reasoning|verdict)")/g, `{"id": "${nonce}", $2`);
}
