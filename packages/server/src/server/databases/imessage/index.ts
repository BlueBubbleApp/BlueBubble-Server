/* eslint-disable no-param-reassign */
import { DataSource } from "typeorm";

import { DBMessageParams, ChatParams, HandleParams } from "@server/databases/imessage/types";
import { convertDateTo2001Time } from "@server/databases/imessage/helpers/dateUtil";
import { Chat } from "@server/databases/imessage/entity/Chat";
import { Handle } from "@server/databases/imessage/entity/Handle";
import { Message } from "@server/databases/imessage/entity/Message";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { isMinHighSierra, isNotEmpty } from "@server/helpers/utils";
import { isEmpty } from "@firebase/util";

/**
 * A repository class to facilitate pulling information from the iMessage database
 */
export class MessageRepository {
    db: DataSource = null;

    constructor() {
        this.db = null;
    }

    /**
     * Creates a connection to the iMessage database
     */
    async initialize() {
        this.db = new DataSource({
            name: "iMessage",
            type: "better-sqlite3",
            database: `${process.env.HOME}/Library/Messages/chat.db`,
            entities: [Chat, Handle, Message, Attachment]
        });

        this.db = await this.db.initialize();
        return this.db;
    }

    /**
     * Get all the chats from the DB
     *
     * @param identifier A specific chat identifier to get
     * @param withParticipants Whether to include the participants or not
     */
    async getChats({
        chatGuid = null,
        withParticipants = true,
        withArchived = true,
        withLastMessage = false,
        offset = 0,
        limit = null
    }: ChatParams = {}) {
        const query = this.db.getRepository(Chat).createQueryBuilder("chat");

        // Inner-join because a chat must have participants
        if (withParticipants) {
            query.leftJoinAndSelect("chat.participants", "handle");
        }

        // Add inner join with messages if we want the last message too
        if (withLastMessage) {
            query.leftJoinAndSelect("chat.messages", "message");
        }

        if (!withArchived) query.andWhere("chat.is_archived == 0");
        if (chatGuid) query.andWhere("chat.guid = :guid", { guid: chatGuid });

        // Add clause to fetch with last message
        if (withLastMessage) {
            query.groupBy("chat.guid");
            query.having("message.ROWID = MAX(message.ROWID)");
            query.orderBy("message.ROWID", "DESC");
        }

        // Set page params
        query.offset(offset);
        if (limit) query.limit(limit);

        // Get results
        const chats = await query.getMany();
        return chats;
    }

    async getChatLastMessage(chatGuid: string): Promise<Message> {
        const query = this.db.getRepository(Message).createQueryBuilder("message");
        query.innerJoinAndSelect("message.chats", "chat");
        query.andWhere("chat.guid = :guid", { guid: chatGuid });
        query.orderBy("date", "DESC");
        query.limit(1);

        // Get results
        const message = await query.getOne();
        return message;
    }

    /**
     * Get participants of a chat, in order of being added.
     * This is a weird method because of the way SQLite will auto-sort
     *
     * @param identifier A specific chat identifier to get
     */
    async getParticipantOrder(chatROWID: number) {
        const query = await this.db.query("SELECT * FROM chat_handle_join");

        // We have to do manual filtering in order to maintain the order
        // SQLite will auto-sort results if there is no Primary Key (which there isn't)
        return query.filter((item: { chat_id: number; handle_id: number }) => item.chat_id === chatROWID);
    }

    /**
     * Get an attachment from the DB
     *
     * @param attachmentGuid A specific attachment identifier to get
     * @param withMessages Whether to include the participants or not
     */
    async getAttachment(attachmentGuid: string, withMessages = false) {
        const query = this.db.getRepository(Attachment).createQueryBuilder("attachment");

        if (withMessages) query.leftJoinAndSelect("attachment.messages", "message");

        // Attachment GUIDs may start with a prefix such as p:/ or `at_x_`. For lookups,
        // all we need is the actual GUID, which is the last 36 digits.
        // Original GUIDs can also be prefixed with at_x_ or p:/.
        if (attachmentGuid.length >= 36) {
            attachmentGuid = attachmentGuid.substring(attachmentGuid.length - 36);
        }

        // El Capitan does not have an original_guid column.
        if (isMinHighSierra) {
            query.where("attachment.original_guid LIKE :guid", { guid: `%${attachmentGuid}` });
            query.orWhere("attachment.guid LIKE :guid", { guid: `%${attachmentGuid}` });
        } else {
            query.where("attachment.guid LIKE :guid", { guid: `%${attachmentGuid}` });
        }

        const attachment = await query.getOne();
        return attachment;
    }

