const { getValidRememberedAccounts } = require('./RememberedAccountService');
const { canOperateImposter } = require('../ImposterService');

function normalizeUserId(value) {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function postAsAuthorizationError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * 現在のログインセッションを切り替えず、同じブラウザで認証済みのアカウント、
 * またはそのアカウントが操作できるインポスターを投稿先として返す。
 */
async function resolvePostingUser(req, db, requestedUserId = null) {
  const currentUserId = normalizeUserId(req.user?.id);
  const requestedId = requestedUserId == null || requestedUserId === ''
    ? currentUserId
    : normalizeUserId(requestedUserId);
  if (!requestedId) {
    throw postAsAuthorizationError('投稿アカウントIDが正しくありません。', 400);
  }

  if (requestedId === currentUserId) {
    return req.user?.visibilityUser || (await db.getUserById(requestedId));
  }

  const rememberedAccounts = await getValidRememberedAccounts(req, db);
  const directAccount = rememberedAccounts.find((account) => account.userId === requestedId);
  if (directAccount) return directAccount.user;

  const imposter = await db.getUserById(requestedId);
  if (imposter && rememberedAccounts.some((account) => canOperateImposter(imposter, account.userId))) {
    return imposter;
  }

  throw postAsAuthorizationError('このブラウザで投稿を許可されたアカウントではありません。');
}

function assertPostingUserWritable(user) {
  if (!user) throw postAsAuthorizationError('投稿アカウントが見つかりません。', 404);
  if (user.freeze) throw postAsAuthorizationError('凍結中のアカウントでは投稿できません。');
  if (user.account_operation) {
    throw postAsAuthorizationError('NyaitterIDの処理中です。完了するまで投稿できません。', 423);
  }
  return user;
}

module.exports = {
  resolvePostingUser,
  assertPostingUserWritable,
};
