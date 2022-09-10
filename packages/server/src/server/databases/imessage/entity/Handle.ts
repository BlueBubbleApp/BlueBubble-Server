import { Entity, PrimaryGeneratedColumn, Column, OneToMany, JoinColumn, JoinTable, ManyToMany } from "typeorm";

import { Message } from "@server/databases/imessage/entity/Message";
import { Chat, getChatResponse } from "@server/databases/imessage/entity/Chat";
import { HandleResponse } from "@server/types";
import { MessageSerializer } from "@server/api/v1/serializers/MessageSerializer";

@Entity("handle")
export class Handle {
    @PrimaryGeneratedColumn({ name: "ROWID" })
    ROWID: number;

    @OneToMany(type => Message, message => message.handle)
    @JoinColumn({ name: "ROWID", referencedColumnName: "handle_id" })
    messages: Message[];

    @ManyToMany(type => Chat)
    @JoinTable({
        name: "chat_handle_join",
        joinColumns: [{ name: "handle_id" }],
        inverseJoinColumns: [{ name: "chat_id" }]
    })
    chats: Chat[];

    @Column({ type: "text", nullable: false })
    id: string;

    @Column({ type: "text", nullable: true })
    country: string;

    @Column({ type: "text", nullable: false, default: "iMessage" })
    service: string;

    @Column({ name: "uncanonicalized_id", type: "text", nullable: true })
    uncanonicalizedId: string;
}

export const getHandleResponse = async (tableData: Handle): Promise<HandleResponse> => {
    const messages = [];
    for (const msg of tableData?.messages ?? []) {
        // Since participants is the top level objet, we don't need to load them in
        const msgRes = await MessageSerializer.serialize({ message: msg, loadChatParticipants: false });
        messages.push(msgRes);
    }

    const chats = [];
    for (const chat of tableData?.chats ?? []) {
        const chatRes = await getChatResponse(chat);
        chats.push(chatRes);
    }

    return {
        originalROWID: tableData.ROWID,
        messages,
        chats,
        address: tableData.id,
        country: tableData.country,
        uncanonicalizedId: tableData.uncanonicalizedId
    };
};