    /**
     * Get an attachment from the DB
     *
     * @param guid A specific message identifier to get
     * @param withMessages Whether to include the participants or not
     */
    async getMessage(guid: string, withChats = true, withAttachments = false) {
        const query = this.db.getRepository(Message).createQueryBuilder("message");
        query.leftJoinAndSelect("message.handle", "handle");

        if (withChats) query.leftJoinAndSelect("message.chats", "chat");

        if (withAttachments)
            query.leftJoinAndSelect(
                "message.attachments",
                "attachment",
                "message.ROWID = message_attachment.message_id AND " +
                    "attachment.ROWID = message_attachment.attachment_id"
            );

        query.andWhere("message.guid = :guid", { guid });

        const message = await query.getOne();
        return message;
    }

    /**
     * Get all the handles from the DB
     *
     * @param handle Get a specific handle from the DB
     */
    async getHandles({ address = null, limit = 1000, offset = 0 }: HandleParams) {
        // Start a query
        const query = this.db.getRepository(Handle).createQueryBuilder("handle");

        // Add a handle query
        if (address) {
            query.where("handle.id LIKE :address", { address: `%${address.replace("+", "")}` });
        }

        // Add pagination params
        query.offset(offset);
        query.limit(limit);

        const handles = await query.getMany();
        return handles;
    }

    /**
     * Gets all messages associated with a chat
     *
     * @param chat The chat to get the messages from
     * @param offset The offset to start getting the messages from
     * @param limit The max number of messages to return
     * @param after The earliest date to get messages from
     * @param before The latest date to get messages from
     */
    async getMessages({
        chatGuid = null,
        offset = 0,
        limit = 100,
        after = null,
        before = null,
        withChats = false,
        withChatParticipants = false,
        withAttachments = true,
        withHandle = true,
        sort = "DESC",
        where = []
    }: DBMessageParams) {
        // Sanitize some params
        if (after && typeof after === "number") after = new Date(after);
        if (before && typeof before === "number") before = new Date(before);

        // Get messages with sender and the chat it's from
        const query = this.db.getRepository(Message).createQueryBuilder("message");

        if (withHandle) query.leftJoinAndSelect("message.handle", "handle");

        if (withAttachments)
            query.leftJoinAndSelect(
                "message.attachments",
                "attachment",
                "message.ROWID = message_attachment.message_id AND " +
                    "attachment.ROWID = message_attachment.attachment_id"
            );

        // Inner-join because all messages will have a chat
        if (chatGuid) {
            query
                .innerJoinAndSelect(
                    "message.chats",
                    "chat",
                    "message.ROWID = message_chat.message_id AND chat.ROWID = message_chat.chat_id"
                )
                .andWhere("chat.guid = :guid", { guid: chatGuid });
        } else if (withChats) {
            query.innerJoinAndSelect(
                "message.chats",
                "chat",
                "message.ROWID = message_chat.message_id AND chat.ROWID = message_chat.chat_id"
            );
        }

        if (withChatParticipants) {
            query.innerJoinAndSelect("chat.participants", "chandle");
        }

        // Add date restraints
        if (after)
            query.andWhere("message.date >= :after", {
                after: convertDateTo2001Time(after as Date)
            });
        if (before)
            query.andWhere("message.date < :before", {
                before: convertDateTo2001Time(before as Date)
            });

        if (isNotEmpty(where)) {
            for (const item of where) {
                query.andWhere(item.statement, item.args);
            }
        }

        // Add pagination params
        query.orderBy("message.date", sort);
        query.offset(offset);
        query.limit(limit);

        const messages = await query.getMany();
        return messages;
    }

