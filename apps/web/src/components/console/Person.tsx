import { roleLabel } from "../../lib/names";

// US-0059: how the console names a role in the DOM. A participant's name is supplied by a person, so it sits in <bdi> (a bidi control in
// it cannot reorder the text around it); the role label comes from the scenario and is isolated the same way.

/** Who is seated where: names by role id (from the roster) and whether a role is an AI character. */
export type Labeler = {
  names: Record<string, string>;
  ai: (roleId: string) => boolean;
  /** US-0060: whether an AI player holds the seat (its name is then never shown). */
  aiPlayer?: (roleId: string) => boolean;
};

export function Person({ roleId, label }: { roleId: string; label: Labeler }) {
  const aiPlayer = label.aiPlayer?.(roleId) === true;
  const name = aiPlayer ? undefined : label.names[roleId];
  const role = <bdi>{roleLabel(roleId)}</bdi>;
  return (
    <>
      {name ? (
        <>
          <bdi>{name}</bdi> ({role})
        </>
      ) : (
        role
      )}
      {aiPlayer ? " (AI player)" : null}
      {label.ai(roleId) ? " (AI character)" : null}
    </>
  );
}
