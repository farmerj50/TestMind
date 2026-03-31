import { runQueue, healingQueue, securityQueue } from "../runner/queue.js";

async function main() {
  console.log("Pausing queues...");
  await Promise.all([runQueue.pause(), healingQueue.pause(), securityQueue.pause()]);

  console.log("Draining jobs...");
  await Promise.all([
    healingQueue.drain(true),
    runQueue.drain(true),
    securityQueue.drain(true),
  ]);

  console.log("Cleaning history...");
  await Promise.all([
    healingQueue.clean(0, 10000, "completed"),
    healingQueue.clean(0, 10000, "failed"),
    runQueue.clean(0, 10000, "completed"),
    runQueue.clean(0, 10000, "failed"),
  ]);

  console.log("Queues drained, exiting.");
  process.exit(0);
}

main().catch((err) => {
  console.error("failed to drain queues", err);
  process.exit(1);
});