    /**
     * Gets all messages that have been updated
     *
     * @param chat The chat to get the messages from
     * @param offset The offset to start getting the messages from
     * @param limit The max number of messages to return
     * @param after The earliest date to get messages from
     * @param before The latest date to get messages from
     */
    async getUpdatedMessages({
        chatGuid = null,
        offset = 0,
        limit = 100,
        after = null,
        before = null,
        withChats = false,
        withAttachments = true,
        sort = "DESC",
        where = []
    }: DBMessageParams) {
        // Sanitize some params
        if (after && typeof after === "number") after = new Date(after);
        if (before && typeof before === "number") before = new Date(before);

        // Get messages with sender and the chat it's from
        const query = this.db
            .getRepository(Message)
            .createQueryBuilder("message")
            .leftJoinAndSelect("message.handle", "handle");

        if (withAttachments)
            query.leftJoinAndSelect(
                "message.attachments",
                "attachment",
                "message.ROWID = message_attachment.message_id AND " +
                    "attachment.ROWID = message_attachment.attachment_id"
            );

        // Inner-join because all messages will have a chat
        if (chatGuid) {
            query
                .innerJoinAndSelect(
                    "message.chats",
                    "chat",
                    "message.ROWID == message_chat.message_id AND chat.ROWID == message_chat.chat_id"
                )
                .andWhere("chat.guid = :guid", { guid: chatGuid });
        } else if (withChats) {
            query.innerJoinAndSelect(
                "message.chats",
                "chat",
                "message.ROWID == message_chat.message_id AND chat.ROWID == message_chat.chat_id"
            );
        }

        // Add any custom WHERE clauses
        if (isNotEmpty(where)) for (const item of where) query.andWhere(item.statement, item.args);

        // Add date_delivered constraints
        if (after)
            query.andWhere("message.date_delivered >= :after", {
                after: convertDateTo2001Time(after as Date)
            });
        if (before)
            query.andWhere("message.date_delivered < :before", {
                before: convertDateTo2001Time(before as Date)
            });

        // Add date_read constraints
        if (after)
            query.orWhere("message.date_read >= :after", {
                after: convertDateTo2001Time(after as Date)
            });
        if (before)
            query.andWhere("message.date_read < :before", {
                before: convertDateTo2001Time(before as Date)
            });

        // Add any custom WHERE clauses
        // We have to do this here so that it matches both before the OR and after the OR
        if (isNotEmpty(where)) for (const item of where) query.andWhere(item.statement, item.args);

        // Add pagination params
        query.orderBy("message.date", sort);
        query.offset(offset);
        query.limit(limit);

        const messages = await query.getMany();
        return messages;
    }

    /**
     * Gets message counts associated with a chat
     *
     * @param after The earliest date to get messages from
     * @param before The latest date to get messages from
     */
    async getMessageCount(after?: Date, before?: Date, isFromMe = false, chatGuid: string = null, updated = false) {
        // Get messages with sender and the chat it's from
        const query = this.db.getRepository(Message).createQueryBuilder("message");

        // Add chatGuid (if applicable)
        if (isNotEmpty(chatGuid)) {
            query
                .innerJoinAndSelect(
                    "message.chats",
                    "chat",
                    "message.ROWID == message_chat.message_id AND chat.ROWID == message_chat.chat_id"
                )
                .andWhere("chat.guid = :guid", { guid: chatGuid });
        }

        if (isFromMe) query.andWhere("message.is_from_me = 1");

        // Add date restraints
        if (updated) {
            if (after)
                query.andWhere("message.date_delivered >= :after", {
                    after: convertDateTo2001Time(after as Date)
                });
            if (before)
                query.andWhere("message.date_delivered < :before", {
                    before: convertDateTo2001Time(before as Date)
                });

            // Add date_read constraints
            if (after)
                query.orWhere("message.date_read >= :after", {
                    after: convertDateTo2001Time(after as Date)
                });
            if (before)
                query.andWhere("message.date_read < :before", {
                    before: convertDateTo2001Time(before as Date)
                });
        } else {
            if (after)
                query.andWhere("message.date >= :after", {
                    after: convertDateTo2001Time(after)
                });
            if (before)
                query.andWhere("message.date < :before", {
                    before: convertDateTo2001Time(before)
                });
        }

        // Add pagination params
        query.orderBy("message.date", "DESC");

        const count = await query.getCount();
        return count;
    }

