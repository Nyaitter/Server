'use strict';
const MemoryBoundedCache = require('./MemoryBoundedCache');
const config = require('../config');
const adapters = new WeakMap();
const states = new Set();
function stateFor(db) {
  let state = adapters.get(db);
  if (!state) {
    state = {users:new MemoryBoundedCache({maxSize:config.cache?.userCacheMaxSize || 2000,
      ttlMs:config.cache?.userCacheTtlMs || 60000,maxHeapMb:256}),pending:new Map()};
    adapters.set(db,state);
    states.add(new WeakRef(state));
  }
  return state;
}
function apply(snapshot,type,postId,enabled) {
  if (enabled) snapshot[type].add(postId);
  else snapshot[type].delete(postId);
}
async function getUserReactions(db,userId) {
  if (config.cache?.userCacheEnabled === false) return null;
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof db.getLikeIds !== 'function' || typeof db.getStarIds !== 'function') return null;
  const state = stateFor(db);
  const cached = state.users.get(id);
  if (cached) return cached;
  if (state.pending.has(id)) return state.pending.get(id).promise;
  const pending = {changes:new Map()};
  const load = async () => {
    try {
      const [like,star] = await Promise.all([db.getLikeIds(id),db.getStarIds(id)]);
      if (!Array.isArray(like) || !Array.isArray(star)) return null;
      if (pending.invalidated) return null;
      const snapshot = {like:new Set(like.map(Number)),star:new Set(star.map(Number))};
      for (const change of pending.changes.values()) apply(snapshot,change.type,change.postId,change.enabled);
      state.users.set(id,snapshot);
      return snapshot;
    } catch (_) {
      return null;
    } finally {state.pending.delete(id);}
  };
  pending.promise = Promise.resolve().then(load);
  state.pending.set(id,pending);
  return pending.promise;
}
function updateUserReaction(db,userId,postId,type,enabled) {
  if (config.cache?.userCacheEnabled === false) return;
  const id = Number(userId), post = Number(postId);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(post) || post <= 0 ||
      !['like','star'].includes(type)) return;
  const state = stateFor(db);
  const snapshot = state.users.get(id);
  if (snapshot) apply(snapshot,type,post,Boolean(enabled));
  // A read started before the committed toggle must not restore old flags.
  state.pending.get(id)?.changes.set(`${type}:${post}`,{type,postId:post,enabled:Boolean(enabled)});
}
function invalidateUserReactions(userId = null) {
  for (const reference of states) {
    const state = reference.deref();
    if (!state) {states.delete(reference);continue;}
    if (userId == null) {
      state.users.clear();
      for (const pending of state.pending.values()) pending.invalidated = true;
    } else {
      const id = Number(userId);
      state.users.delete(id);
      const pending = state.pending.get(id);
      if (pending) pending.invalidated = true;
    }
  }
}
async function applyUserReactionsToPayload(db,payload,userId) {
  if (!Array.isArray(payload?.posts)) return payload;
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return payload;

  // ページに含まれる投稿IDだけを対象に、ページ単位で本人リアクションを解決する。
  // ユーザーの全リアクション一覧(getUserReactions)は「いいね/スター総数」に
  // 比例して重くなるため、ページ単位で取得できない場合だけフォールバックする。
  const ids = new Set();
  const collect = post => {
    if (!post || typeof post !== 'object') return;
    const postId = Number(post.id);
    if (Number.isSafeInteger(postId) && postId > 0) ids.add(postId);
    if (post.reply_to_post) collect(post.reply_to_post);
    if (post.reposted_post) collect(post.reposted_post);
  };
  for (const post of payload.posts) collect(post);

  let likedSet = null;
  let starredSet = null;
  if (ids.size > 0 && typeof db?.getViewerPostReactions === 'function') {
    try {
      const rows = await db.getViewerPostReactions([...ids], id);
      likedSet = new Set();
      starredSet = new Set();
      for (const row of rows || []) {
        const postId = Number(row?.post_id);
        if (!Number.isSafeInteger(postId)) continue;
        if (row?.liked_by_me) likedSet.add(postId);
        if (row?.starred_by_me) starredSet.add(postId);
      }
    } catch (_) {
      likedSet = null;
      starredSet = null;
    }
  }
  if (!likedSet || !starredSet) {
    const snapshot = await getUserReactions(db,id);
    if (!snapshot) return payload;
    likedSet = snapshot.like;
    starredSet = snapshot.star;
  }

  const copied = new WeakMap();
  const decorate = post => {
    if (!post || typeof post !== 'object') return post;
    if (copied.has(post)) return copied.get(post);
    const postId = Number(post.id);
    const value = {...post,liked_by_me:likedSet.has(postId),starred_by_me:starredSet.has(postId)};
    copied.set(post,value);
    for (const key of ['reply_to_post','reposted_post']) {
      if (post[key]) value[key] = decorate(post[key]);
    }
    return value;
  };
  return {...payload,posts:payload.posts.map(decorate)};
}
module.exports = {getUserReactions,updateUserReaction,applyUserReactionsToPayload,invalidateUserReactions};
