// Task labels are presentation metadata; terminal addresses remain the identity.
export function taskName(terminal, fallback = "") {
  return terminal?.labels?.["auto-name.task"] || terminal?.name || terminal?.title || fallback;
}

export function terminalLabel(address, terminal, fallback = "") {
  const name = taskName(terminal, fallback);
  return address ? `[${address}]${name ? ` ${name}` : ""}` : name;
}