    /**
     * Count messages associated with different chats
     *
     * @param chatStyle Whether you are fetching the count for a group or individual chat
     */
    async getChatMessageCounts(chatStyle: "group" | "individual") {
        // Get messages with sender and the chat it's from
        const result = await this.db.getRepository(Chat).query(
            `SELECT
                chat.guid AS chat_guid,
                chat.display_name AS group_name,
                COUNT(message.ROWID) AS message_count
            FROM chat
            JOIN chat_message_join AS cmj ON chat.ROWID = cmj.chat_id
            JOIN message ON message.ROWID = cmj.message_id
            WHERE chat.style = ?
            GROUP BY chat.guid;`,
            [chatStyle === "group" ? 43 : 45]
        );

        return result;
    }

    /**
     * Count messages associated with different chats
     *
     * @param chatStyle Whether you are fetching the count for a group or individual chat
     */
    async getMediaCountsByChat({
        mediaType = "image"
    }: {
        mediaType?: "image" | "video" | "location" | "other";
    } = {}) {
        // Get messages with sender and the chat it's from
        const result = await this.db.getRepository(Chat).query(
            `SELECT
                chat.guid AS chat_guid,
                chat.display_name AS group_name,
                COUNT(attachment.ROWID) AS media_count
            FROM chat
            JOIN chat_message_join AS cmj ON chat.ROWID = cmj.chat_id
            JOIN message ON message.ROWID = cmj.message_id
            JOIN message_attachment_join AS maj ON message.ROWID = maj.message_id
            JOIN attachment ON attachment.ROWID = maj.attachment_id
            WHERE attachment.mime_type LIKE '${mediaType}%'
            GROUP BY chat.guid;`
        );

        return result;
    }

    async getMediaCounts({
        mediaType = "image"
    }: {
        mediaType?: "image" | "video" | "location";
    } = {}) {
        let mType: string = mediaType;
        if (mType === "location") {
            mType = "text/x-vlocation";
        }

        // Get messages with sender and the chat it's from
        const result = await this.db.getRepository(Chat).query(
            `SELECT COUNT(attachment.ROWID) AS media_count
            FROM attachment
            WHERE attachment.mime_type LIKE '${mType}%';`
        );

        return result;
    }

    async getGroupIconPath(chatGuid: string) {
        if (!chatGuid.includes(";+;")) {
            throw new Error("Chat must be a group chat to change the icon!");
        }

        // Get messages with sender and the chat it's from
        // Credits: Ian Welker (Creator of SMServer)
        const result = await this.db.getRepository(Chat).query(
            `SELECT
                ROWID,
                filename
            FROM attachment
            WHERE ROWID IN (
                SELECT attachment_id FROM message_attachment_join
                WHERE message_id in (
                    SELECT ROWID FROM message
                    WHERE group_action_type is 1 AND cache_has_attachments IS 1 AND ROWID in (
                        SELECT message_id FROM chat_message_join WHERE chat_id in (
                            SELECT ROWID FROM chat
                            WHERE guid is '${chatGuid}'
                        )
                    )
                    ORDER BY date DESC
                )
            );`
        );

        return isEmpty(result) ? null : result[0].filename;
    }

    /**
     * Gets message counts associated with a chat
     *
     * @param after The earliest date to get messages from
     * @param before The latest date to get messages from
     */
    async getAttachmentCount() {
        // Get messages with sender and the chat it's from
        const query = this.db.getRepository(Attachment).createQueryBuilder("attachment");
        const count = await query.getCount();
        return count;
    }

    async getChatCount() {
        // Get messages with sender and the chat it's from
        const query = this.db.getRepository(Chat).createQueryBuilder("chat");
        const count = await query.getCount();
        return count;
    }

    async getHandleCount() {
        // Get messages with sender and the chat it's from
        const query = this.db.getRepository(Handle).createQueryBuilder("handle");
        const count = await query.getCount();
        return count;
    }
}
