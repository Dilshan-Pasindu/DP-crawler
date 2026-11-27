import readline from 'node:readline';

const MAX_BYTES = 1024 * 1024; // 1 MiB bounded frame size
const PROTOCOL_VERSION = '1.0.0';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const activeTimers = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

rl.on('line', (line) => {
  if (Buffer.byteLength(line, 'utf8') > MAX_BYTES) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Message exceeds bounded size limit' },
    });
    return;
  }

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        helperName: 'poc-helper',
        capabilities: {
          discovery: true,
          invoke: true,
          screenshots: false,
          cancellation: true,
        },
      },
    });
    return;
  }

  if (req.method === 'slowOp') {
    const delayMs = Number(req.params?.delayMs ?? 500);
    const timer = setTimeout(() => {
      activeTimers.delete(req.id);
      send({ jsonrpc: '2.0', id: req.id, result: { completed: true, delayMs } });
    }, delayMs);
    activeTimers.set(req.id, timer);
    return;
  }

  if (req.method === '$/cancelRequest') {
    const targetId = req.params?.id;
    const timer = activeTimers.get(targetId);
    if (timer) {
      clearTimeout(timer);
      activeTimers.delete(targetId);
      send({
        jsonrpc: '2.0',
        id: targetId,
        error: { code: -32800, message: 'Request cancelled' },
      });
    }
    return;
  }

  if (req.method === 'crashNow') {
    process.exit(42);
  }

  if (req.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: req.id, result: { shuttingDown: true } });
    process.exit(0);
  }

  send({
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: { code: -32601, message: `Method not found: ${String(req.method)}` },
  });
});
