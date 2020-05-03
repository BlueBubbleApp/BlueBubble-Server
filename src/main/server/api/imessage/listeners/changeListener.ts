import { EventEmitter } from "events";

export abstract class ChangeListener extends EventEmitter {
    stopped: boolean;

    emittedItems: string[];

    lastCheck: Date;

    lastPurge: Date;

    pollFrequency: number;

    constructor(pollFrequency = 1000) {
        super();

        this.stopped = false;
        this.pollFrequency = pollFrequency;
        this.lastCheck = new Date();
        this.lastPurge = new Date();
    }

    stop() {
        this.stopped = true;
    }

    purgeCache() {
        const now = new Date();

        // Purge emitted messages every 30 minutes to save memory (or every 100 items)
        if (this.emittedItems.length > 100 || now.getTime() - this.lastPurge.getTime() > 1800000) {
            if (this.emittedItems.length > 0) {
                console.info(
                    `Purging ${this.emittedItems.length} emitted messages from cahche...`
                );
                this.emittedItems = [];
            }

            this.lastPurge = new Date();
        }
    }

    start() {
        this.emittedItems = [];
        this.lastCheck = new Date();
        this.lastPurge = new Date();

        // Start checking
        this.checkForNewEntries();
    }

    async checkForNewEntries(): Promise<void> {
        if (this.stopped) return;

        // Store the date when we started checking
        const beforeCheck = new Date();

        // Check the cache and see if it needs to be purged
        this.purgeCache();

        try {
            // We pass the last check because we don't want it to change
            // while we process asynchronously
            this.getEntries(this.lastCheck);

            // Save the date for when we started checking
            this.lastCheck = beforeCheck;
        } catch (err) {
            this.stopped = true;
            super.emit("error", err);
        }

        // Re-run check emssages code
        setTimeout(() => this.checkForNewEntries(), this.pollFrequency);
    }

    abstract async getEntries(after: Date): Promise<void>;

    abstract transformEntry(entry: any): any;
}
