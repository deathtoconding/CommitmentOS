import { database } from '../db/client';
import { createSourceMessageRecorder } from './service-core';

export * from './service-core';

/** Server-only persistence service backed by the shared application database connection. */
export const recordSourceMessage = createSourceMessageRecorder(database);
