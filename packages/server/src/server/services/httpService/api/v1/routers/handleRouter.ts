import { RouterContext } from "koa-router";
import { Next } from "koa";

import { Server } from "@server";
import { getHandleResponse } from "@server/databases/imessage/entity/Handle";
import { HandleInterface } from "@server/api/v1/interfaces/handleInterface";
import { isEmpty } from "@server/helpers/utils";
import { arrayHasOne } from "@server/utils/CollectionUtils";
import { Success } from "../responses/success";
import { NotFound } from "../responses/errors";
import { parseWithQuery } from "../utils";

export class HandleRouter {
    static async count(ctx: RouterContext, _: Next) {
        const total = await Server().iMessageRepo.getHandleCount();
        return new Success(ctx, { data: { total } }).send();
    }

    static async find(ctx: RouterContext, _: Next) {
        const address = ctx.params.guid;
        const handles = await Server().iMessageRepo.getHandles({ address });
        if (isEmpty(handles)) throw new NotFound({ error: "Handle not found!" });
        return new Success(ctx, { data: await getHandleResponse(handles[0]) }).send();
    }

    static async query(ctx: RouterContext, _: Next) {
        const { body } = ctx.request;

        // Pull out the filters
        const withQuery = parseWithQuery(body?.with);
        const withChats = arrayHasOne(withQuery, ['chat', 'chats']);
        const withChatParticipants = arrayHasOne(withQuery, ["chat.participants", "chats.participants"]);
        const address = body?.address;

        // Pull the pagination params and make sure they are correct
        const offset = Number.parseInt(body?.offset, 10);
        const limit = Number.parseInt(body?.limit ?? 100, 10);

        // Build metadata to return
        const metadata = {
            total: await Server().iMessageRepo.getHandleCount(),
            offset,
            limit
        };

        // Get the hanle
        const results = await HandleInterface.get({
            address,
            withChats,
            withChatParticipants,
            limit,
            offset
        });

        return new Success(ctx, { data: results, metadata }).send();
    }
}
