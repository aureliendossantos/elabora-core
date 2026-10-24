import { EventEmitter } from 'node:events';

// Keep failure deadlines real even when a scenario drives the domain's timers with a fake clock.
const deadline = setTimeout;
const cancelDeadline = clearTimeout;
export type EventLog<T> = T[] & { record(event: T): void; notifications: EventEmitter };

export function eventLog<T>(): EventLog<T> {
  const notifications = new EventEmitter();
  const log = Object.assign([] as T[], { notifications, record(event: T) { log.push(event); notifications.emit('event'); } });
  return log;
}

export function waitFor<T, Found extends T>(events: EventLog<T>, match: (event: T) => event is Found, timeoutMs = 15000): Promise<Found> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(match);
      if (found) { cancelDeadline(timer); events.notifications.off('event', check); resolve(found); }
    };
    const timer = deadline(() => {
      events.notifications.off('event', check);
      reject(new Error(`Expected event was not reported: ${JSON.stringify(events)}`));
    }, timeoutMs);
    events.notifications.on('event', check);
    check();
  });
}
