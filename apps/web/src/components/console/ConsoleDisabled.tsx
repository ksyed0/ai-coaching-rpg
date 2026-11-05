// Shown instead of the form when the console's settings are missing. Generic on purpose: the server log says which are unset.

export function ConsoleDisabled() {
  return (
    <p className="banner warn" role="status">
      The console is not set up on this server.
    </p>
  );
}
