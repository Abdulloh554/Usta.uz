import { z } from 'zod';
import { objectIdSchema, paginationSchema } from '../../common/middlewares/validate.middleware';
import { MessageKind } from './chat.model';

export const chatIdParamSchema = z.object({ id: objectIdSchema });

export const orderIdParamSchema = z.object({ orderId: objectIdSchema });

export const listMessagesSchema = paginationSchema;

export const sendMessageSchema = z
  .object({
    text: z.string().trim().max(4000).optional(),
    kind: z.nativeEnum(MessageKind).default(MessageKind.TEXT),
    attachmentUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === MessageKind.TEXT && !value.text?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Message text cannot be empty',
      });
    }
    if (value.kind === MessageKind.IMAGE && !value.attachmentUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachmentUrl'],
        message: 'An image message needs an attachment',
      });
    }
  });

export type SendMessageBody = z.infer<typeof sendMessageSchema>;
