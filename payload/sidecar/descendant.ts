// A deliberately boring descendant used by the native lifecycle gate. The
// supervisor Job Object, rather than application protocol, owns its lifetime.
setInterval(() => undefined, 1_000);
