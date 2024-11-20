import fs from "fs";
import { MultiFileWatcher } from "@server/lib/MultiFileWatcher";
import type { FileChangeEvent } from "@server/lib/MultiFileWatcher";
import { Loggable } from "@server/lib/logging/Loggable";
import { Sema } from "async-sema";
import { IMessageCache, IMessagePoller } from "../pollers";
import { MessageRepository } from "..";
import { waitMs } from "@server/helpers/utils";
import { DebounceSubsequentWithWait } from "@server/lib/decorators/DebounceDecorator";

export class IMessageListener extends Loggable {
    tag = "IMessageListener";

    stopped = false;

    filePaths: string[];

    watcher: MultiFileWatcher;

    repo: MessageRepository;

    processLock: Sema;

    pollers: IMessagePoller[];

    cache: IMessageCache;

    lastCheck = 0;

    baseInterval = 500; // Base polling interval in milliseconds
    maxInterval = 5000; // Maximum polling interval
    minInterval = 100; // Minimum polling interval
    overlapFactor = 1.5; // Adjust for potential time drift and delays
    maxRetryAttempts = 3; // Maximum number of retry attempts
    initialRetryDelay = 1000; // Initial retry delay in milliseconds

    private currentPollPromise: Promise<void> | null = null;

    constructor({ filePaths, repo, cache }: { filePaths: string[]; repo: MessageRepository; cache: IMessageCache }) {
        super();

        this.filePaths = filePaths;
        this.repo = repo;
        this.pollers = [];
        this.cache = cache;
        this.processLock = new Sema(1);
    }

    stop() {
        this.stopped = true;
        this.removeAllListeners();
        if (this.watcher) {
            this.watcher.stop();
        }
    }

    addPoller(poller: IMessagePoller) {
        this.pollers.push(poller);
    }

    getEarliestModifiedDate() {
        let earliest = new Date();
        for (const filePath of this.filePaths) {
            const stat = fs.statSync(filePath);
            if (stat.mtime < earliest) {
                earliest = stat.mtime;
            }
        }
        return earliest;
    }

    async start() {
        this.lastCheck = this.getEarliestModifiedDate().getTime() - 60000;
        this.stopped = false;

        await this.poll(new Date(this.lastCheck), false);

        this.watcher = new MultiFileWatcher(this.filePaths);
        this.watcher.on("change", async (event: FileChangeEvent) => {
            if (!this.stopped) {
                await this.handleChangeEvent(event);
            }
        });

        this.watcher.on("error", (error) => {
            this.log.error(`Failed to watch database files: ${this.filePaths.join(", ")}`);
            this.log.debug(`Error: ${error}`);
        });

        this.watcher.start();
    }

    @DebounceSubsequentWithWait('IMessageListener.handleChangeEvent', 500)
    async handleChangeEvent(event: FileChangeEvent) {
        if (this.currentPollPromise) {
            this.log.debug("Skipping change event; poll already in progress.");
            return;
        }

        this.currentPollPromise = this.processLock.acquire().then(async () => {
            try {
                const now = Date.now();
                let prevTime = this.lastCheck;

                if (prevTime <= 0 || prevTime > now) {
                    this.log.debug(`Previous time is invalid (${prevTime}), setting to now...`);
                    prevTime = now;
                } else if (now - prevTime > 86400000) {
                    this.log.debug(`Previous time is > 24 hours ago, setting to 24 hours ago...`);
                    prevTime = now - 86400000;
                }

                const { interval, overlap } = this.calculateDynamicIntervalAndOverlap(prevTime);

                let afterTime = prevTime - overlap;
                if (afterTime > now) {
                    afterTime = now;
                }

                await this.poll(new Date(afterTime));
                this.lastCheck = Date.now();
                this.cache.trimCaches();

            } catch (error) {
                this.log.error(`Error handling change event: ${error}`);
            } finally {
                this.processLock.release();
                this.currentPollPromise = null;
            }
        });

        await this.currentPollPromise;
    }

    async poll(after: Date, emitResults = true) {
      let retryCount = 0;
      let retryDelay = this.initialRetryDelay;

      while (retryCount <= this.maxRetryAttempts) {
        try {
          const batchedResults = [];
          for (const poller of this.pollers) {
            const results = await poller.poll(after);
            batchedResults.push(...results);
          }

          if (emitResults) {
            this.emitBatchedResults(batchedResults);
          }

          this.log.info(`Successfully polled ${batchedResults.length} events since ${after}`);
          break; // Exit retry loop on success
        } catch (error) {
          this.log.error(`Error during polling (attempt ${retryCount + 1}): ${error}`);

          if (retryCount < this.maxRetryAttempts) {
            retryCount++;
            retryDelay *= 2;
            this.log.warn(`Retrying in ${retryDelay}ms...`);
            await waitMs(retryDelay);
          } else {
            this.log.error(`Max retry attempts reached. Giving up.`);
            throw error; // Re-throw the error after retries
          }
        }
      }
    }

    emitBatchedResults(results: { eventType: string; data: any }[]) {
        const eventsByType = new Map<string, any[]>();
        for (const result of results) {
            if (!eventsByType.has(result.eventType)) {
                eventsByType.set(result.eventType, []);
            }
            eventsByType.get(result.eventType)?.push(result.data);
        }

        for (const [eventType, dataArray] of eventsByType) {
            this.emit(eventType, dataArray);
        }
    }

    calculateDynamicIntervalAndOverlap(prevTime: number) {
        let interval = this.baseInterval;
        const timeSinceLastCheck = Date.now() - prevTime;

        if (timeSinceLastCheck > this.maxInterval) {
            interval = this.maxInterval;
        } else if (timeSinceLastCheck < this.minInterval) {
            interval = this.minInterval;
        } else {
            interval = Math.min(this.maxInterval, Math.max(this.minInterval, timeSinceLastCheck));
        }

        const overlap = interval * this.overlapFactor;
        return { interval, overlap };
    }
}