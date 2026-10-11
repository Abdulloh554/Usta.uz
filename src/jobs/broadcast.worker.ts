import { processBroadcastBatch } from '../modules/admin/broadcast.service';
import { logger } from '../config/logger';

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;
export const startBroadcastWorker = (): void => {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = processBroadcastBatch()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error('Broadcast worker error', { message: String(error) });
      })
      .finally(() => {
        running = undefined;
      });
  }, 1_000);
  timer.unref();
};
export const stopBroadcastWorker = async (): Promise<void> => {
  if (timer) clearInterval(timer);
  timer = undefined;
  await running;
};
