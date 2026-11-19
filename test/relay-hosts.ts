// The web app's names on this computer, for the relay's tests (docs/architecture/rendering.md): one local
// TLS server with a certificate of its own, and a proxy that sends every connection of the browser to it,
// so that app.elabora.studio, canvas.elabora.page and frames.elabora.page are three origins, the canvas two
// sites away from the app. Each name has its request handler.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface Hosts {
  proxyPort: number;
  // The certificate's key, for a Chromium to trust it (a service worker is installed only from a certificate the browser accepts).
  spki: string;
  close(): void;
}

export async function startHosts(handlers: Record<string, Handler>): Promise<Hosts> {
  const dir = mkdtempSync(join(tmpdir(), 'elabora-relay-hosts-'));
  const names = Object.keys(handlers);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=elabora relay tests', '-addext', `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const spki = execFileSync('sh', ['-c', `openssl x509 -in '${join(dir, 'cert.pem')}' -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: 'utf8' }).trim();
  // A closed table by name: what the request says only selects among the handlers given.
  const table = new Map(Object.entries(handlers));
  const tls = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (request, response) => {
    const handler = table.get((request.headers.host ?? '').split(':')[0]!);
    if (!handler) { response.writeHead(404).end('no such name'); return; }
    handler(request, response);
  });
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const proxy = createHttpServer((_request, response) => response.writeHead(400).end());
  proxy.on('connect', (_request, client, head) => {
    const upstream = connect((tls.address() as AddressInfo).port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return { proxyPort: (proxy.address() as AddressInfo).port, spki, close() { tls.close(); proxy.close(); rmSync(dir, { recursive: true, force: true }); } };
}
