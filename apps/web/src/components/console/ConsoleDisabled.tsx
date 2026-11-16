// Shown instead of the form when the console's settings are missing. Generic on purpose: the server log says which are unset.

export function ConsoleDisabled() {
  return (
    <p className="banner warn" role="status">
      The console is not set up on this server.
    </p>
  );
}

// US-0083: shown when the session service cannot confirm the sign-in right now. The cookie is kept, so a reload is enough once it answers.
export function ConsoleUnavailable() {
  return (
    <p className="banner warn" role="status">
      The session service is not reachable. Reload this page to try again.
    </p>
  );
}
