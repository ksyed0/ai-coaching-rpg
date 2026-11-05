/** A role id as words: "account_manager" -> "Account manager". The scenario's role titles are not sent to players in 2a. */
export function roleLabel(roleId: string): string {
  const words = roleId.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? "" : words[0]!.toUpperCase() + words.slice(1);
}
