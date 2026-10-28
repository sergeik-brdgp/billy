// TCP proxy with a slow uplink: client → server bytes are delivered at `bytesPerMs`, server →
// client immediately. A client close is forwarded only after every queued byte was delivered —
// like bytes still in kernel buffers / in the network after the app aborted an upload.

import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

export interface ThrottleProxy {
  readonly port: number;
  close(): Promise<void>;
}

export async function startThrottleProxy(
  upstreamPort: number,
  bytesPerMs: number,
): Promise<ThrottleProxy> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(upstreamPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const queue: Buffer[] = [];
    let pumping = false;
    let clientEnded = false;
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      while (queue.length > 0) {
        const chunk = queue.shift();
        if (chunk === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(chunk.length / bytesPerMs)));
        if (!upstream.destroyed) upstream.write(chunk);
      }
      pumping = false;
      if (clientEnded && !upstream.destroyed) upstream.end();
    };
    const onClientEnd = (): void => {
      clientEnded = true;
      if (!pumping && queue.length === 0 && !upstream.destroyed) upstream.end();
    };
    client.on('data', (chunk: Buffer) => {
      queue.push(chunk);
      void pump();
    });
    client.on('end', onClientEnd);
    client.on('close', onClientEnd);
    client.on('error', () => undefined);
    upstream.on('data', (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
    });
    upstream.on('end', () => client.end());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
