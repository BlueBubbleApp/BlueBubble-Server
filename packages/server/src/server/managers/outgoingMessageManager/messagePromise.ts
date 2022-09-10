import { Server } from "@server";
import { Chat } from "@server/databases/imessage/entity/Chat";
import { Message } from "@server/databases/imessage/entity/Message";
import { getFilenameWithoutExtension, isNotEmpty, onlyAlphaNumeric } from "@server/helpers/utils";

export class MessagePromiseRejection extends Error {
    error: string;

    msg: Message | null;

    tempGuid: string | null;

    constructor(error: string, message?: Message, tempGuid?: string) {
        super(error);
        this.name = this.constructor.name;
        this.msg = message;
        this.tempGuid = tempGuid;
        Error.captureStackTrace(this, this.constructor);
    }
}

export class MessagePromise {
    promise: Promise<Message>;

    private resolvePromise: (value: Message | PromiseLike<Message>) => void;

    private rejectPromise: (reason?: MessagePromiseRejection) => void;

    text: string;

    subject: string;

    chatGuid: string;

    sentAt: number;

    isResolved = false;

    errored = false;

    error: any;

    isAttachment: boolean;

    private tempGuid?: string | null;

    constructor({ chatGuid, text, isAttachment, sentAt, subject, tempGuid }: MessagePromiseConstructorParameters) {
        // Used to temporarily update the guid
        this.tempGuid = tempGuid;

        // Create a promise and save the "callbacks"
        this.promise = new Promise((resolve, reject) => {
            this.resolvePromise = resolve;
            this.rejectPromise = reject;
        });

        // Hook into the resolve and rejects so we can set flags based on the status
        this.promise.catch((err: any) => {
            this.errored = true;
            this.error = err;
        });

        this.chatGuid = chatGuid;
        this.text = isAttachment ? getFilenameWithoutExtension(text) : onlyAlphaNumeric(text ?? "");
        this.subject = onlyAlphaNumeric(subject ?? "");
        this.isAttachment = isAttachment;

        // Subtract 10 seconds to account for any "delay" in the sending process (somehow)
        this.sentAt = typeof sentAt === "number" ? sentAt : sentAt.getTime();

        // Create a timeout for how long until we "error-out".
        // Timeouts should change based on if it's an attachment or message
        // 3 minute timeout for attachments
        // 30 second timeout for messages
        setTimeout(
            () => {
                if (this.isResolved) return;

                // This will trigger our hook handlers, created in the constructor
                this.reject("Message send timeout");
            },
            this.isAttachment ? 60000 * 3 : 30000
        );
    }

    async resolve(value: Message) {
        this.isResolved = true;
        this.resolvePromise(value);
        await this.emitMessageMatch(value);
    }

    async reject(reason?: string, message: Message = null) {
        this.isResolved = true;
        this.rejectPromise(new MessagePromiseRejection(reason, message, this.tempGuid));
        if (message) {
            await this.emitMessageError(message);
        }
    }

    async emitMessageMatch(sentMessage: Message) {
        // If we have a sent message and we have a tempGuid, we need to emit the message match event
        if (sentMessage && isNotEmpty(this.tempGuid)) {
            Server().httpService.sendCache.remove(this.tempGuid);
            await Server().emitMessageMatch(sentMessage, this.tempGuid);
        }
    }

    async emitMessageError(sentMessage: Message) {
        // If we have a sent message and we have a tempGuid, we need to emit the message match event
        if (sentMessage) {
            if (this.tempGuid) {
                Server().httpService.sendCache.remove(this.tempGuid);
            }

            await Server().emitMessageError(sentMessage, this.tempGuid);
        }
    }

    isSame(message: Message) {
        // If we have chats, we need to make sure this promise is for that chat
        // We use endsWith to support when the chatGuid is just an address
        if (isNotEmpty(message.chats) && !message.chats.some((c: Chat) => c.guid.endsWith(this.chatGuid))) {
            return false;
        }

        // If this is an attachment, we need to match it slightly differently
        if (this.isAttachment) {
            // If this was supposed to be an attachment, but there are no attachments, there's no match
            if ((message.attachments ?? []).length === 0) return false;

            // Iterate over the attachments and check if any of the transfer names match the one we are awaiting on
            for (const a of message.attachments) {
                // If the transfer names match, congratz we have a match.
                // We don't need to get the filename from the text because we've already
                // done that in the constructor.
                if (getFilenameWithoutExtension(a.transferName) === this.text) return true;
            }

            // If we have no attachment matches, they're not the same
            return false;
        }

        // Check if the subject matches
        const cmpSubject = isNotEmpty(this.subject) && isNotEmpty(message.subject);
        if (cmpSubject && this.subject !== onlyAlphaNumeric(message.subject)) return false;

        // Check if the text matches
        return this.text === onlyAlphaNumeric(message.text) && this.sentAt <= message.dateCreated.getTime();
    }
}

interface MessagePromiseConstructorParameters {
    chatGuid: string;
    text: string;
    isAttachment: boolean;
    sentAt: Date | number;
    subject?: string;
    tempGuid?: string;
}
