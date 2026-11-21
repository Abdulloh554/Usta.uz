import { asyncHandler, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as userService from './user.service';
import type {
  DeleteAccountInput,
  TopMastersQuery,
  UpdateMasterInput,
  UpdateProfileInput,
} from './user.validator';

export const topMasters = asyncHandler(async (req, res) => {
  const { limit, craft } = req.query as unknown as TopMastersQuery;
  ok(res, await userService.topMasters(limit, craft));
});

export const updateProfile = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await userService.updateProfile(req.user.id, req.body as UpdateProfileInput));
});

export const updateMasterProfile = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await userService.updateMasterProfile(req.user.id, req.body as UpdateMasterInput));
});

export const deleteAccount = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await userService.deleteAccount(req.user.id, req.body as DeleteAccountInput);
  ok(res, { deleted: true });
});

export const myHistory = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await userService.workHistory(req.user.id));
});

export const masterProfile = asyncHandler(async (req, res) => {
  ok(res, await userService.getMasterProfile(req.params.id as string));
});

export const masterHistory = asyncHandler(async (req, res) => {
  ok(res, await userService.workHistory(req.params.id as string));
});
