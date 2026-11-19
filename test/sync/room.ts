import { acceptChange, type ClientMessage, type Committed, type ServerMessage } from '@elabora/core/sync/index';
import type { Presence } from '@elabora/core/sync/protocol';
import type { Files } from '@elabora/core/ops/types';
import type { RoomSocket } from '@elabora/engine/base/session-cloud';

// A project's room in memory, as elabora-cloud's places changes (the core's acceptChange), with what a
// test needs of it: a copy kept out, a connection dropped, roles, refusals, a restore. Its sockets are
// what the copies' connect gives them.

export class Room {
  head = 0;
  files: Files;
  log: Committed[] = [];
  readonly sockets = new Set<FakeSocket>();
  // The next submissions refused with this code (a room that could not find a medium).
  refuse: { code: 'E_SYNC_BLOB_MISSING'; times: number } | null = null;
  refused = 0;
  // Copies kept out (their hello closes the connection): offline until let back in.
  readonly away = new Set<string>();
  // Submissions taken but not answered while true (a change waiting in the copy).
  hold = false;
  // Each copy's role in the project, by client (C37): a viewer's submissions refused; said in welcome
  // (D94) unless sayRole is false, as a room before it.
  readonly roles = new Map<string, 'owner' | 'editor' | 'viewer'>();
  sayRole = true;
  // Every hello closed with this code (elabora-cloud C80, C83: another protocol, a newer storage, every
  // connection taken), and how many hellos came.
  refuseHello: { code: 4005 | 4006 | 4007; reason?: string } | null = null;
  hellos = 0;
  // The project whole of a copy of another history, held until let go (what comes between the welcome
  // and it), and the bases of the changes submitted.
  holdSnapshot: (() => void) | null = null;
  holdSnapshots = false;
  readonly bases: number[] = [];
  // Which history the room's numbers belong to (elabora-cloud C84): "0" until restore(); the files at
  // each head, to go back to one.
  epoch = '0';
  readonly at = new Map<number, Files>();
  constructor(files: Files) { this.files = files; this.at.set(0, files); }
  // Back to an earlier head, as the administrator restores a room to a time: its later changes leave,
  // its epoch changes, every connection closes with 4008.
  restore(head: number): void {
    this.files = this.at.get(head)!;
    this.head = head;
    this.log = this.log.filter((change) => change.seq <= head);
    this.epoch = `e${this.at.size}-${head}`;
    for (const socket of [...this.sockets]) socket.close(4008);
  }

  connect = (): RoomSocket => {
    const socket = new FakeSocket(this);
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };

  receive(from: FakeSocket, message: ClientMessage): void {
    if (message.type === 'hello') {
      this.hellos++;
      if (this.refuseHello) return from.close(this.refuseHello.code, this.refuseHello.reason);
      if (this.away.has(message.client)) return from.close();
      from.presence = { actor: message.actor, client: message.client, at: '2026-11-12T09:00:00.000Z' };
      const role = this.roles.get(message.client);
      from.deliver({ type: 'welcome', protocol: 'elabora-sync/1', head: this.head, peers: this.peers(), epoch: this.epoch, ...(role && this.sayRole ? { role } : {}) });
      // A copy of another history (its epoch, or none once restored): the whole project, not a catch-up.
      if (message.since > 0 && (message.epoch ?? '0') !== this.epoch) {
        const give = () => from.deliver({ type: 'snapshot', head: this.head, files: [...this.files].map(([rel, file]) => (file.kind === 'text' ? { path: rel, text: file.text } : { path: rel, blob: file.hash!, size: file.size })) });
        if (this.holdSnapshots) this.holdSnapshot = give; else give();
      }
      return this.tellPresence(from);
    }
    if (message.type === 'catchup') return from.deliver({ type: 'catchup', changes: this.log.filter((change) => change.seq > message.since), head: this.head });
    // The room relays where a copy is, as elabora-cloud's does (screen, selection, and the view, D91).
    if (message.type === 'presence') {
      if (!from.presence) return;
      const { screen, selection, view } = message.presence;
      from.presence = { actor: from.presence.actor, client: from.presence.client, at: from.presence.at, ...(screen ? { screen } : {}), ...(selection ? { selection } : {}), ...(view ? { view } : {}) };
      return this.tellPresence(null);
    }
    if (message.type !== 'submit' || this.hold) return;
    this.bases.push(message.change.base);
    if (from.presence && this.roles.get(from.presence.client) === 'viewer') return from.deliver({ type: 'refused', refusal: { id: message.change.id, code: 'E_SYNC_READ_ONLY', message: 'A viewer reads this project.' }, head: this.head });
    if (this.refuse && this.refuse.times-- > 0) {
      this.refused++;
      return from.deliver({ type: 'refused', refusal: { id: message.change.id, code: this.refuse.code, message: 'Send the medium first.' }, head: this.head });
    }
    const accepted = acceptChange({ head: this.head, files: this.files, log: this.log }, message.change);
    if ('refusal' in accepted) return from.deliver({ type: 'refused', refusal: accepted.refusal, head: this.head });
    if (!accepted.duplicate) {
      this.head = accepted.committed.seq;
      this.files = accepted.files;
      this.log.push(accepted.committed);
      this.at.set(this.head, this.files);
      for (const other of this.sockets) if (other !== from && other.presence) other.deliver({ type: 'change', change: accepted.committed });
    }
    from.deliver({ type: 'ack', change: accepted.committed });
  }

  peers(): Presence[] { return [...this.sockets].flatMap((socket) => (socket.presence ? [socket.presence] : [])); }
  // To the connections whose hello the room read, as elabora-cloud's room does (a connection still
  // opening, or one about to be refused, hears nothing: a change of another history would land on its head).
  tellPresence(except: FakeSocket | null): void {
    for (const other of this.sockets) if (other !== except && other.presence) other.deliver({ type: 'presence', peers: this.peers() });
  }

  // The connection drops; the copy reconnects by itself.
  drop(): void { for (const socket of [...this.sockets]) socket.close(); }
  // One copy offline until back() (its reconnections closed meanwhile).
  out(client: string): void { this.away.add(client); for (const socket of [...this.sockets]) if (socket.presence?.client === client) socket.close(); }
  back(client: string): void { this.away.delete(client); }
  // The person's role changed while connected (D93), as the room tells its open connections.
  role(client: string, role: 'owner' | 'editor' | 'viewer'): void {
    this.roles.set(client, role);
    for (const socket of this.sockets) if (socket.presence?.client === client) socket.deliver({ type: 'role', role });
  }
  // A copy sent away for good: its membership ended (4003), or the project was deleted (4004).
  end(client: string, code: 4003 | 4004): void { for (const socket of [...this.sockets]) if (socket.presence?.client === client) socket.close(code); }
}

export class FakeSocket implements RoomSocket {
  readyState = 0;
  readonly #listeners = new Map<string, ((event: { data: unknown; code?: number; reason?: string }) => void)[]>();
  readonly room: Room;
  presence: Presence | null = null;
  constructor(room: Room) { this.room = room; }
  addEventListener(type: string, listener: (event: { data: unknown; code?: number; reason?: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown, code?: number, reason?: string): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data, ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientMessage;
    setTimeout(() => this.room.receive(this, message), 2);
  }
  deliver(message: ServerMessage): void {
    if (this.readyState === 1) setTimeout(() => this.emit('message', JSON.stringify(message)), 2);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.room.sockets.delete(this);
    if (this.presence) this.room.tellPresence(null);
    this.emit('close', undefined, code, reason);
  }
}
