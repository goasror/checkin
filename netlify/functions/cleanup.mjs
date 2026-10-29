// Daily scheduled function: removes every host's abandoned sessions with their photos (never ended and
// started over a day ago, or ended a week ago without a PDF). The logic lives in api.mjs (cleanup) so
// the tests can run it.

import { cleanup, realStores } from './api.mjs';

export default async () => {
  const removed = await cleanup({ db: await realStores() });
  console.log(`cleanup: removed ${removed} session(s)`);
};

export const config = { schedule: '@daily' };
