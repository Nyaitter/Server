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
  const snapshot = await getUserReactions(db,userId);
  if (!snapshot || !Array.isArray(payload?.posts)) return payload;
  const copied = new WeakMap();
  const decorate = post => {
    if (!post || typeof post !== 'object') return post;
    if (copied.has(post)) return copied.get(post);
    const value = {...post,liked_by_me:snapshot.like.has(Number(post.id)),starred_by_me:snapshot.star.has(Number(post.id))};
    copied.set(post,value);
    for (const key of ['reply_to_post','reposted_post']) {
      if (post[key]) value[key] = decorate(post[key]);
    }
    return value;
  };
  return {...payload,posts:payload.posts.map(decorate)};
}
module.exports = {getUserReactions,updateUserReaction,applyUserReactionsToPayload,invalidateUserReactions};
