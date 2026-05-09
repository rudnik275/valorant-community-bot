import { type MiddlewareFn, type Context } from 'grammy';
import logger from '../lib/log.ts';
import { isAllowedChat } from '../lib/scope.ts';

export const scopeGuard: MiddlewareFn<Context> = async (ctx, next) => {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  // Private chats are always allowed (users can DM the bot for onboarding)
  if (chatType === 'private') {
    return next();
  }

  // Handle my_chat_member updates: bot was added to a chat
  const myChatMember = ctx.update.my_chat_member;
  if (myChatMember && chatId !== undefined) {
    const newStatus = myChatMember.new_chat_member.status;
    const newUserId = myChatMember.new_chat_member.user.id;
    const botId = ctx.me.id;

    if (
      newUserId === botId &&
      (newStatus === 'member' || newStatus === 'administrator') &&
      !isAllowedChat(chatId)
    ) {
      logger.warn(
        {
          event: 'unauthorized_invite_left',
          chat_id: chatId,
          chat_title: ctx.chat?.title,
        },
        'Bot was added to unauthorized chat — leaving',
      );
      await ctx.api.leaveChat(chatId);
      return;
    }
  }

  // For all other non-private updates, check allowlist
  if (chatId !== undefined && !isAllowedChat(chatId)) {
    logger.warn(
      {
        event: 'unauthorized_chat',
        chat_id: chatId,
        chat_title: (ctx.chat as { title?: string } | undefined)?.title,
        from_user_id: ctx.from?.id,
      },
      'Update from unauthorized chat — dropping',
    );
    return;
  }

  return next();
};
