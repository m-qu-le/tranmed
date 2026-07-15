import { EventEmitter } from 'events';

export const appEvents = new EventEmitter();
appEvents.setMaxListeners(100);
